/**
 * Browser-free TikTok provider.
 *
 * WHY THIS EXISTS
 * ---------------
 * Cloudflare Browser Rendering on the free plan gives 3 concurrent browsers,
 * one new browser every 20 seconds and **10 minutes of browser time per day**.
 * That is a hard wall: no retry loop and no caching strategy can get past it,
 * because the quota is time-based, not request-based.
 *
 * So the fix is to stop needing a browser. Two things make that possible, and
 * both were already proven inside this repo:
 *
 *  1. `tiktok-profile-scraper-main/` (the Apify actor) fetches
 *     `https://www.tiktok.com/@user` with a **plain HTTP GET** and reads the
 *     whole payload out of the `__UNIVERSAL_DATA_FOR_REHYDRATION__` script tag
 *     in the returned HTML. No browser, no login. It then calls
 *     `/api/user/detail/` using only the cookies TikTok itself set on that
 *     first response.
 *  2. `tiktok-scraper-master/` (the 2020 CLI) shows the shape of the web API
 *     calls — `aid=1988`, `app_name=tiktok_web`, cursor pagination — but signs
 *     them with `_signature`, an algorithm TikTok retired. Its endpoints on
 *     `m.tiktok.com` are dead, so it is used here as a reference for the
 *     PARAMETERS, never as a live provider.
 *
 * Combining the two: bootstrap cookies from a normal page load, read the items
 * embedded in the HTML, then page further with the same `/api/.../item_list/`
 * endpoints the site itself calls, carrying those cookies. A Worker `fetch` is
 * free and unmetered by Browser Rendering, so this path has no browser quota
 * at all.
 *
 * HONESTY
 * -------
 * Every strategy reports what actually happened (status, bytes, item counts,
 * block detection). Nothing is invented, and a keyword match is only relaxed
 * for items TikTok itself returned from a keyword-targeted endpoint.
 *
 * No cookies of ours, no login, nothing persisted: the only cookies used are
 * the anonymous ones TikTok hands to any first-time visitor, cached in the
 * Worker's own cache for a few minutes.
 */
import { collectEmbeddedItems, itemsFromListBody, normalizeTikTokItem, safeParse } from '../backend/src/normalize.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** Headers a real Chrome sends for a top-level navigation. */
const PAGE_HEADERS = {
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  'sec-ch-ua': '"Chromium";v="140", "Google Chrome";v="140", "Not?A_Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};

const SESSION_CACHE_KEY = 'https://pulse-tiktok-session.internal/anonymous';
const SESSION_TTL_S = 900;
const PAGE_TIMEOUT_MS = 12_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const slugify = (value) => String(value).toLowerCase().trim().replace(/[^a-z0-9]+/g, '');

/**
 * What TikTok actually served.
 *
 * Measured from Cloudflare: TikTok answers 200 with a ~350 KB page whose
 * `__UNIVERSAL_DATA_FOR_REHYDRATION__` is present and large (~260 KB of app
 * config and translations) but carries **no content modules at all** — no
 * items, no challengeId, and the generic "TikTok - Make Your Day" title
 * instead of "#keyword …". That is the anti-bot shell, and it is the single
 * most important thing to name correctly: the earlier heuristic matched the
 * word "captcha" anywhere in that config blob and wrongly reported a captcha.
 */
const classifyPage = (html, { embedded, items }) => {
  if (/captcha-verify-page|captcha_verify_container|verify-bar-close|slide to verify/i.test(html)) return 'captcha';
  if (/<title>[^<]*(Access Denied|Forbidden)/i.test(html)) return 'denied';
  if (html.length < 2_000) return 'short-body';
  if (embedded && items === 0) return 'shell-no-content';
  return null;
};

const readSetCookies = (response) => {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
};

const mergeCookies = (jar, entries) => {
  for (const entry of entries) {
    const pair = String(entry).split(';', 1)[0];
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
};

const cookieHeader = (jar) => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
]);

/**
 * Anonymous cookies (ttwid / msToken) from a normal page load, cached briefly
 * so most requests do not need the extra round trip.
 */
