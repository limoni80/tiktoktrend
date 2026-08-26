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
  /\/api\/(explore\/item_list|recommend\/item_list|challenge\/item_list|search\/general\/full|search\/item\/full|search\/video\/full|search\/general\/preview|item\/detail|related\/item_list)\//;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const TRENDS_HOSTS = ['ads.us.tiktok.com', 'ads.tiktok.com', 'ads-sg.tiktok.com'];
const CONTENT_LABELS = ['11001','11002','11003','11004','11005','11007','11008','11009','11010','11013','11014','11015'];
const ALLOWED_REGIONS = new Set(['US','FR','DE','IT','ES','GB','AR','AU','BR','CA','CO','EG','ID','IL','JP','KR','MY','MX','PH','SA','SG','ZA','TW','TH','TR','AE','VN']);
const ALLOWED_PERIODS = new Set(['7', '30']);
/**
 * Cloudflare Browser Rendering (free plan) allows only **2 concurrent browsers
 * and 2 new browsers per minute per account**. Launching one per search burns
 * that budget instantly, so:
 *   1. an idle session is always reused before launching (a reuse is free),
 *   2. a 429 is retried with backoff instead of being thrown at the user,
 *   3. results are cached, and a cached copy is served when the quota is gone.
 */
const BROWSER_KEEP_ALIVE_MS = 600_000;   // keep the browser hot for reuse
const BROWSER_ACQUIRE_BUDGET_MS = 40_000; // how long we wait out a 429
const SEARCH_CACHE_FRESH_S = 120;         // serve a cached search without a browser
const SEARCH_CACHE_MAX_S = 3_600;         // keep it this long as a 429 fallback

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const VIDEO_HOST =/(^|\.)((tiktokcdn(-us|-eu)?\.com)|(tiktok\.com)|(tiktokv\.com)|(ibytedtos\.com)|(ttwstatic\.com)|(byteoversea\.com))$/;

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
/**
 * Get a browser without tripping the "2 new browsers per minute" limit.
 *
 * Reusing an idle session costs nothing against the quota, so that is always
 * tried first. Only if none is free do we launch — and a rate-limit answer is
 * waited out (a new slot frees up within ~30 s) rather than thrown straight at
 * the user, because in practice the wait is shorter than a retry by hand.
 */
async function acquireBrowser(env, debug) {
  const startedAt = Date.now();
  const deadline = startedAt + BROWSER_ACQUIRE_BUDGET_MS;
  const trail = [];
  let attempt = 0;
  let lastRateLimitDetail = null;

  while (Date.now() < deadline) {
    attempt += 1;

    // 1. Reuse an idle session — free, and much faster than a cold launch.
    try {
      const sessions = await puppeteer.sessions(env.MYBROWSER);
      const free = sessions.filter((session) => !session.connectionId);
      trail.push(`attempt ${attempt}: ${sessions.length} session(s), ${free.length} free`);
      for (const session of free) {
        try {
          const browser = await puppeteer.connect(env.MYBROWSER, session.sessionId);
          debug.browserAcquire = { reused: true, attempts: attempt, waitedMs: Date.now() - startedAt, trail };
          return { browser, reused: true };
        } catch { /* someone else grabbed it — try the next */ }
      }
    } catch (listError) {
      trail.push(`attempt ${attempt}: session list failed (${String(listError?.message ?? listError).slice(0, 80)})`);
    }

    // 2. Launch a new one.
    try {
      const browser = await puppeteer.launch(env.MYBROWSER, { keep_alive: BROWSER_KEEP_ALIVE_MS });
      debug.browserAcquire = { reused: false, attempts: attempt, waitedMs: Date.now() - startedAt, trail };
      return { browser, reused: false };
    } catch (launchError) {
      const detail = String(launchError?.message ?? launchError);
      if (!/429|rate limit|concurrent|limit exceeded/i.test(detail)) {
        debug.browserAcquire = { reused: false, attempts: attempt, waitedMs: Date.now() - startedAt, trail, error: detail.slice(0, 200) };
        throw Object.assign(new Error(`Could not start a browser: ${detail}`), { code: 'browser_unavailable', status: 502, debug });
      }
      lastRateLimitDetail = detail.slice(0, 160);
      trail.push(`attempt ${attempt}: launch rate limited`);
      const wait = Math.min(9_000, 3_000 * attempt);
      if (Date.now() + wait >= deadline) break;
      await sleep(wait);
    }
  }

  const waitedMs = Date.now() - startedAt;
  debug.browserAcquire = { reused: false, attempts: attempt, waitedMs, trail, error: lastRateLimitDetail };
  throw Object.assign(
    new Error(`Cloudflare Browser Rendering is out of browser slots (free plan: 2 browsers, 2 launches per minute per account). Waited ${Math.round(waitedMs / 1000)}s and retried ${attempt}×. Wait a minute and search again — country trends need no browser and keep working.`),
    { code: 'browser_rate_limited', status: 429, debug },
  );
}

