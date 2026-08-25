import { Readable } from 'node:stream';
import { config } from './config.mjs';
import { ApiError, applyCors, sendError, sendJson, withTimeout } from './http.mjs';
import { USER_AGENT } from './browser.mjs';
import { fetchTikTokBatch, getCookieHeader, progress } from './tiktok.mjs';
import { ALLOWED_PERIODS, ALLOWED_REGIONS, fetchTopAds, fetchTrends } from './creative-center.mjs';

const startedAt = Date.now();
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const clampInt = (value, min, max, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
};

// The last successful video/ads payloads, held in memory so a page reload has
// something to show immediately. This is REAL scraped data, never sample data,
// and it is replaced on every fresh fetch.
const lastPayload = { videos: null, ads: null };

const VIDEO_HOST = /(^|\.)((tiktokcdn(-us|-eu)?\.com)|(tiktok\.com)|(tiktokv\.com)|(ibytedtos\.com)|(ttwstatic\.com)|(byteoversea\.com))$/;

async function proxyVideo(request, response, src) {
  let target;
  try { target = new URL(src); } catch { throw new ApiError(400, 'bad_src', 'src must be an absolute URL'); }
  if (target.protocol !== 'https:' || !VIDEO_HOST.test(target.hostname)) {
    throw new ApiError(403, 'host_not_allowed', 'Only TikTok CDN hosts can be proxied');
  }
  const headers = { 'user-agent': USER_AGENT, referer: 'https://www.tiktok.com/', 'accept-language': 'en-US,en;q=0.9' };
  const cookie = getCookieHeader();
  if (cookie) headers.cookie = cookie;
  if (request.headers.range) headers.range = request.headers.range;

  const upstream = await fetch(target, { headers });
  const passthrough = {};
  for (const name of ['content-type', 'content-range', 'accept-ranges']) {
    const value = upstream.headers.get(name);
    if (value) passthrough[name] = value;
  }
  if (!upstream.headers.get('content-encoding')) {
    const length = upstream.headers.get('content-length');
    if (length) passthrough['content-length'] = length;
  }
  response.writeHead(upstream.status, passthrough);
  if (upstream.body) Readable.fromWeb(upstream.body).pipe(response);
  else response.end();
}

async function route(request, response, url) {
  const path = url.pathname;

  if (path === '/api/health') {
    return sendJson(response, 200, {
      status: 'ok',
      service: 'tiktoktrend-backend',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      nodeEnv: config.nodeEnv,
      scraper: 'playwright-chromium',
      persistentProfile: false,
      allowedOrigins: config.allowedOrigins,
      time: new Date().toISOString(),
    });
  }

  if (path === '/api/progress') return sendJson(response, 200, progress);

  if (path === '/api/datasets') {
    return sendJson(response, 200, { videos: lastPayload.videos, ads: lastPayload.ads });
  }

  if (path === '/api/video') {
    return proxyVideo(request, response, String(url.searchParams.get('src') ?? ''));
  }

  if (path === '/api/fetch-tiktok') {
    const keyword = String(url.searchParams.get('q') ?? '').trim().slice(0, 80);
    const mode = keyword ? 'search' : 'explore';
    const want = clampInt(url.searchParams.get('count'), 5, config.maxBatch, 40);
    const fresh = url.searchParams.get('more') !== '1';
    const knownIds = String(url.searchParams.get('known') ?? '').split(',').map((id) => id.trim()).filter(Boolean).slice(0, 1000);
    const dateRange = {
      from: DATE.test(url.searchParams.get('from') ?? '') ? url.searchParams.get('from') : null,
      to: DATE.test(url.searchParams.get('to') ?? '') ? url.searchParams.get('to') : null,
    };

    const result = await withTimeout(
      fetchTikTokBatch({ mode, keyword, want, dateRange, fresh, knownIds }),
      config.requestTimeoutMs,
      'TikTok did not answer in time. Try again, or lower the page size.',
    );

    const payload = {
      videos: result.videos,
      hasMore: result.hasMore,
      scanned: result.scanned,
      source: mode === 'search' ? `TikTok.com search · “${keyword}”` : 'TikTok.com Explore feed',
      keyword: keyword || null,
      fetchedAt: new Date().toISOString(),
    };
    if (fresh) lastPayload.videos = payload;
    else if (lastPayload.videos && (lastPayload.videos.keyword ?? null) === (keyword || null)) {
      const known = new Set(lastPayload.videos.videos.map((video) => String(video.id)));
      const merged = [...lastPayload.videos.videos, ...result.videos.filter((video) => !known.has(String(video.id)))];
      lastPayload.videos = { ...lastPayload.videos, videos: merged.slice(-600), hasMore: result.hasMore, scanned: result.scanned };
    }
    return sendJson(response, 200, payload);
  }

  // Region/period guarded routes.
  const region = String(url.searchParams.get('region') ?? 'US').toUpperCase();
  const period = String(url.searchParams.get('period') ?? '7');

  if (path === '/api/fetch') {
    if (!ALLOWED_REGIONS.has(region) || !ALLOWED_PERIODS.has(period)) {
      throw new ApiError(400, 'bad_params', 'Unsupported region or period');
    }
    const videos = await withTimeout(fetchTrends(region, period), config.requestTimeoutMs, 'Creative Center timed out.');
    const payload = {
      videos, hasMore: false, scanned: videos.length,
      source: `TikTok Creative Center trends · ${region}`,
      region, period, keyword: null, fetchedAt: new Date().toISOString(),
    };
    lastPayload.videos = payload;
    return sendJson(response, 200, payload);
  }

  if (path === '/api/fetch-ads') {
    const adsPeriod = ALLOWED_PERIODS.has(period) ? period : '30';
    if (!ALLOWED_REGIONS.has(region)) throw new ApiError(400, 'bad_params', 'Unsupported region');
    const keyword = String(url.searchParams.get('keyword') ?? '').slice(0, 80);
    const videos = await withTimeout(fetchTopAds(region, adsPeriod, keyword), config.requestTimeoutMs, 'Top Ads timed out.');
    const payload = {
      videos, hasMore: false, scanned: videos.length,
      source: `TikTok Creative Center Top Ads · ${region}`,
      region, period: adsPeriod, keyword: keyword || null, fetchedAt: new Date().toISOString(),
    };
    lastPayload.ads = payload;
    return sendJson(response, 200, payload);
  }

  throw new ApiError(404, 'not_found', `Unknown endpoint ${path}`);
}

/**
 * Handles every /api/* request. Returns true when it took ownership of the
 * response so a host (the dev server) can fall through to its own middleware.
 */
export async function handleApiRequest(request, response) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) return false;

  applyCors(request, response);
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return true; }
  if (request.method !== 'GET') { sendError(response, 405, 'method_not_allowed', 'Only GET is supported'); return true; }

  try {
    await route(request, response, url);
  } catch (error) {
    if (response.headersSent) { try { response.end(); } catch { /* already closed */ } return true; }
    if (error instanceof ApiError) sendError(response, error.status, error.code, error.message, error.extra);
    else {
      console.error('[api] unhandled error', error);
      sendError(response, 500, 'internal_error', error instanceof Error ? error.message : 'Unexpected server error');
    }
  }
  return true;
}
