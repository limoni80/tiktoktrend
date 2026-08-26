/**
 * Cloudflare Worker for tiktoktrend.
 *
 * Before this file existed the Worker served static assets only, so every
 * /api/* request fell through to the SPA handler and returned index.html —
 * which is what produced `Unexpected token '<', "<!doctype "...` in the UI.
 *
 * Now the Worker owns /api/* and never lets it reach the asset handler:
 *
 *   /api/health        → JSON status, always answers
 *   /api/fetch         → REAL TikTok Creative Center trends, fetched directly
 *                        from Cloudflare. No browser, no cookies, no login.
 *   /api/video         → streams TikTok CDN media (Range supported)
 *   /api/fetch-tiktok  → keyword search + full engagement metrics. Needs the
 *   /api/fetch-ads       Node/Playwright backend, so it is proxied to
 *   /api/progress        BACKEND_URL when that variable is set, and returns a
 *   /api/datasets        structured JSON error explaining why when it is not.
 *
 * Everything else is served from dashboard/dist via the ASSETS binding.
 */

import puppeteer from '@cloudflare/puppeteer';
import {
  collectEmbeddedItems, itemsFromListBody, normalizeTikTokItem, normalizeTrendEntity, safeParse,
} from '../backend/src/normalize.mjs';

const TIKTOK_LIST_PATTERN =
  /\/api\/(explore\/item_list|recommend\/item_list|search\/general\/full|search\/item\/full|search\/general\/preview|item\/detail|related\/item_list)\//;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const TRENDS_HOSTS = ['ads.us.tiktok.com', 'ads.tiktok.com', 'ads-sg.tiktok.com'];
const CONTENT_LABELS = ['11001','11002','11003','11004','11005','11007','11008','11009','11010','11013','11014','11015'];
const ALLOWED_REGIONS = new Set(['US','FR','DE','IT','ES','GB','AR','AU','BR','CA','CO','EG','ID','IL','JP','KR','MY','MX','PH','SA','SG','ZA','TW','TH','TR','AE','VN']);
const ALLOWED_PERIODS = new Set(['7', '30']);
const VIDEO_HOST = /(^|\.)((tiktokcdn(-us|-eu)?\.com)|(tiktok\.com)|(tiktokv\.com)|(ibytedtos\.com)|(ttwstatic\.com)|(byteoversea\.com))$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
});

const fail = (status, code, message, extra = {}) => json({ error: { code, message, ...extra } }, status);

async function tikTokJson(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'application/json',
      referer: 'https://ads.tiktok.com/',
      origin: 'https://ads.tiktok.com',
      'accept-language': 'en-US,en;q=0.9',
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return safeParse(await response.text());
}

/**
 * TikTok Creative Center country trends. This endpoint is unsigned and
 * cookie-free, so a Worker can call it directly — this is the real-data path
 * that works with no backend at all.
 */
async function fetchTrends(region, period, budgetMs = 20_000) {
  let host = null;
  let overview = null;
  for (const candidate of TRENDS_HOSTS) {
    try {
      const result = await tikTokJson(`https://${candidate}/CreativeOne/Report/GetTopContentsOverview`);
      if (result?.BaseResp?.StatusCode === 0) { host = candidate; overview = result; break; }
    } catch { /* try the next host */ }
  }
  if (!host) {
    throw Object.assign(new Error('TikTok Creative Center did not respond to this Worker.'), { code: 'trends_unreachable', status: 502 });
  }

  const endTs = period === '30'
    ? overview?.lastMonthlyEndTimestamp ?? overview?.lastWeeklyEndTimestamp
    : overview?.lastWeeklyEndTimestamp ?? overview?.lastDailyEndTimestamp;
  const dimension = period === '30' ? '5' : '3';

  const jobs = [
    ...['1', '2', '3'].map((order) => ({ label: '', order })),
    ...CONTENT_LABELS.map((label) => ({ label, order: '1' })),
  ];

  const collected = new Map();
  const deadline = Date.now() + budgetMs;
  // Small concurrent batches: fast enough for a Worker's CPU/time budget.
  for (let index = 0; index < jobs.length && Date.now() < deadline; index += 4) {
    const slice = jobs.slice(index, index + 4);
    const results = await Promise.allSettled(slice.map((job) => {
      const params = new URLSearchParams({
        contentLabelIDs: job.label, countryCode: region, limit: '20', orderByMetric: job.order,
        organicOnly: 'false', page: '1', periodDimension: dimension, periodEndTimestamp: String(endTs ?? ''),
      });
      return tikTokJson(`https://${host}/CreativeOne/Report/CreativeCenterGetTopContentsList?${params}`);
    }));
    for (const result of results) {
      if (result.status !== 'fulfilled' || result.value?.BaseResp?.StatusCode !== 0) continue;
      for (const entity of result.value?.entityInfos ?? []) {
        const video = normalizeTrendEntity(entity, region);
        if (video && !collected.has(video.id)) collected.set(video.id, video);
      }
    }
  }

  if (!collected.size) {
    throw Object.assign(new Error(`TikTok returned no trend videos for ${region}.`), { code: 'trends_empty', status: 502 });
  }
  return [...collected.values()].sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
}

