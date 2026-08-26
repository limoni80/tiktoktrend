/**
 * Dataset collector — runs in GitHub Actions, not in the browser and not on
 * Cloudflare.
 *
 * Why this exists: Cloudflare Browser Rendering allows only 2 browser launches
 * per minute on the free plan, so live keyword search there is rationed. A
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

async function collectOne(context, { keyword, want }) {
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
          ...(slug ? [{ name: 'hashtag', url: `https://www.tiktok.com/tag/${encodeURIComponent(slug)}` }] : []),
        ]
      : [{ name: 'explore', url: 'https://www.tiktok.com/explore' }];

    const fresh = () => [...collected.values()].filter(matches);

    for (const step of plan) {
      const record = { name: step.name, url: step.url, finalUrl: null, title: null, scrollRounds: 0, matchedAfter: 0, error: null };
      debug.strategies.push(record);
      try {
        await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await sleep(3_000);
        record.finalUrl = page.url();
        record.title = await page.title().catch(() => null);
        await page.keyboard.press('Escape').catch(() => {});

        const embedded = await page.evaluate(() =>
          document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent
          ?? document.getElementById('SIGI_STATE')?.textContent ?? null).catch(() => null);
        if (embedded) collectEmbeddedItems(embedded).forEach((item) => add(item, keyword ? 'search' : 'feed'));

        let stagnant = 0;
        let seen = collected.size;
        for (let round = 0; round < 30 && fresh().length < want && stagnant < 6; round += 1) {
          await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)).catch(() => {});
          await sleep(1_200);
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
  const keywords = [...new Set([...(settings.keywords ?? []), ...(extra ? [extra] : [])].map((k) => String(k).trim()).filter(Boolean))].slice(0, 40);
  const want = Math.min(120, Math.max(10, Number(settings.perKeyword ?? 60)));
  const startedAt = new Date().toISOString();

  log(`Collecting ${keywords.length} keyword(s) × ${want} videos, plus the Explore feed`);

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
    await writeJson(join(OUT, path), payload);
    return {
      ...meta,
      status: payload.videos.length ? 'ok' : 'empty',
      count: payload.videos.length,
      updatedAt: payload.fetchedAt,
      lastSuccessAt: payload.videos.length ? payload.fetchedAt : (old?.fetchedAt ?? null),
    };
  };

  try {
    // 1. Explore feed for the home page.
    log('› Explore feed');
    const feed = await collectOne(context, { keyword: '', want });
    catalogue.push(await publish('feed.json', {
      videos: feed.videos, scanned: feed.scanned, hasMore: false,
      source: 'TikTok.com Explore feed · collected by GitHub Actions',
      keyword: null, fetchedAt: new Date().toISOString(), debug: feed.debug,
    }, { kind: 'feed', file: 'feed.json', keyword: null }));

    // 2. One file per keyword.
    for (const keyword of keywords) {
      log(`› “${keyword}”`);
      const slug = slugify(keyword);
      let result;
      try {
        result = await collectOne(context, { keyword, want });
      } catch (error) {
        log(`    ! ${String(error?.message ?? error).split('\n')[0]}`);
        result = { videos: [], scanned: 0, debug: { keyword, error: String(error?.message ?? error).slice(0, 200) } };
      }
      catalogue.push(await publish(`search/${slug}.json`, {
        videos: result.videos, scanned: result.scanned, hasMore: false,
        source: `TikTok.com search · “${keyword}” · collected by GitHub Actions`,
        keyword, fetchedAt: new Date().toISOString(), debug: result.debug,
      }, { kind: 'search', file: `search/${slug}.json`, keyword, slug }));
      await sleep(2_000);
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
    keywords: catalogue.filter((entry) => entry.kind === 'search').map(({ keyword, slug, status, count, updatedAt }) => ({ keyword, slug, status, count, updatedAt })),
  };
  await writeJson(join(OUT, 'index.json'), index);

  const ok = catalogue.filter((entry) => entry.status === 'ok').length;
  const empty = catalogue.filter((entry) => entry.status === 'empty').length;
  const stale = catalogue.filter((entry) => entry.status === 'stale').length;
  log(`\nDone: ${ok} ok · ${empty} empty · ${stale} kept-stale`);
  // An empty run is reported, not hidden — but it must not fail the workflow,
  // or the next scheduled run would be skipped after a repeated failure.
  if (!ok) log('WARNING: nothing was collected in this run. Check the strategies/apiHits above — TikTok may be serving only its generic feed to this runner IP.');
}

await main();
