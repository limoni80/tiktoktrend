import { config } from './config.mjs';
import { createContext, warmContext, sleep } from './browser.mjs';
import { ApiError } from './http.mjs';
import { collectEmbeddedItems, itemsFromListBody, normalizeTikTokItem, safeParse } from './normalize.mjs';

export const TIKTOK_LIST_PATTERN =
  /\/api\/(explore\/item_list|recommend\/item_list|search\/general\/full|search\/item\/full|search\/general\/preview|challenge\/item_list|post\/item_list|item\/detail|related\/item_list)\//;

// Live progress, polled by the frontend while a scrape runs.
export const progress = {
  active: false, phase: 'idle', collected: 0, matched: 0, target: 0, startedAt: null, keyword: null,
};
const setProgress = (patch) => Object.assign(progress, patch);

// Cookies captured from the warm-up context, kept IN MEMORY ONLY so the video
// proxy can stream play URLs. Nothing is written to disk.
let liveCookieHeader = config.tiktokCookie || '';
export const getCookieHeader = () => liveCookieHeader;

// One browser session at a time; concurrent Chromium launches on the same host
// are the usual cause of flaky scrapes.
let queue = Promise.resolve();
const serialize = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
};

let session = null;

async function closeSession() {
  const current = session;
  session = null;
  if (!current) return;
  clearTimeout(current.timer);
  try { await current.context.close(); } catch { /* already gone */ }
}
function touchSession() {
  if (!session) return;
  clearTimeout(session.timer);
  session.timer = setTimeout(() => { void closeSession(); }, config.sessionIdleMs);
}

const sessionKey = (mode, keyword) => `${mode}|${keyword.toLowerCase()}`;

async function openSession(mode, keyword) {
  await closeSession();
  const context = await createContext();
  const label = mode === 'search' ? `TikTok.com · search · “${keyword}”` : 'TikTok.com · Explore';
  const state = {
    key: sessionKey(mode, keyword), mode, keyword, context, page: null,
    collected: new Map(), returned: new Set(), exhausted: false, timer: null, label,
  };

  const add = (raw) => {
    const video = normalizeTikTokItem(raw, label);
    if (video && !state.collected.has(video.id)) state.collected.set(video.id, video);
  };

  // Warm up on the public homepage so TikTok issues ttwid / msToken cookies.
  // This replaces the persistent Chrome profile the local prototype relied on.
  const page = await warmContext(context);
  state.page = page;

  page.on('response', async (response) => {
    try { if (!TIKTOK_LIST_PATTERN.test(response.url())) return; } catch { return; }
    try { itemsFromListBody(safeParse(await response.text())).forEach(add); }
    catch { /* partial or non-JSON body */ }
  });

  const target = mode === 'search'
    ? `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`
    : 'https://www.tiktok.com/explore';
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 40_000 });
  } catch (error) {
    const detail = String(error?.message ?? '');
    await context.close().catch(() => {});
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_INTERNET_DISCONNECTED|ENOTFOUND/i.test(detail)) {
      throw new ApiError(502, 'tiktok_unreachable',
        'This server cannot reach www.tiktok.com. Deploy the backend on a host with unrestricted outbound internet access.');
    }
    throw new ApiError(504, 'tiktok_timeout', `TikTok did not load: ${detail.split('\n')[0]}`);
  }
  await page.waitForResponse((response) => TIKTOK_LIST_PATTERN.test(response.url()), { timeout: 15_000 }).catch(() => {});
  await sleep(600);
  await page.keyboard.press('Escape').catch(() => {});
  await Promise.allSettled(['[data-e2e="modal-close-inner-button"]', 'button[aria-label="Close"]']
    .map((selector) => page.locator(selector).first().click({ timeout: 250 })));

  const raw = await page.evaluate(() =>
    document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent
    ?? document.getElementById('SIGI_STATE')?.textContent ?? null).catch(() => null);
  if (raw) collectEmbeddedItems(raw).forEach(add);

  try {
    const cookies = await context.cookies('https://www.tiktok.com');
    if (cookies.length) liveCookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  } catch { /* proxy falls back to no cookies */ }

  state.add = add;
  session = state;
  touchSession();
  return state;
}

