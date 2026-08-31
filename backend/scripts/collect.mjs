/**
 * Dataset collector — runs in GitHub Actions, not in the browser and not on
 * Cloudflare.
 *
 * Why this exists: Cloudflare Browser Run Free allows only 3 concurrent
 * browsers, one new browser every 20 seconds, and 10 browser-minutes/day. A
 * GitHub Actions runner has a real Chromium and free minutes on public repos,
 * so it scrapes a list of keywords on a schedule and publishes the results as
 * plain JSON. The Worker then serves those instantly, with no browser at all.
 *
 * Honesty rules baked in:
 *  - Nothing is invented. If TikTok returns nothing for a keyword, the file
 *    records that (`status: "empty"`) instead of inventing videos.
 *  - A failed run never destroys good data: the previous published payload is
 *    kept and marked `stale`, with `lastSuccessAt` so the UI can say how old it is.
 *  - No cookies, no login, no persistent profile. Ephemeral context only.
 *
 * Output tree (published to the `data` branch by the workflow):
 *   out/index.json                 catalogue + per-keyword status
 *   out/feed.json                  Explore feed (home page)
 *   out/search/<slug>.json         one file per keyword
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';
import {
  collectEmbeddedItems, itemsFromListBody, normalizeTikTokItem, safeParse,
} from '../src/normalize.mjs';

const OUT = 'out';
const REPO = process.env.GITHUB_REPOSITORY ?? 'limoni80/tiktoktrend';
const DATA_BRANCH = process.env.DATA_BRANCH ?? 'data';
const PREVIOUS_BASE = `https://raw.githubusercontent.com/${REPO}/${DATA_BRANCH}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const LIST_PATTERN =
  /\/api\/(explore\/item_list|recommend\/item_list|challenge\/item_list|post\/item_list|search\/general\/full|search\/item\/full|search\/video\/full|search\/general\/preview|item\/detail|related\/item_list)\//;

/** Upper bound on the recurring keyword list (config + remembered on-demand). */
const MAX_KEYWORDS = Number(process.env.MAX_KEYWORDS ?? 24);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slugify = (value) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'keyword';
const log = (...parts) => console.log(...parts);

const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