async function searchWithBrowser(env, { keyword, want, knownIds, dateRange }) {
  const tokens = keyword.toLowerCase().split(/\s+/).filter(Boolean);
  const rangeStart = dateRange.from ? Date.parse(`${dateRange.from}T00:00:00Z`) : null;
  const rangeEnd = dateRange.to ? Date.parse(`${dateRange.to}T23:59:59Z`) : null;
  const label = keyword ? `TikTok.com · search · “${keyword}”` : 'TikTok.com · Explore';

  /**
   * "trumps" must still match a caption that says "Trump", so a token also
   * matches its singular stem. Only a real word is stemmed (>= 5 chars), so
   * short keywords keep matching exactly.
   */
  const hasToken = (haystack, token) => {
    if (haystack.includes(token)) return true;
    if (token.length >= 5) {
      const stem = token.replace(/(ies|es|s)$/, '');
      if (stem.length >= 4 && haystack.includes(stem)) return true;
    }
    return false;
  };

  /**
   * Where each video came from. Items served by TikTok's own search or hashtag
   * endpoints are already relevance-ranked by TikTok, so they are kept even
   * when the keyword never appears literally in the caption. Items from the
   * generic recommendation feed are not, and must match the keyword.
   */
  const sources = new Map();

  const matches = (video) => {
    const trusted = sources.get(video.id) === 'search';
    if (tokens.length && !trusted) {
      const haystack = `${video.caption} ${video.hashtags.join(' ')} ${video.creator.username ?? ''} ${video.creator.displayName} ${video.soundName ?? ''}`.toLowerCase();
      if (!tokens.every((token) => hasToken(haystack, token))) return false;
    }
    if (rangeStart == null && rangeEnd == null) return true;
    if (!video.publishedAt) return false;               // never guess a date
    const time = Date.parse(video.publishedAt);
    return (rangeStart == null || time >= rangeStart) && (rangeEnd == null || time <= rangeEnd);
  };

  const collected = new Map();
  const add = (raw, source = 'feed') => {
    const video = normalizeTikTokItem(raw, label);
    if (!video) return;
    if (!collected.has(video.id)) collected.set(video.id, video);
    if (source === 'search' || !sources.has(video.id)) sources.set(video.id, source);
  };

  // Diagnostics: returned with every search so a failure can be read off the
  // response instead of guessed at.
  const debug = {
    keyword, want, knownIds: knownIds.size, dateRange,
    reusedSession: false, strategies: [], apiHits: {},
    collectedTotal: 0, matchedTotal: 0, fromSearchEndpoints: 0,
    loginWall: false, captchaWall: false, bodySnippet: null, sampleCaptions: [],
    startedAt: new Date().toISOString(), tookMs: 0,
  };
  const startedMs = Date.now();

  let browser;
  let reused = false;
  try {
    const acquired = await acquireBrowser(env, debug);
    browser = acquired.browser;
    reused = acquired.reused;

    const page = await browser.newPage();

    // Which endpoint a batch of items came from decides whether it is trusted
    // as a keyword match: /api/search/... and /api/challenge/... are targeted,
    // /api/recommend/... is the generic "For You" feed.
    const endpointSource = (pathname) => (/\/(search|challenge)\//.test(pathname) ? 'search' : 'feed');

    page.on('response', async (response) => {
      try {
        const responseUrl = response.url();
        if (!TIKTOK_LIST_PATTERN.test(responseUrl)) return;
        const key = new URL(responseUrl).pathname;
        const source = endpointSource(key);
        const before = collected.size;
        itemsFromListBody(safeParse(await response.text())).forEach((item) => add(item, source));
        const gained = collected.size - before;
        debug.apiHits[key] = debug.apiHits[key] ?? { calls: 0, items: 0, source };
        debug.apiHits[key].calls += 1;
        debug.apiHits[key].items += gained;
        if (source === 'search') debug.fromSearchEndpoints += gained;
      } catch { /* partial or non-JSON body */ }
    });

    // Warm-up: pick up ttwid / msToken from the public homepage.
    await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const fresh = () => [...collected.values()].filter((video) => matches(video) && !knownIds.has(video.id));

    // TikTok does not always serve /search to a datacentre IP. Try the search
    // page, then the video-only search tab, then the hashtag page — each is a
    // different endpoint, and the first one that yields matches wins.
    const slug = keyword.replace(/[^a-z0-9]+/gi, '').toLowerCase();
    const plan = keyword
      ? [
          { name: 'search', url: `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`, trusted: true },
          { name: 'search-video-tab', url: `https://www.tiktok.com/search/video?q=${encodeURIComponent(keyword)}`, trusted: true },
          ...(slug ? [{ name: 'hashtag', url: `https://www.tiktok.com/tag/${encodeURIComponent(slug)}`, trusted: true }] : []),
        ]
      : [{ name: 'explore', url: 'https://www.tiktok.com/explore', trusted: false }];

    let stagnant = 0;

    for (const step of plan) {
      const stepStarted = Date.now();
      const record = { name: step.name, url: step.url, finalUrl: null, title: null, scrollRounds: 0, collectedAfter: 0, matchedAfter: 0, error: null, tookMs: 0 };
      debug.strategies.push(record);

      try {
        await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        record.finalUrl = await page.url();
        record.title = await page.title().catch(() => null);

        const embedded = await page.evaluate(() =>
          document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent
          ?? document.getElementById('SIGI_STATE')?.textContent ?? null).catch(() => null);
        if (embedded) collectEmbeddedItems(embedded).forEach((item) => add(item, step.trusted ? 'search' : 'feed'));

        stagnant = 0;
        let previous = collected.size;
        for (let round = 0; round < 14 && fresh().length < want && stagnant < 5; round += 1) {
          await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)).catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, 1_100));
          stagnant = collected.size === previous ? stagnant + 1 : 0;
          previous = collected.size;
          record.scrollRounds = round + 1;
        }

        const body = await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => '');
        debug.bodySnippet = body.replace(/\s+/g, ' ').slice(0, 300);
        if (/log in|sign up|se connecter/i.test(body)) debug.loginWall = true;
        if (/verify to continue|captcha|are a robot|security check/i.test(body)) debug.captchaWall = true;
      } catch (stepError) {
        record.error = String(stepError?.message ?? stepError).slice(0, 200);
      }

      record.collectedAfter = collected.size;
      record.matchedAfter = fresh().length;
      record.tookMs = Date.now() - stepStarted;

      if (record.matchedAfter >= Math.min(want, 1)) break;      // this route worked
      if (debug.captchaWall) break;                             // no point retrying
    }

    debug.reusedSession = reused;
    debug.collectedTotal = collected.size;
    debug.matchedTotal = fresh().length;
    debug.sampleCaptions = [...collected.values()].slice(0, 5)
      .map((video) => `[${sources.get(video.id)}] @${video.creator.username ?? '?'}: ${String(video.caption).slice(0, 70)}`);
    debug.tookMs = Date.now() - startedMs;

    const batch = fresh().slice(0, want);
    if (!batch.length && !knownIds.size) {
      if (debug.captchaWall) {
        throw Object.assign(new Error('TikTok served a verification page to this Worker. Try again shortly.'), { code: 'tiktok_captcha', status: 429, debug });
      }
      // The browser worked but nothing matched: say which of the two it was.
      const why = collected.size === 0
        ? `TikTok served no video data at all for “${keyword}” (last page title: ${debug.strategies.at(-1)?.title ?? 'unknown'}${debug.loginWall ? ', login wall detected' : ''}).`
        : debug.fromSearchEndpoints === 0
          ? `TikTok loaded ${collected.size} videos but never answered a search request — only its generic feed was served to this Worker, so nothing matches “${keyword}”.`
          : `TikTok returned ${debug.fromSearchEndpoints} search results, but none of them are inside the selected date range for “${keyword}”.`;
      throw Object.assign(new Error(why), { code: 'tiktok_empty', status: 502, debug });
    }
    return { videos: batch, hasMore: stagnant < 5, scanned: collected.size, reusedSession: reused, debug };
  } finally {
    // disconnect() leaves the browser running so the next request can reuse it;
    // close() would force the next one to launch and burn the launch quota.
    if (browser) await browser.disconnect().catch(() => {});
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

/** Cache key for a first-page search. Pagination is never cached. */
const searchCacheKey = (keyword, dateRange, want) => new Request(
  `https://pulse-search-cache.internal/?q=${encodeURIComponent(keyword)}&from=${dateRange.from ?? ''}&to=${dateRange.to ?? ''}&n=${want}`,
);

async function readSearchCache(cache, key) {
  try {
    const hit = await cache.match(key);
    if (!hit) return null;
    const payload = await hit.json();
    const fetchedAt = Date.parse(payload?.fetchedAt ?? '');
    if (!Number.isFinite(fetchedAt)) return null;
    const ageSeconds = Math.max(0, Math.round((Date.now() - fetchedAt) / 1000));
    if (ageSeconds > SEARCH_CACHE_MAX_S) return null;
    return { payload, ageSeconds };
  } catch { return null; }
}

async function handleApi(request, env, url, ctx) {
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
    // Only first pages are cached: a "load more" call depends on ids the client
    // already holds, so it is never the same answer twice.
    const cacheable = knownIds.size === 0;
    const cacheKey = searchCacheKey(keyword, dateRange, want);
    const cache = caches.default;
    const cached = cacheable ? await readSearchCache(cache, cacheKey) : null;

    // A repeat of the same search within two minutes is answered from cache —
    // that is one browser launch saved out of the two the free plan allows.
    if (cached && cached.ageSeconds <= SEARCH_CACHE_FRESH_S) {
      return json({ ...cached.payload, cached: true, cacheAgeSeconds: cached.ageSeconds });
    }

    try {
      const result = await searchWithBrowser(env, { keyword, want, knownIds, dateRange });
      const payload = {
        ...result,
        source: keyword ? `TikTok.com search · “${keyword}”` : 'TikTok.com Explore feed',
        keyword: keyword || null,
        fetchedAt: new Date().toISOString(),
      };
      if (cacheable && payload.videos?.length) {
        const stored = cache.put(cacheKey, new Response(JSON.stringify(payload), {
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `max-age=${SEARCH_CACHE_MAX_S}` },
        })).catch(() => {});
        if (ctx?.waitUntil) ctx.waitUntil(stored); else await stored;
      }
      return json(payload);
    } catch (error) {
      // Fall through to a configured backend rather than failing outright.
      if (env.BACKEND_URL) return proxyBackend(request, url, env);

      // Out of browser quota but we ran this exact search recently: show that
      // result, clearly labelled with its age, instead of an empty screen.
      if (error.code === 'browser_rate_limited' && cached) {
        return json({
          ...cached.payload,
          cached: true,
          stale: true,
          cacheAgeSeconds: cached.ageSeconds,
          notice: `Cloudflare's browser quota is used up right now, so these are the results from ${Math.round(cached.ageSeconds / 60)} min ago. Search again in a minute for fresh ones.`,
          debug: { ...(error.debug ?? {}), servedFromCache: true },
        });
      }
      return fail(error.status ?? 502, error.code ?? 'search_failed', error.message ?? 'Search failed',
        error.debug ? { debug: error.debug } : {});
    }
  }

  if (['/api/fetch-tiktok', '/api/fetch-ads', '/api/progress', '/api/datasets'].includes(path)) {
    return proxyBackend(request, url, env);
  }

  return fail(404, 'not_found', `Unknown endpoint ${path}`);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (request.method !== 'GET') return fail(405, 'method_not_allowed', 'Only GET is supported');
      try {
        return await handleApi(request, env, url, ctx);
      } catch (error) {
        return fail(500, 'internal_error', error instanceof Error ? error.message : 'Unexpected worker error');
      }
    }

    return env.ASSETS.fetch(request);
  },
};