/**
 * One page of results. Call again with `fresh: false` to continue scrolling the
 * same live feed — that is what makes pagination unbounded and fast.
 */
export const fetchTikTokBatch = (options) => serialize(() => fetchBatchInner(options));

async function fetchBatchInner({ mode, keyword, want, dateRange, fresh, knownIds = [] }) {
  const rangeStart = dateRange?.from ? new Date(`${dateRange.from}T00:00:00Z`).getTime() : null;
  const rangeEnd = dateRange?.to ? new Date(`${dateRange.to}T23:59:59Z`).getTime() : null;
  const hasRange = rangeStart != null || rangeEnd != null;
  const tokens = keyword.toLowerCase().split(/\s+/).filter(Boolean);

  const matches = (video) => {
    if (tokens.length) {
      const haystack = `${video.caption} ${video.hashtags.join(' ')} ${video.creator.username ?? ''} ${video.creator.displayName} ${video.soundName ?? ''}`.toLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) return false;
    }
    if (!hasRange) return true;
    // Never invent a date: a video without publishedAt cannot satisfy a range.
    if (!video.publishedAt) return false;
    const time = new Date(video.publishedAt).getTime();
    return (rangeStart == null || time >= rangeStart) && (rangeEnd == null || time <= rangeEnd);
  };

  const key = sessionKey(mode, keyword);
  let state = session;
  if (fresh || !state || state.key !== key || state.page?.isClosed()) {
    state = await openSession(mode, keyword);
    // Continuing a feed the client restored from its own cache: treat the ids
    // it already holds as delivered so it only receives genuinely new videos.
    if (!fresh) knownIds.forEach((id) => state.returned.add(String(id)));
  }
  if (fresh) { state.returned.clear(); state.exhausted = false; }
  touchSession();

  const ready = () => [...state.collected.values()].filter((video) => matches(video) && !state.returned.has(video.id));

  setProgress({
    active: true, phase: 'Reading TikTok results…', collected: state.collected.size,
    matched: ready().length, target: want, startedAt: Date.now(), keyword: keyword || null,
  });

  const deadline = Date.now() + (hasRange ? 100_000 : 55_000);
  let stagnant = 0;
  let previous = state.collected.size;
  while (ready().length < want && stagnant < 8 && Date.now() < deadline) {
    await state.page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)).catch(() => {});
    await state.page.keyboard.press('End').catch(() => {});
    await state.page.waitForResponse((response) => TIKTOK_LIST_PATTERN.test(response.url()), { timeout: 3_500 }).catch(() => {});
    await sleep(280);
    stagnant = state.collected.size === previous ? stagnant + 1 : 0;
    previous = state.collected.size;
    setProgress({ collected: state.collected.size, matched: ready().length, phase: `Scanned ${state.collected.size} videos…` });
  }
  if (stagnant >= 8) state.exhausted = true;

  const batch = ready().slice(0, want);
  batch.forEach((video) => state.returned.add(video.id));
  setProgress({ active: false, phase: 'Done', collected: state.collected.size, matched: batch.length });

  if (fresh && !batch.length) {
    const bodyText = await state.page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => '');
    if (/verify|captcha|robot/i.test(bodyText)) {
      throw new ApiError(429, 'tiktok_captcha', 'TikTok served a verification page to this server. Retry shortly or set TIKTOK_COOKIE.');
    }
    throw new ApiError(502, 'tiktok_empty', keyword
      ? `TikTok returned no public videos for “${keyword}”.`
      : 'TikTok returned no public videos for the Explore feed.');
  }

  return { videos: batch, hasMore: !state.exhausted, scanned: state.collected.size };
}

export async function shutdownTikTok() {
  await closeSession();
}