/** Last published version of a file, so a bad run cannot erase a good one. */
async function previous(path) {
  try {
    const response = await fetch(`${PREVIOUS_BASE}/${path}`, { headers: { 'user-agent': 'tiktoktrend-collector' } });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

/** "trumps" must still match a caption that says "Trump". */
const hasToken = (haystack, token) => {
  if (haystack.includes(token)) return true;
  if (token.length >= 5) {
    const stem = token.replace(/(ies|es|s)$/, '');
    if (stem.length >= 4 && haystack.includes(stem)) return true;
  }
  return false;
};

async function collectOne(context, { keyword, want, fast = false }) {
  const label = keyword ? `TikTok.com · search · “${keyword}”` : 'TikTok.com · Explore';
  const tokens = keyword.toLowerCase().split(/\s+/).filter(Boolean);
  const collected = new Map();
  const sources = new Map();

  const add = (raw, source) => {
    const video = normalizeTikTokItem(raw, label);
    if (!video) return;
    if (!collected.has(video.id)) collected.set(video.id, video);
    if (source === 'search' || !sources.has(video.id)) sources.set(video.id, source);
  };

  const matches = (video) => {
    if (!tokens.length) return true;
    if (sources.get(video.id) === 'search') return true;   // TikTok already ranked it
    const haystack = `${video.caption} ${video.hashtags.join(' ')} ${video.creator.username ?? ''} ${video.creator.displayName} ${video.soundName ?? ''}`.toLowerCase();
    return tokens.every((token) => hasToken(haystack, token));
  };

  const debug = { keyword, want, strategies: [], apiHits: {}, fromSearchEndpoints: 0, loginWall: false, captchaWall: false, bodySnippet: null };

  const page = await context.newPage();
  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (!LIST_PATTERN.test(url)) return;
      const key = new URL(url).pathname;
      const source = /\/(search|challenge|post)\//.test(key) ? 'search' : 'feed';
      const before = collected.size;
      itemsFromListBody(safeParse(await response.text())).forEach((item) => add(item, source));
      const gained = collected.size - before;
      debug.apiHits[key] = debug.apiHits[key] ?? { calls: 0, items: 0, source };
      debug.apiHits[key].calls += 1;
      debug.apiHits[key].items += gained;
      if (source === 'search') debug.fromSearchEndpoints += gained;
    } catch { /* partial or non-JSON body */ }
  });

  try {
    await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    await sleep(1_500);

    const slug = keyword.replace(/[^a-z0-9]+/gi, '').toLowerCase();
    const plan = keyword
      ? [
          { name: 'search', url: `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}` },
          { name: 'search-video-tab', url: `https://www.tiktok.com/search/video?q=${encodeURIComponent(keyword)}` },
          ...(!fast && slug ? [{ name: 'hashtag', url: `https://www.tiktok.com/tag/${encodeURIComponent(slug)}` }] : []),
        ]
      : [{ name: 'explore', url: 'https://www.tiktok.com/explore' }];

    const fresh = () => [...collected.values()].filter(matches);

    for (const step of plan) {
      const record = { name: step.name, url: step.url, finalUrl: null, title: null, scrollRounds: 0, matchedAfter: 0, error: null };
      debug.strategies.push(record);
      try {
        await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await sleep(fast ? 1_800 : 3_000);
        record.finalUrl = page.url();
        record.title = await page.title().catch(() => null);
        await page.keyboard.press('Escape').catch(() => {});

        const embedded = await page.evaluate(() =>
          document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent
          ?? document.getElementById('SIGI_STATE')?.textContent ?? null).catch(() => null);
        if (embedded) collectEmbeddedItems(embedded).forEach((item) => add(item, keyword ? 'search' : 'feed'));

        let stagnant = 0;
        let seen = collected.size;
        const maxScrollRounds = fast ? 16 : 30;
        for (let round = 0; round < maxScrollRounds && fresh().length < want && stagnant < 6; round += 1) {
          await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)).catch(() => {});
          await sleep(fast ? 900 : 1_200);
          stagnant = collected.size === seen ? stagnant + 1 : 0;
          seen = collected.size;
          record.scrollRounds = round + 1;
        }

        const body = await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => '');
        debug.bodySnippet = body.replace(/\s+/g, ' ').slice(0, 300);
        if (/log in|sign up/i.test(body)) debug.loginWall = true;
        if (/verify to continue|captcha|are a robot|security check/i.test(body)) debug.captchaWall = true;
      } catch (error) {
        record.error = String(error?.message ?? error).split('\n')[0].slice(0, 200);
      }
      record.matchedAfter = fresh().length;
      log(`    · ${step.name}: ${record.matchedAfter} matched / ${collected.size} collected${record.error ? ` (${record.error})` : ''}`);
      if (record.matchedAfter >= want) break;
      // An on-demand run needs the first useful page quickly. If the normal
      // search route already delivered it, skip slower alternate surfaces.
      if (fast && step.name === 'search' && record.matchedAfter >= Math.min(want, 40)) break;
    }

    const videos = fresh()
      .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
      .slice(0, want);

    return { videos, scanned: collected.size, debug };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const configRaw = await readFile('data/keywords.json', 'utf8').catch(() => '{}');
  const settings = JSON.parse(configRaw);
  const extra = (process.env.EXTRA_KEYWORD ?? '').trim();
  const mergePublish = process.env.MERGE_PUBLISH === '1';
  const fast = Boolean(extra) && process.env.FULL_REFRESH !== '1';
  const onDemand = process.env.ON_DEMAND === '1';
  const targetPerKeyword = onDemand ? process.env.ON_DEMAND_PER_KEYWORD : settings.perKeyword;
  const want = Math.min(120, Math.max(10, Number(targetPerKeyword ?? 60)));
  const startedAt = new Date().toISOString();
  const budgetMs = Math.max(60_000, Number(process.env.COLLECT_BUDGET_MS ?? 20 * 60_000));
  const deadline = Date.now() + budgetMs;

  // Legacy/full runs use the published index as memory. The parallel workflow
  // gives each fast job one keyword and merge-publish.mjs safely combines its
  // shard with the latest data branch, so concurrent jobs cannot delete one
  // another's results.
  const previousIndex = await previous('index.json');
  const remembered = (previousIndex?.keywords ?? []).map((entry) => String(entry?.keyword ?? '').trim()).filter(Boolean);
  const configured = (settings.keywords ?? []).map((value) => String(value).trim()).filter(Boolean);
  // The parallel workflow merges a fast artifact into the latest data branch,
  // so an on-demand job only needs its own keyword. Scheduled staleness and
  // empty-result cooldowns are planned centrally in plan-keywords.mjs.
  const ordered = extra && mergePublish
    ? [extra]
    : [...(extra ? [extra] : []), ...configured, ...remembered];
  const seen = new Set();
  const keywords = [];
  for (const keyword of ordered) {
    const key = slugify(keyword);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keywords.push(keyword);
    if (keywords.length >= MAX_KEYWORDS) break;
  }

  // A run triggered for one keyword must be FAST — someone is waiting for it.
  // So it collects only that keyword and carries every other file forward
  // untouched. The scheduled run (no EXTRA_KEYWORD) does the full refresh.
  const targets = fast ? keywords.slice(0, 1) : keywords;
  const carryOnly = fast && !mergePublish ? keywords.slice(1) : [];

  log(fast
    ? `FAST run for “${extra}” — collecting 1 keyword${mergePublish ? ' for merge-publish' : `, carrying ${carryOnly.length} forward`}`
    : `Full run: up to ${targets.length} keyword(s) × ${want} videos, plus the Explore feed`);
  if (remembered.length) log(`Known from the last run: ${remembered.length} keyword(s)`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--no-sandbox'],
    // CHROME_PATH lets this run against a Chromium that is already on the host
    // (a CI image, a dev machine) instead of Playwright's own download.
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    locale: 'en-US',
    userAgent: UA,
    extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
  });
  // Metrics all arrive as JSON — never download the media itself.
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) return route.abort().catch(() => {});
    return route.continue().catch(() => {});
  });

  const catalogue = [];

  const publish = async (path, payload, meta) => {
    const old = await previous(path);
    if (!payload.videos.length && old?.videos?.length) {
      // Keep the last good result rather than publishing an empty file.
      const kept = { ...old, stale: true, staleSince: startedAt, lastAttemptAt: startedAt, lastAttemptDebug: payload.debug };
      await writeJson(join(OUT, path), kept);
      return { ...meta, status: 'stale', count: old.videos.length, updatedAt: old.fetchedAt, lastSuccessAt: old.fetchedAt };
    }
    // Count consecutive empty results so a keyword TikTok has nothing for can
    // stop being re-collected every run. Any success resets it.
    const emptyStreak = payload.videos.length ? 0 : Number(old?.emptyStreak ?? 0) + 1;
    await writeJson(join(OUT, path), { ...payload, emptyStreak });
    return {
      ...meta,
      status: payload.videos.length ? 'ok' : 'empty',
      count: payload.videos.length,
      emptyStreak,
      updatedAt: payload.fetchedAt,
      lastSuccessAt: payload.videos.length ? payload.fetchedAt : (old?.fetchedAt ?? null),
    };
  };

  try {
    // 1. Explore feed for the home page (skipped on a fast run).
    if (fast) {
      if (!mergePublish) {
        const old = await previous('feed.json');
        if (old?.videos?.length) {
          await writeJson(join(OUT, 'feed.json'), { ...old, carriedForward: true, carriedAt: startedAt });
          catalogue.push({ kind: 'feed', file: 'feed.json', keyword: null, status: 'carried', count: old.videos.length, updatedAt: old.fetchedAt, lastSuccessAt: old.fetchedAt });
        }
      }
    } else {
      log('› Explore feed');
      const feed = await collectOne(context, { keyword: '', want });
      catalogue.push(await publish('feed.json', {
        videos: feed.videos, scanned: feed.scanned, hasMore: false,
        source: 'TikTok.com Explore feed · collected by GitHub Actions',
        keyword: null, fetchedAt: new Date().toISOString(), debug: feed.debug,
      }, { kind: 'feed', file: 'feed.json', keyword: null }));
    }

    // 2. One file per keyword, within a time budget. Production gives this
    // process one keyword and parallelizes across the GitHub Actions matrix.
    const collectKeyword = async (keyword) => {
      const slug = slugify(keyword);
      const file = `search/${slug}.json`;

      // Out of time: keep the previous payload untouched rather than dropping
      // the keyword off the branch (which would delete it for the dashboard).
      if (Date.now() > deadline) {
        const old = await previous(file);
        if (old?.videos?.length) {
          await writeJson(join(OUT, file), { ...old, carriedForward: true, carriedAt: startedAt });
          catalogue.push({ kind: 'search', file, keyword, slug, status: 'carried', count: old.videos.length, emptyStreak: Number(old.emptyStreak ?? 0), updatedAt: old.fetchedAt, lastSuccessAt: old.fetchedAt });
          log(`› “${keyword}” — carried forward (time budget reached)`);
        }
        return;
      }

      log(`› “${keyword}”`);
      let result;
      try {
        result = await collectOne(context, { keyword, want, fast: onDemand });
      } catch (error) {
        log(`    ! ${String(error?.message ?? error).split('\n')[0]}`);
        result = { videos: [], scanned: 0, debug: { keyword, error: String(error?.message ?? error).slice(0, 200) } };
      }
      catalogue.push(await publish(file, {
        videos: result.videos, scanned: result.scanned, hasMore: false,
        source: `TikTok.com search · “${keyword}” · collected by GitHub Actions`,
        keyword, fetchedAt: new Date().toISOString(), debug: result.debug,
      }, { kind: 'search', file, keyword, slug }));
      await sleep(2_000);
    };

    for (const keyword of targets) await collectKeyword(keyword);

    // 3. Legacy fast publishing carries untouched files. The current parallel
    //    workflow sets MERGE_PUBLISH=1, emits only the refreshed shard, and the
    //    serialized publish job merges it without replacing newer files.
    for (const keyword of carryOnly) {
      const slug = slugify(keyword);
      const file = `search/${slug}.json`;
      const old = await previous(file);
      if (!old?.videos?.length) continue;
      await writeJson(join(OUT, file), { ...old, carriedForward: true, carriedAt: startedAt });
      catalogue.push({ kind: 'search', file, keyword, slug, status: 'carried', count: old.videos.length, updatedAt: old.fetchedAt, lastSuccessAt: old.fetchedAt });
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const index = {
    generatedAt: new Date().toISOString(),
    startedAt,
    repo: REPO,
    runUrl: process.env.GITHUB_RUN_ID ? `https://github.com/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
    entries: catalogue,
    keywords: catalogue.filter((entry) => entry.kind === 'search')
      .map(({ keyword, slug, status, count, updatedAt, emptyStreak }) => ({ keyword, slug, status, count, updatedAt, ...(emptyStreak ? { emptyStreak } : {}) })),
  };
  await writeJson(join(OUT, 'index.json'), index);

  const ok = catalogue.filter((entry) => entry.status === 'ok').length;
  const empty = catalogue.filter((entry) => entry.status === 'empty').length;
  const stale = catalogue.filter((entry) => entry.status === 'stale').length;
  const carried = catalogue.filter((entry) => entry.status === 'carried').length;
  log(`\nDone: ${ok} ok · ${empty} empty · ${stale} kept-stale · ${carried} carried forward`);
  // An empty run is reported, not hidden — but it must not fail the workflow,
  // or the next scheduled run would be skipped after a repeated failure.
  if (!ok) log('WARNING: nothing was collected in this run. Check the strategies/apiHits above — TikTok may be serving only its generic feed to this runner IP.');
}

await main();