/**
 * Keyword search / Explore feed, run on Cloudflare Browser Rendering.
 *
 * TikTok only serves its feed JSON to a client holding ttwid / msToken
 * cookies, so the throwaway browser is warmed on the public homepage first —
 * no stored profile, no login, no cookies of ours.
 *
 * Workers are stateless between requests, so pagination works by having the
 * client send the ids it already holds (`known`); we scroll past them and
 * return what is new.
 */
async function searchWithBrowser(env, { keyword, want, knownIds, dateRange }) {
  const tokens = keyword.toLowerCase().split(/\s+/).filter(Boolean);
  const rangeStart = dateRange.from ? Date.parse(`${dateRange.from}T00:00:00Z`) : null;
  const rangeEnd = dateRange.to ? Date.parse(`${dateRange.to}T23:59:59Z`) : null;
  const label = keyword ? `TikTok.com · search · “${keyword}”` : 'TikTok.com · Explore';

  const matches = (video) => {
    if (tokens.length) {
      const haystack = `${video.caption} ${video.hashtags.join(' ')} ${video.creator.username ?? ''} ${video.creator.displayName} ${video.soundName ?? ''}`.toLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) return false;
    }
    if (rangeStart == null && rangeEnd == null) return true;
    if (!video.publishedAt) return false;               // never guess a date
    const time = Date.parse(video.publishedAt);
    return (rangeStart == null || time >= rangeStart) && (rangeEnd == null || time <= rangeEnd);
  };

  const collected = new Map();
  const add = (raw) => {
    const video = normalizeTikTokItem(raw, label);
    if (video && !collected.has(video.id)) collected.set(video.id, video);
  };

  let browser;
  try {
    browser = await puppeteer.launch(env.MYBROWSER);
    const page = await browser.newPage();

    page.on('response', async (response) => {
      try {
        if (!TIKTOK_LIST_PATTERN.test(response.url())) return;
        itemsFromListBody(safeParse(await response.text())).forEach(add);
      } catch { /* partial or non-JSON body */ }
    });

    // Warm-up: pick up ttwid / msToken from the public homepage.
    await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const target = keyword
      ? `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`
      : 'https://www.tiktok.com/explore';
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const embedded = await page.evaluate(() =>
      document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent
      ?? document.getElementById('SIGI_STATE')?.textContent ?? null).catch(() => null);
    if (embedded) collectEmbeddedItems(embedded).forEach(add);

    const fresh = () => [...collected.values()].filter((video) => matches(video) && !knownIds.has(video.id));

    let stagnant = 0;
    let previous = collected.size;
    for (let round = 0; round < 14 && fresh().length < want && stagnant < 5; round += 1) {
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      stagnant = collected.size === previous ? stagnant + 1 : 0;
      previous = collected.size;
    }

    const batch = fresh().slice(0, want);
    if (!batch.length && !knownIds.size) {
      const body = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '');
      if (/verify|captcha|robot/i.test(body)) {
        throw Object.assign(new Error('TikTok served a verification page to this Worker. Try again shortly.'), { code: 'tiktok_captcha', status: 429 });
      }
      throw Object.assign(new Error(keyword ? `TikTok returned no public videos for “${keyword}”.` : 'TikTok returned no public videos.'), { code: 'tiktok_empty', status: 502 });
    }
    return { videos: batch, hasMore: stagnant < 5, scanned: collected.size };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function proxyVideo(request, url) {
  let target;
  try { target = new URL(String(url.searchParams.get('src') ?? '')); }
  catch { return fail(400, 'bad_src', 'src must be an absolute URL'); }
  if (target.protocol !== 'https:' || !VIDEO_HOST.test(target.hostname)) {
    return fail(403, 'host_not_allowed', 'Only TikTok CDN hosts can be proxied');
  }
  const headers = { 'user-agent': UA, referer: 'https://www.tiktok.com/', 'accept-language': 'en-US,en;q=0.9' };
  const range = request.headers.get('range');
  if (range) headers.range = range;

  const upstream = await fetch(target, { headers });
  const out = new Headers(CORS);
  for (const name of ['content-type', 'content-range', 'accept-ranges', 'content-length']) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/** Routes that need Playwright live on the Node backend, if one is configured. */
async function proxyBackend(request, url, env) {
  const base = String(env.BACKEND_URL ?? '').replace(/\/+$/, '');
  if (!base) {
    return fail(501, 'backend_not_configured',
      'Keyword search and Top Ads need the Node scraping backend, which cannot run on Cloudflare (it drives a real Chromium). Deploy backend/ and set the BACKEND_URL variable on this Worker. Country trends via "Fetch trends" work here without any backend.',
      { needs: 'BACKEND_URL', worksWithoutBackend: ['/api/fetch', '/api/video', '/api/health'] });
  }
  const target = `${base}${url.pathname}${url.search}`;
  try {
    const upstream = await fetch(target, { headers: { accept: 'application/json', 'user-agent': 'tiktoktrend-worker' } });
    const text = await upstream.text();
    const contentType = upstream.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return fail(502, 'backend_bad_response', 'The configured BACKEND_URL did not return JSON. Check that it points at the Node backend.');
    }
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
    });
  } catch (error) {
    return fail(502, 'backend_unreachable', `Could not reach the backend at ${base}: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

async function handleApi(request, env, url) {
  const path = url.pathname;

  if (path === '/api/health') {
    return json({
      status: 'ok',
      service: 'tiktoktrend-worker',
      runtime: 'cloudflare-workers',
      persistentProfile: false,
      backendConfigured: Boolean(env.BACKEND_URL),
      browserRendering: Boolean(env.MYBROWSER),
      nativeRoutes: ['/api/health', '/api/fetch', '/api/video', ...(env.MYBROWSER ? ['/api/fetch-tiktok'] : [])],
      proxiedRoutes: [...(env.MYBROWSER ? [] : ['/api/fetch-tiktok']), '/api/fetch-ads', '/api/progress', '/api/datasets'],
      time: new Date().toISOString(),
    });
  }

  if (path === '/api/fetch') {
    const region = String(url.searchParams.get('region') ?? 'US').toUpperCase();
    const period = String(url.searchParams.get('period') ?? '7');
    if (!ALLOWED_REGIONS.has(region) || !ALLOWED_PERIODS.has(period)) {
      return fail(400, 'bad_params', 'Unsupported region or period');
    }
    try {
      const videos = await fetchTrends(region, period);
      return json({
        videos, hasMore: false, scanned: videos.length,
        source: `TikTok Creative Center trends · ${region}`,
        region, period, keyword: null, fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      return fail(error.status ?? 502, error.code ?? 'trends_failed', error.message ?? 'Trend fetch failed');
    }
  }

  if (path === '/api/video') return proxyVideo(request, url);

  if (path === '/api/progress' && !env.BACKEND_URL) {
    // Never 404 the poller — it runs on a timer in the UI.
    return json({ active: false, phase: 'idle', collected: 0, matched: 0, target: 0, startedAt: null, keyword: null });
  }
  if (path === '/api/datasets' && !env.BACKEND_URL) return json({ videos: null, ads: null });

  if (path === '/api/fetch-tiktok' && env.MYBROWSER) {
    const keyword = String(url.searchParams.get('q') ?? '').trim().slice(0, 80);
    const want = Math.min(60, Math.max(5, Number(url.searchParams.get('count') ?? 40) || 40));
    const knownIds = new Set(String(url.searchParams.get('known') ?? '').split(',').map((id) => id.trim()).filter(Boolean));
    const dateRange = {
      from: /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('from') ?? '') ? url.searchParams.get('from') : null,
      to: /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('to') ?? '') ? url.searchParams.get('to') : null,
    };
    try {
      const result = await searchWithBrowser(env, { keyword, want, knownIds, dateRange });
      return json({
        ...result,
        source: keyword ? `TikTok.com search · “${keyword}”` : 'TikTok.com Explore feed',
        keyword: keyword || null,
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      // Fall through to a configured backend rather than failing outright.
      if (env.BACKEND_URL) return proxyBackend(request, url, env);
      return fail(error.status ?? 502, error.code ?? 'search_failed', error.message ?? 'Search failed');
    }
  }

  if (['/api/fetch-tiktok', '/api/fetch-ads', '/api/progress', '/api/datasets'].includes(path)) {
    return proxyBackend(request, url, env);
  }

  return fail(404, 'not_found', `Unknown endpoint ${path}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (request.method !== 'GET') return fail(405, 'method_not_allowed', 'Only GET is supported');
      try {
        return await handleApi(request, env, url);
      } catch (error) {
        return fail(500, 'internal_error', error instanceof Error ? error.message : 'Unexpected worker error');
      }
    }

    return env.ASSETS.fetch(request);
  },
};