async function loadSession(env, trace) {
  const cache = caches.default;
  const key = new Request(SESSION_CACHE_KEY);
  try {
    const hit = await cache.match(key);
    if (hit) {
      const stored = await hit.json();
      if (stored?.cookie && Date.now() - stored.at < SESSION_TTL_S * 1000) {
        trace?.push({ step: 'session', source: 'cache', ageSeconds: Math.round((Date.now() - stored.at) / 1000) });
        return { jar: new Map(Object.entries(stored.jar ?? {})), msToken: stored.msToken ?? '' };
      }
    }
  } catch { /* cache miss is fine */ }

  const jar = new Map();
  let status = 0;
  try {
    const response = await withTimeout(
      fetch('https://www.tiktok.com/', { headers: PAGE_HEADERS, redirect: 'follow' }),
      PAGE_TIMEOUT_MS,
      'session bootstrap',
    );
    status = response.status;
    mergeCookies(jar, readSetCookies(response));
    await response.body?.cancel?.().catch(() => {});
  } catch (error) {
    trace?.push({ step: 'session', source: 'live', error: String(error?.message ?? error).slice(0, 160) });
    return { jar, msToken: '' };
  }

  const msToken = jar.get('msToken') ?? '';
  trace?.push({ step: 'session', source: 'live', status, cookies: [...jar.keys()] });

  if (jar.size) {
    const stored = new Response(JSON.stringify({ at: Date.now(), cookie: cookieHeader(jar), jar: Object.fromEntries(jar), msToken }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${SESSION_TTL_S}` },
    });
    await caches.default.put(new Request(SESSION_CACHE_KEY), stored).catch(() => {});
  }
  return { jar, msToken };
}

/** GET an HTML page as a browser would, keeping any cookies it sets. */
async function getPage(url, session, referer) {
  const headers = { ...PAGE_HEADERS };
  if (session.jar.size) headers.cookie = cookieHeader(session.jar);
  if (referer) { headers.referer = referer; headers['sec-fetch-site'] = 'same-origin'; }

  const response = await withTimeout(fetch(url, { headers, redirect: 'follow' }), PAGE_TIMEOUT_MS, `GET ${url}`);
  mergeCookies(session.jar, readSetCookies(response));
  const html = await response.text();
  return { status: response.status, finalUrl: response.url, html, bytes: html.length };
}

/**
 * The web API the site itself calls. Parameters are the ones
 * `tiktok-scraper-master` documented, refreshed for today's `tiktok_web` app.
 */
const webApiParams = (session, extra) => new URLSearchParams({
  aid: '1988',
  app_language: 'en',
  app_name: 'tiktok_web',
  browser_language: 'en-US',
  browser_name: 'Mozilla',
  browser_online: 'true',
  browser_platform: 'Win32',
  browser_version: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  channel: 'tiktok_web',
  cookie_enabled: 'true',
  device_platform: 'web_pc',
  focus_state: 'true',
  history_len: '3',
  is_fullscreen: 'false',
  is_page_visible: 'true',
  language: 'en',
  os: 'windows',
  priority_region: '',
  region: 'US',
  screen_height: '1080',
  screen_width: '1920',
  tz_name: 'America/New_York',
  webcast_language: 'en',
  ...(session.msToken || session.jar.get('msToken') ? { msToken: session.msToken || session.jar.get('msToken') } : {}),
  ...extra,
});

async function callWebApi(path, params, session, referer) {
  const url = `https://www.tiktok.com${path}?${params}`;
  const headers = {
    'user-agent': UA,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    referer: referer ?? 'https://www.tiktok.com/',
    origin: 'https://www.tiktok.com',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };
  if (session.jar.size) headers.cookie = cookieHeader(session.jar);

  const response = await withTimeout(fetch(url, { headers }), PAGE_TIMEOUT_MS, `GET ${path}`);
  mergeCookies(session.jar, readSetCookies(response));
  const text = await response.text();
  const body = text ? safeParse(text) : null;
  return { status: response.status, body, bytes: text.length, snippet: text.slice(0, 160) };
}

/** The JSON TikTok embeds in every server-rendered page. */
export function embeddedState(html) {
  const universal = html.match(/<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (universal?.[1]) return universal[1];
  const sigi = html.match(/<script[^>]+id=["'](?:SIGI_STATE|sigi-persisted-data)["'][^>]*>([\s\S]*?)<\/script>/i);
  return sigi?.[1] ?? null;
}

/** challengeId is what unlocks the paginated hashtag feed. */
function challengeIdFrom(html) {
  const raw = embeddedState(html);
  if (raw) {
    const state = safeParse(raw);
    const detail = state?.__DEFAULT_SCOPE__?.['webapp.challenge-detail'] ?? state?.ChallengePage ?? null;
    const id = detail?.challengeInfo?.challenge?.id ?? detail?.challengeInfo?.challengeId ?? null;
    if (id) return String(id);
    const module = state?.ChallengeModule?.challenges ?? null;
    if (module) {
      const first = Object.values(module)[0];
      if (first?.id) return String(first.id);
    }
  }
  return html.match(/"challengeId"\s*:\s*"(\d+)"/)?.[1]
    ?? html.match(/"challenge"\s*:\s*\{[^{}]*"id"\s*:\s*"(\d+)"/)?.[1]
    ?? null;
}

/** secUid is what unlocks a creator's full, paginated post list. */
function secUidFrom(html) {
  const raw = embeddedState(html);
  if (raw) {
    const state = safeParse(raw);
    const user = state?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.user;
    if (user?.secUid) return String(user.secUid);
    const users = state?.UserModule?.users;
    if (users) {
      const first = Object.values(users)[0];
      if (first?.secUid) return String(first.secUid);
    }
  }
  return html.match(/"secUid"\s*:\s*"([^"]{20,})"/)?.[1] ?? null;
}

/**
 * "trumps" must still match a caption that says "Trump", but a two-letter
 * fragment must not match everything — so only real words get stemmed.
 */
const hasToken = (haystack, token) => {
  if (haystack.includes(token)) return true;
  if (token.length >= 5) {
    const stem = token.replace(/(ies|es|s)$/, '');
    return stem.length >= 4 && haystack.includes(stem);
  }
  return false;
};

/**
 * One keyword search, entirely over HTTP.
 *
 * Strategies run in order and stop as soon as enough fresh videos are found:
 *   1. hashtag page HTML       — server-rendered, usually carries the first page
 *   2. challenge item_list API — cursor pagination for the same hashtag
 *   3. search page HTML        — TikTok sometimes embeds search results
 *   4. search item_list API    — the site's own search endpoint
 *   5. creator page HTML + post item_list — when the keyword names a creator
 */
export async function searchOverHttp(env, { keyword, want, knownIds, dateRange, maxPages = 6 }) {
  const startedAt = Date.now();
  const label = keyword ? `TikTok.com · HTTP · “${keyword}”` : 'TikTok.com · HTTP · Explore';
  const tokens = String(keyword ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const rangeStart = dateRange?.from ? Date.parse(`${dateRange.from}T00:00:00Z`) : null;
  const rangeEnd = dateRange?.to ? Date.parse(`${dateRange.to}T23:59:59Z`) : null;

  const collected = new Map();
  const sources = new Map();
  const debug = {
    provider: 'http', keyword, want, knownIds: knownIds?.size ?? 0,
    strategies: [], trace: [], collectedTotal: 0, matchedTotal: 0,
    fromTargetedEndpoints: 0, blocked: null, tookMs: 0,
  };

  const add = (raw, source) => {
    const video = normalizeTikTokItem(raw, label);
    if (!video) return;
    if (!collected.has(video.id)) collected.set(video.id, video);
    if (source === 'targeted' || !sources.has(video.id)) sources.set(video.id, source);
    if (source === 'targeted') debug.fromTargetedEndpoints += 1;
  };

  const matches = (video) => {
    if (tokens.length && sources.get(video.id) !== 'targeted') {
      const haystack = `${video.caption} ${video.hashtags.join(' ')} ${video.creator.username ?? ''} ${video.creator.displayName} ${video.soundName ?? ''}`.toLowerCase();
      if (!tokens.every((token) => hasToken(haystack, token))) return false;
    }
    if (rangeStart == null && rangeEnd == null) return true;
    if (!video.publishedAt) return false;                 // never guess a date
    const time = Date.parse(video.publishedAt);
    return (rangeStart == null || time >= rangeStart) && (rangeEnd == null || time <= rangeEnd);
  };

  const fresh = () => [...collected.values()].filter((video) => matches(video) && !(knownIds?.has(video.id)));
  const enough = () => fresh().length >= want;

  const session = await loadSession(env, debug.trace);
  const slug = slugify(keyword);

  const record = (name, detail) => {
    debug.strategies.push({ name, ...detail, collectedAfter: collected.size, matchedAfter: fresh().length });
  };

  // ---- 1 & 2: hashtag page, then its paginated feed --------------------------
  if (slug && !enough()) {
    const tagUrl = `https://www.tiktok.com/tag/${encodeURIComponent(slug)}`;
    let challengeId = null;
    try {
      const page = await getPage(tagUrl, session);
      const raw = embeddedState(page.html);
      const before = collected.size;
      if (raw) collectEmbeddedItems(raw).forEach((item) => add(item, 'targeted'));
      challengeId = challengeIdFrom(page.html);
      const block = classifyPage(page.html, { embedded: Boolean(raw), items: collected.size - before });
      if (block) debug.blocked = block;
      record('hashtag-html', {
        url: tagUrl, status: page.status, bytes: page.bytes,
        embedded: Boolean(raw), items: collected.size - before, challengeId, blocked: block,
      });
    } catch (error) {
      record('hashtag-html', { url: tagUrl, error: String(error?.message ?? error).slice(0, 160) });
    }

    if (challengeId && !enough()) {
      let cursor = 0;
      for (let page = 0; page < maxPages && !enough(); page += 1) {
        try {
          const params = webApiParams(session, {
            challengeID: challengeId, count: '30', cursor: String(cursor), from_page: 'hashtag',
          });
          const result = await callWebApi('/api/challenge/item_list/', params, session, tagUrl);
          const before = collected.size;
          itemsFromListBody(result.body).forEach((item) => add(item, 'targeted'));
          const gained = collected.size - before;
          record('challenge-api', { page, status: result.status, bytes: result.bytes, items: gained, cursor, snippet: gained ? undefined : result.snippet });
          if (!gained || result.body?.hasMore === false) break;
          cursor = Number(result.body?.cursor ?? cursor + 30) || cursor + 30;
          await sleep(120);
        } catch (error) {
          record('challenge-api', { page, error: String(error?.message ?? error).slice(0, 160) });
          break;
        }
      }
    }
  }

  // ---- 3: the search page itself --------------------------------------------
  if (keyword && !enough()) {
    const searchUrl = `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`;
    try {
      const page = await getPage(searchUrl, session, 'https://www.tiktok.com/');
      const raw = embeddedState(page.html);
      const before = collected.size;
      if (raw) collectEmbeddedItems(raw).forEach((item) => add(item, 'targeted'));
      const block = classifyPage(page.html, { embedded: Boolean(raw), items: collected.size - before });
      if (block && !debug.blocked) debug.blocked = block;
      record('search-html', { url: searchUrl, status: page.status, bytes: page.bytes, embedded: Boolean(raw), items: collected.size - before, blocked: block });
    } catch (error) {
      record('search-html', { error: String(error?.message ?? error).slice(0, 160) });
    }
  }

  // ---- 4: the site's own search endpoint ------------------------------------
  if (keyword && !enough()) {
    const referer = `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`;
    const searchId = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    for (const [name, path] of [['search-api', '/api/search/general/full/'], ['search-video-api', '/api/search/item/full/']]) {
      if (enough()) break;
      try {
        const params = webApiParams(session, {
          keyword, offset: '0', search_id: searchId, from_page: 'search', web_search_code: '{"tiktok":{"client_params_x":{"search_engine":{"ies_mt_user_live_video_card_use_libra":1}},"search_server":{}}}',
        });
        const result = await callWebApi(path, params, session, referer);
        const before = collected.size;
        itemsFromListBody(result.body).forEach((item) => add(item, 'targeted'));
        // /api/search/general/full/ wraps items one level deeper.
        for (const entry of Array.isArray(result.body?.data) ? result.body.data : []) {
          for (const item of entry?.item_list ?? []) add(item, 'targeted');
        }
        const gained = collected.size - before;
        record(name, { status: result.status, bytes: result.bytes, items: gained, snippet: gained ? undefined : result.snippet });
      } catch (error) {
        record(name, { error: String(error?.message ?? error).slice(0, 160) });
      }
    }
  }

  // ---- 5: creator pages ------------------------------------------------------
  const handle = String(keyword ?? '').trim().replace(/^@/, '');
  if (handle && /^[a-zA-Z0-9._]{2,24}$/.test(handle) && !enough()) {
    const userUrl = `https://www.tiktok.com/@${encodeURIComponent(handle)}`;
    try {
      const page = await getPage(userUrl, session);
      const raw = embeddedState(page.html);
      const before = collected.size;
      if (raw) collectEmbeddedItems(raw).forEach((item) => add(item, 'targeted'));
      const secUid = secUidFrom(page.html);
      record('creator-html', { url: userUrl, status: page.status, bytes: page.bytes, embedded: Boolean(raw), items: collected.size - before, secUid: Boolean(secUid) });

      if (secUid && !enough()) {
        let cursor = 0;
        for (let page2 = 0; page2 < maxPages && !enough(); page2 += 1) {
          const params = webApiParams(session, { secUid, count: '35', cursor: String(cursor), coverFormat: '2', post_item_list_request_type: '0', from_page: 'user' });
          const result = await callWebApi('/api/post/item_list/', params, session, userUrl);
          const before2 = collected.size;
          itemsFromListBody(result.body).forEach((item) => add(item, 'targeted'));
          const gained = collected.size - before2;
          record('creator-posts-api', { page: page2, status: result.status, items: gained, snippet: gained ? undefined : result.snippet });
          if (!gained || result.body?.hasMore === false) break;
          cursor = Number(result.body?.cursor ?? cursor + 35) || cursor + 35;
          await sleep(120);
        }
      }
    } catch (error) {
      record('creator-html', { error: String(error?.message ?? error).slice(0, 160) });
    }
  }

  // ---- Explore feed (no keyword) ---------------------------------------------
  if (!keyword && !enough()) {
    try {
      const page = await getPage('https://www.tiktok.com/explore', session);
      const raw = embeddedState(page.html);
      const before = collected.size;
      if (raw) collectEmbeddedItems(raw).forEach((item) => add(item, 'feed'));
      record('explore-html', { status: page.status, bytes: page.bytes, embedded: Boolean(raw), items: collected.size - before });
    } catch (error) {
      record('explore-html', { error: String(error?.message ?? error).slice(0, 160) });
    }
    for (let page = 0; page < 3 && !enough(); page += 1) {
      try {
        const params = webApiParams(session, { count: '30', cursor: String(page * 30), from_page: 'explore', categoryType: '0' });
        const result = await callWebApi('/api/explore/item_list/', params, session, 'https://www.tiktok.com/explore');
        const before = collected.size;
        itemsFromListBody(result.body).forEach((item) => add(item, 'feed'));
        const gained = collected.size - before;
        record('explore-api', { page, status: result.status, items: gained, snippet: gained ? undefined : result.snippet });
        if (!gained) break;
      } catch (error) {
        record('explore-api', { page, error: String(error?.message ?? error).slice(0, 160) });
        break;
      }
    }
  }

  debug.collectedTotal = collected.size;
  debug.matchedTotal = fresh().length;
  debug.tookMs = Date.now() - startedAt;

  const batch = fresh().sort((a, b) => (b.views ?? -1) - (a.views ?? -1)).slice(0, want);
  return {
    videos: batch,
    scanned: collected.size,
    // More pages exist whenever a targeted endpoint was still producing items.
    hasMore: batch.length >= want,
    debug,
  };
}

/**
 * Diagnostic sweep: run every browser-free route once and report exactly what
 * TikTok answered. This is what tells us — from Cloudflare's own IP, not from
 * a guess — which routes are usable.
 */
export async function probeHttp(env, keyword) {
  const trace = [];
  const session = await loadSession(env, trace);
  const slug = slugify(keyword || 'fyp');
  const results = [];

  const note = async (name, run) => {
    const startedAt = Date.now();
    try {
      const detail = await run();
      results.push({ name, ok: true, tookMs: Date.now() - startedAt, ...detail });
    } catch (error) {
      results.push({ name, ok: false, tookMs: Date.now() - startedAt, error: String(error?.message ?? error).slice(0, 200) });
    }
  };

  await note('oembed', async () => {
    const response = await withTimeout(fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent('https://www.tiktok.com/@tiktok')}`, {
      headers: { 'user-agent': UA, accept: 'application/json' },
    }), PAGE_TIMEOUT_MS, 'oembed');
    const text = await response.text();
    return { status: response.status, bytes: text.length, snippet: text.slice(0, 120) };
  });

  await note('hashtag-html', async () => {
    const page = await getPage(`https://www.tiktok.com/tag/${encodeURIComponent(slug)}`, session);
    const raw = embeddedState(page.html);
    return {
      status: page.status, bytes: page.bytes, finalUrl: page.finalUrl,
      embedded: Boolean(raw), embeddedBytes: raw?.length ?? 0,
      items: raw ? collectEmbeddedItems(raw).length : 0,
      challengeId: challengeIdFrom(page.html),
      blocked: classifyPage(page.html, { embedded: Boolean(raw), items: raw ? collectEmbeddedItems(raw).length : 0 }),
      title: page.html.match(/<title>([^<]{0,120})/i)?.[1] ?? null,
    };
  });

  await note('challenge-api', async () => {
    const page = await getPage(`https://www.tiktok.com/tag/${encodeURIComponent(slug)}`, session);
    const challengeId = challengeIdFrom(page.html);
    if (!challengeId) return { status: null, note: 'no challengeId found on the hashtag page' };
    const params = webApiParams(session, { challengeID: challengeId, count: '30', cursor: '0', from_page: 'hashtag' });
    const result = await callWebApi('/api/challenge/item_list/', params, session, `https://www.tiktok.com/tag/${slug}`);
    return { status: result.status, bytes: result.bytes, items: itemsFromListBody(result.body).length, statusCode: result.body?.statusCode ?? null, snippet: result.snippet };
  });

  await note('search-html', async () => {
    const page = await getPage(`https://www.tiktok.com/search?q=${encodeURIComponent(keyword || 'fyp')}`, session, 'https://www.tiktok.com/');
    const raw = embeddedState(page.html);
    return {
      status: page.status, bytes: page.bytes, embedded: Boolean(raw),
      items: raw ? collectEmbeddedItems(raw).length : 0,
      blocked: classifyPage(page.html, { embedded: Boolean(raw), items: raw ? collectEmbeddedItems(raw).length : 0 }),
      title: page.html.match(/<title>([^<]{0,120})/i)?.[1] ?? null,
    };
  });

  await note('search-api', async () => {
    const params = webApiParams(session, { keyword: keyword || 'fyp', offset: '0', search_id: String(Date.now()), from_page: 'search' });
    const result = await callWebApi('/api/search/general/full/', params, session, `https://www.tiktok.com/search?q=${encodeURIComponent(keyword || 'fyp')}`);
    return { status: result.status, bytes: result.bytes, items: itemsFromListBody(result.body).length, statusCode: result.body?.statusCode ?? null, snippet: result.snippet };
  });

  await note('creator-html', async () => {
    const page = await getPage('https://www.tiktok.com/@tiktok', session);
    const raw = embeddedState(page.html);
    return {
      status: page.status, bytes: page.bytes, embedded: Boolean(raw),
      items: raw ? collectEmbeddedItems(raw).length : 0,
      secUid: Boolean(secUidFrom(page.html)),
      blocked: classifyPage(page.html, { embedded: Boolean(raw), items: raw ? collectEmbeddedItems(raw).length : 0 }),
    };
  });

  await note('explore-html', async () => {
    const page = await getPage('https://www.tiktok.com/explore', session);
    const raw = embeddedState(page.html);
    const items = raw ? collectEmbeddedItems(raw).length : 0;
    return { status: page.status, bytes: page.bytes, embedded: Boolean(raw), items, blocked: classifyPage(page.html, { embedded: Boolean(raw), items }) };
  });

  const usable = results.filter((entry) => entry.ok && (entry.items ?? 0) > 0).map((entry) => entry.name);
  const shells = results.filter((entry) => entry.blocked === 'shell-no-content').length;
  const captchas = results.filter((entry) => entry.blocked === 'captcha').length;

  const verdict = usable.length
    ? `Browser-free search works from this Worker via: ${usable.join(', ')}.`
    : captchas
      ? 'TikTok is challenging this Worker with a captcha page. Collection must run somewhere else (the GitHub Actions collector works).'
      : shells
        ? 'TikTok answers this Worker with a valid but EMPTY shell page: HTTP 200, a large embedded payload of config only, no videos and no challengeId. That is IP-level anti-bot, so no header, signature or retry fixes it from Cloudflare — collection has to run elsewhere. The GitHub Actions collector does work, and /api/fetch-tiktok now triggers it on demand for keywords it does not have.'
        : 'No browser-free route returned videos, and the pages did not look like the usual anti-bot shell either — read `results` for the exact statuses.';

  return {
    keyword: keyword || null,
    cookies: [...session.jar.keys()],
    hasMsToken: Boolean(session.msToken || session.jar.get('msToken')),
    trace,
    results,
    usable,
    shellPages: shells,
    verdict,
  };
}
