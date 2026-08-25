import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { createServer as createViteServer } from 'vite';

const PORT = Number(process.env.PORT ?? 4173);
const CHROME_PATH = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ALLOWED_REGIONS = new Set(['US','FR','DE','IT','ES','GB','AR','AU','BR','CA','CO','EG','ID','IL','JP','KR','MY','MX','PH','SA','SG','ZA','TW','TH','TR','AE','VN']);
const ALLOWED_PERIODS = new Set(['7', '30']);
const DATA_DIR = path.join(process.cwd(), 'data');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// TikTok One Creative Suite content categories (verified against the live page)
const CONTENT_LABELS = [
  ['', 'All'], ['11001', 'Nature & Animals'], ['11002', 'Beauty & Care'], ['11003', 'Fashion'],
  ['11004', 'Music & Entertainment'], ['11005', 'Games'], ['11007', 'Sports & Outdoor'],
  ['11008', 'Creativity & Talent'], ['11009', 'Family & Relationship'], ['11010', 'Food & Beverage'],
  ['11013', 'Lifestyle & Leisure'], ['11014', 'Vehicles & Transportation'], ['11015', 'Technology & Finance'],
];
const TRENDS_HOSTS = ['ads.us.tiktok.com', 'ads.tiktok.com', 'ads-sg.tiktok.com'];

let browserPromise;
const CHROME_ARGS = ['--disable-blink-features=AutomationControlled', '--disk-cache-size=52428800', '--media-cache-size=52428800'];
const getBrowser = () => browserPromise ??= chromium.launch({ executablePath: CHROME_PATH, headless: true, args: CHROME_ARGS });
const idFor = (value) => createHash('sha256').update(value).digest('hex').slice(0, 18);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// JSON.parse loses precision on 64-bit TikTok ids — quote them before parsing.
const safeParse = (text) => JSON.parse(String(text).replace(/"(itemID|authorID|creatorID|id)"\s*:\s*(\d{15,})/g, '"$1":"$2"'));

const ensureDataDir = () => { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); };
const saveDataset = (kind, payload) => {
  try { ensureDataDir(); fs.writeFileSync(path.join(DATA_DIR, `last-${kind}.json`), JSON.stringify(payload, null, 2)); }
  catch (error) { console.warn(`Could not persist ${kind} dataset:`, error.message); }
};
const readDataset = (kind) => {
  try {
    const file = path.join(DATA_DIR, `last-${kind}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  } catch { return null; }
};

const extractHashtags = (text) => [...new Set(String(text ?? '').match(/#[\p{L}\p{N}_]+/gu)?.map((tag) => tag.slice(1)) ?? [])];
const humanizeKey = (key, prefix) => {
  const raw = String(key ?? '').replace(prefix, '').replaceAll('_', ' ').trim();
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : null;
};

// ---------------------------------------------------------------------------
// Organic trend videos — TikTok One Creative Suite JSON API (no login, no key)
// ---------------------------------------------------------------------------

async function directJson(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json', referer: 'https://ads.tiktok.com/', origin: 'https://ads.tiktok.com', 'accept-language': 'en-US,en;q=0.9' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return safeParse(await response.text());
}

async function pickTrendsHost() {
  for (const host of TRENDS_HOSTS) {
    try {
      const overview = await directJson(`https://${host}/CreativeOne/Report/GetTopContentsOverview`);
      if (overview?.BaseResp?.StatusCode === 0) return { host, overview, viaBrowser: false };
    } catch { /* try next host */ }
  }
  return null;
}

async function browserTrendsTransport(region, period) {
  // Fallback: let the real page pick the right host, then reuse its own request URL template.
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', userAgent: UA });
  const page = await context.newPage();
  let template = null;
  page.on('request', (request) => { if (request.url().includes('CreativeCenterGetTopContentsList') && !template) template = request.url(); });
  await page.goto(`https://ads.tiktok.com/creative/creativeCenter/trends/video?region=${region}&period=${period}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => performance.getEntriesByType('resource').some((entry) => entry.name.includes('CreativeCenterGetTopContentsList')), undefined, { timeout: 20_000 }).catch(() => {});
  if (!template) template = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name).find((name) => name.includes('CreativeCenterGetTopContentsList')) ?? null);
  if (!template) { await context.close(); throw new Error('Trends API request not observed on the public page'); }
  const query = async (url) => safeParse(await page.evaluate(async (target) => await (await fetch(target, { credentials: 'omit' })).text(), url));
  const overview = await query(template.replace('CreativeCenterGetTopContentsList', 'GetTopContentsOverview').split('?')[0]);
  return { template, query, overview, close: () => context.close() };
}

function normalizeTrendEntity(entity, region) {
  const item = entity?.itemInfo ?? {};
  const author = entity?.itemAuthorInfo ?? {};
  const metrics = entity?.itemMetrics ?? {};
  const id = String(item.itemID ?? '').trim();
  if (!id) return null;
  const username = String(author.handlerName ?? '').trim() || null;
  const views = metrics.videoViewsLifeTime ?? metrics.organicVideoViewsLifeTime ?? metrics.videoViews ?? metrics.organicVideoViews ?? null;
  const periodViews = metrics.videoViews ?? metrics.organicVideoViews ?? null;
  const engagement = metrics.engagementRateLifeTime ?? metrics.engagementRate ?? null;
  return {
    id,
    kind: 'organic',
    url: username ? `https://www.tiktok.com/@${username}/video/${id}` : `https://ads.tiktok.com/creative/creativeCenter/trends/video?region=${region}`,
    caption: String(item.title ?? ''),
    thumbnailUrl: item.coverURL ?? item.coverURLList?.[0] ?? null,
    publishedAt: item.createTime ? new Date(Number(item.createTime) * 1000).toISOString() : null,
    durationSeconds: null,
    views: views == null ? null : Math.round(views),
    periodViews: periodViews == null ? null : Math.round(periodViews),
    likes: null, comments: null, shares: null, saves: null,
    sourceEngagementRate: engagement == null ? null : engagement * 100,
    vtr: metrics.sixSecondsVTRLifeTime == null ? null : metrics.sixSecondsVTRLifeTime * 100,
    creator: {
      username,
      displayName: String(author.nickName ?? username ?? 'Creator unavailable'),
      profileUrl: username ? `https://www.tiktok.com/@${username}` : 'https://ads.tiktok.com/creative/creativeCenter/trends/video',
      avatarUrl: author.avatarURI ?? null,
      followers: entity?.itemAuthorMetrics?.followers ?? null,
      following: null, totalLikes: null,
      country: region,
      verified: false,
    },
    hashtags: extractHashtags(item.title),
    topic: (entity?.contentTags ?? []).map((tag) => tag.contentLabelName).filter(Boolean).join(', ') || null,
    soundName: null, soundAuthor: null, soundId: null,
    collectedAt: new Date().toISOString(),
    viewsPerHour: null, likesPerHour: null,
    videoFileUrl: item.videoURL ?? null,
    source: `TikTok Creative Center · ${region} · trends`,
  };
}

async function fetchTrends(region, period) {
  const collected = new Map();
  const orders = ['1', '2', '3'];
  const runSweep = async (buildUrl, query, overview) => {
    const endTs = period === '30'
      ? overview?.lastMonthlyEndTimestamp ?? overview?.lastWeeklyEndTimestamp
      : overview?.lastWeeklyEndTimestamp ?? overview?.lastDailyEndTimestamp;
    const dimension = period === '30' ? '5' : '3';
    const jobs = [];
    for (const order of orders) jobs.push({ label: '', order });
    for (const [label] of CONTENT_LABELS.slice(1)) jobs.push({ label, order: '1' });
    for (const job of jobs) {
      try {
        const url = buildUrl({ contentLabelIDs: job.label, countryCode: region, limit: '20', orderByMetric: job.order, organicOnly: 'false', page: '1', periodDimension: dimension, periodEndTimestamp: String(endTs ?? '') });
        const result = await query(url);
        if (result?.BaseResp?.StatusCode !== 0) continue;
        for (const entity of result?.entityInfos ?? []) {
          const video = normalizeTrendEntity(entity, region);
          if (video && !collected.has(video.id)) collected.set(video.id, video);
        }
        await sleep(120);
      } catch { /* keep sweeping */ }
    }
  };

  const direct = await pickTrendsHost();
  if (direct) {
    const buildUrl = (params) => `https://${direct.host}/CreativeOne/Report/CreativeCenterGetTopContentsList?${new URLSearchParams(params)}`;
    await runSweep(buildUrl, directJson, direct.overview);
  } else {
    const transport = await browserTrendsTransport(region, period);
    try {
      const base = transport.template.split('?')[0];
      const buildUrl = (params) => `${base}?${new URLSearchParams(params)}`;
      await runSweep(buildUrl, transport.query, transport.overview);
    } finally { await transport.close(); }
  }

  return [...collected.values()].sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
}

// ---------------------------------------------------------------------------
// Legacy DOM fallback (kept from the original pilot)
// ---------------------------------------------------------------------------

const parseCompact = (value) => {
  const match = String(value ?? '').trim().match(/^([\d.]+)\s*([KMB])?$/i);
  if (!match) return null;
  const multiplier = match[2]?.toUpperCase() === 'B' ? 1e9 : match[2]?.toUpperCase() === 'M' ? 1e6 : match[2]?.toUpperCase() === 'K' ? 1e3 : 1;
  return Math.round(Number(match[1]) * multiplier);
};

async function fetchCreativeCenterDom(region, period) {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', userAgent: UA, extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' } });
  const page = await context.newPage();
  const sourceUrl = `https://ads.tiktok.com/creative/creativeCenter/trends/video?region=${region}&period=${period}`;
  try {
    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => document.body.innerText.includes('Video views'), undefined, { timeout: 20_000 });
    const records = await page.locator('img').evaluateAll((images) => images
      .filter((image) => (image.getAttribute('alt') ?? '').trim().length > 40)
      .slice(0, 12)
      .map((image) => {
        let card = image;
        for (let depth = 0; depth < 4 && card.parentElement; depth += 1) card = card.parentElement;
        const lines = (card.innerText ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
        const followersIndex = lines.findIndex((line) => /followers$/i.test(line));
        const viewsIndex = lines.findIndex((line) => line === 'Video views');
        return {
          caption: (image.getAttribute('alt') ?? '').trim(),
          thumbnailUrl: image.currentSrc || image.getAttribute('src'),
          displayName: followersIndex > 0 ? lines[followersIndex - 1] : 'Creator unavailable',
          followersText: followersIndex >= 0 ? lines[followersIndex].replace(/\s*followers$/i, '') : null,
          viewsText: viewsIndex >= 0 ? lines[viewsIndex + 1] : null,
          topic: followersIndex > 1 ? lines[0] : null,
        };
      }));
    const now = new Date().toISOString();
    return records.map((record) => ({
      id: idFor(`${region}:${record.displayName}:${record.caption}`),
      kind: 'organic',
      url: sourceUrl,
      caption: record.caption,
      thumbnailUrl: record.thumbnailUrl || null,
      publishedAt: null, durationSeconds: null,
      views: parseCompact(record.viewsText), periodViews: null,
      likes: null, comments: null, shares: null, saves: null,
      sourceEngagementRate: null, vtr: null,
      creator: { username: null, displayName: record.displayName, profileUrl: sourceUrl, avatarUrl: null, followers: parseCompact(record.followersText), following: null, totalLikes: null, country: region, verified: false },
      hashtags: extractHashtags(record.caption),
      topic: record.topic,
      soundName: null, soundAuthor: null, soundId: null,
      collectedAt: now, viewsPerHour: null, likesPerHour: null, videoFileUrl: null,
      source: `TikTok Creative Center · ${region} · ${period} days`,
    }));
  } finally { await context.close(); }
}

// ---------------------------------------------------------------------------
// Top Ads — TikTok Creative Center public Top Ads dashboard (Playwright, the
// page signs its own API requests; we read the responses it receives)
// ---------------------------------------------------------------------------

function normalizeAd(material, region, industryNames) {
  const id = String(material?.id ?? '').trim();
  if (!id) return null;
  const videoInfo = material?.video_info ?? {};
  const brand = String(material?.brand_name ?? '').trim();
  return {
    id,
    kind: 'ad',
    url: `https://ads.tiktok.com/business/creativecenter/topads/${id}/pc/en?region=${region}`,
    caption: String(material?.ad_title ?? ''),
    thumbnailUrl: videoInfo.cover ?? null,
    publishedAt: null,
    durationSeconds: videoInfo.duration == null ? null : Math.round(videoInfo.duration),
    views: null, periodViews: null,
    likes: material?.like ?? null,
    comments: material?.comment ?? null,
    shares: material?.share ?? null,
    saves: null,
    sourceEngagementRate: null, vtr: null,
    ctr: material?.ctr == null ? null : material.ctr * 100,
    costTier: material?.cost ?? null,
    industry: industryNames.get(material?.industry_key) ?? humanizeKey(material?.industry_key, /^label_/) ?? null,
    objective: humanizeKey(material?.objective_key, /^campaign_objective_/),
    creator: {
      username: null,
      displayName: brand || 'Advertiser (name not disclosed)',
      profileUrl: `https://ads.tiktok.com/business/creativecenter/topads/${id}/pc/en`,
      avatarUrl: null, followers: null, following: null, totalLikes: null,
      country: region, verified: false,
    },
    hashtags: extractHashtags(material?.ad_title),
    topic: null,
    soundName: null, soundAuthor: null, soundId: null,
    collectedAt: new Date().toISOString(),
    viewsPerHour: null, likesPerHour: null,
    videoFileUrl: videoInfo.video_url?.['720p'] ?? videoInfo.video_url?.['480p'] ?? videoInfo.video_url?.['360p'] ?? null,
    source: `TikTok Creative Center · Top Ads · ${region}`,
  };
}

async function fetchTopAds(region, period, keyword) {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', userAgent: UA, extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' } });
  await context.route('**/*', (route) => Promise.resolve(
    ['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue(),
  ).catch(() => {})).catch(() => {});
  const page = await context.newPage();
  const materials = new Map();
  const industryNames = new Map();
  const wantKeyword = keyword.trim().length > 0;
  let sawKeywordResponse = false;

  page.on('response', async (response) => {
    const url = response.url();
    try {
      if (url.includes('top_ads/v2/list')) {
        const hasKeyword = new URL(url).searchParams.has('keyword');
        if (wantKeyword && !hasKeyword) return; // keep only keyword results when searching
        const body = safeParse(await response.text());
        if (body?.code !== 0) return;
        if (hasKeyword) sawKeywordResponse = true;
        for (const material of body?.data?.materials ?? []) {
          const ad = normalizeAd(material, region, industryNames);
          if (ad && !materials.has(ad.id)) materials.set(ad.id, ad);
        }
      } else if (url.includes('top_ads/v2/filters')) {
        const body = safeParse(await response.text());
        const walk = (node) => {
          if (Array.isArray(node)) return node.forEach(walk);
          if (node && typeof node === 'object') {
            const key = node.industry_key ?? node.key ?? node.id;
            const label = node.value ?? node.label ?? node.name;
            if (typeof key === 'string' && key.startsWith('label_') && typeof label === 'string') industryNames.set(key, label);
            Object.values(node).forEach(walk);
          }
        };
        walk(body?.data ?? body);
      }
    } catch { /* ignore malformed responses */ }
  });

  try {
    await page.goto(`https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en?region=${region}&period=${period}`, { waitUntil: 'domcontentloaded', timeout: 35_000 });
    await sleep(4_000);
    await page.keyboard.press('Escape').catch(() => {}); // promo modal

    if (wantKeyword) {
      const input = page.locator('input[placeholder="Search by brand or product keywords"]').first();
      await input.waitFor({ state: 'visible', timeout: 10_000 });
      await input.fill(keyword);
      await input.press('Enter');
      await sleep(3_500);
      if (!sawKeywordResponse) await sleep(3_000);
    }

    // Page deeper via "View More" until the login wall appears (~2 extra pages anonymously).
    for (let round = 0; round < 3; round += 1) {
      const sizeBefore = materials.size;
      const viewMore = page.getByText('View More', { exact: true }).last();
      if (!(await viewMore.isVisible().catch(() => false))) break;
      await viewMore.click().catch(() => {});
      await sleep(2_500);
      if (await page.getByText('Log in with', { exact: false }).first().isVisible().catch(() => false)) {
        await page.keyboard.press('Escape').catch(() => {});
        break;
      }
      if (materials.size === sizeBefore) break;
    }

    return [...materials.values()];
  } finally { await context.close(); }
}

// ---------------------------------------------------------------------------
// TikTok.com — real videos with full public stats (likes, comments, shares,
// saves, followers, publish date) read from the pages TikTok serves anonymously
// ---------------------------------------------------------------------------

// Live progress for the UI — one fetch runs at a time (context lock).
const fetchProgress = { active: false, phase: 'idle', collected: 0, matched: 0, target: 0, startedAt: null, keyword: null };
const setProgress = (patch) => Object.assign(fetchProgress, patch);

let tiktokCookieHeader = '';
try { tiktokCookieHeader = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tiktok-session.json'), 'utf8')).cookie ?? ''; } catch { /* none yet */ }

const numFrom = (...values) => {
  for (const value of values) {
    if (value == null || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.round(parsed);
  }
  return null;
};

function normalizeTikTokItem(item) {
  const id = String(item?.id ?? '').trim();
  if (!id || !item?.author) return null;
  const author = item.author ?? {};
  const authorStats = item.authorStats ?? {};
  const stats = item.statsV2 ?? item.stats ?? {};
  const statsFallback = item.stats ?? {};
  const video = item.video ?? {};
  const username = String(author.uniqueId ?? '').trim() || null;
  const playAddr = video.playAddr
    ?? video.bitrateInfo?.[0]?.PlayAddr?.UrlList?.at(-1)
    ?? video.downloadAddr ?? null;
  const hashtags = Array.isArray(item.textExtra)
    ? [...new Set(item.textExtra.map((extra) => extra?.hashtagName).filter(Boolean))]
    : extractHashtags(item.desc);
  return {
    id,
    kind: item.isAd ? 'ad' : 'organic',
    url: username ? `https://www.tiktok.com/@${username}/video/${id}` : `https://www.tiktok.com/video/${id}`,
    caption: String(item.desc ?? ''),
    thumbnailUrl: video.cover ?? video.originCover ?? video.dynamicCover ?? null,
    publishedAt: item.createTime ? new Date(Number(item.createTime) * 1000).toISOString() : null,
    durationSeconds: numFrom(video.duration),
    views: numFrom(stats.playCount, statsFallback.playCount),
    periodViews: null,
    likes: numFrom(stats.diggCount, statsFallback.diggCount),
    comments: numFrom(stats.commentCount, statsFallback.commentCount),
    shares: numFrom(stats.shareCount, statsFallback.shareCount),
    saves: numFrom(stats.collectCount, statsFallback.collectCount),
    sourceEngagementRate: null, vtr: null,
    creator: {
      username,
      displayName: String(author.nickname ?? username ?? 'Creator unavailable'),
      profileUrl: username ? `https://www.tiktok.com/@${username}` : 'https://www.tiktok.com',
      avatarUrl: author.avatarThumb ?? author.avatarMedium ?? null,
      followers: numFrom(item.authorStatsV2?.followerCount, authorStats.followerCount),
      following: numFrom(item.authorStatsV2?.followingCount, authorStats.followingCount),
      totalLikes: numFrom(item.authorStatsV2?.heartCount, authorStats.heartCount, authorStats.heart),
      country: null,
      verified: Boolean(author.verified),
    },
    hashtags,
    topic: null,
    soundName: item.music?.title ?? null,
    soundAuthor: item.music?.authorName ?? null,
    soundId: item.music?.id == null ? null : String(item.music.id),
    collectedAt: new Date().toISOString(),
    viewsPerHour: null, likesPerHour: null,
    videoFileUrl: playAddr,
    source: 'TikTok.com',
  };
}

const TIKTOK_LIST_PATTERN = /\/api\/(explore\/item_list|recommend\/item_list|search\/general\/full|search\/item\/full|search\/general\/preview|challenge\/item_list|post\/item_list|item\/detail|related\/item_list)\//;

// No-login keyword search: public search engines index tiktok.com videos, and
// individual video pages open for guests. Seed URLs come from DuckDuckGo/Bing,
// then each video page is opened headless — TikTok itself supplies the exact
// stats plus a "related videos" list that widens the result set.
async function searchEngineSeeds(page, keyword, limit, stats = []) {
  const urls = new Set();
  const register = (candidate) => {
    if (!candidate || urls.size >= limit * 3) return;
    let href = String(candidate);
    // Bing wraps targets in base64 (…/ck/a?…&u=a1<base64>).
    const wrapped = href.match(/[?&]u=a1([A-Za-z0-9+/=%_-]+)/)?.[1];
    if (wrapped) { try { href = Buffer.from(decodeURIComponent(wrapped).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { /* keep original */ } }
    try { href = decodeURIComponent(href); } catch { /* fine as-is */ }
    const match = href.match(/tiktok\.com\/@([\w.\-]+)\/video\/(\d{5,})/);
    if (match) urls.add(`https://www.tiktok.com/@${match[1]}/video/${match[2]}`);
  };
  const query = encodeURIComponent(`site:tiktok.com ${keyword}`);

  // Round 1 — plain HTTP like curl. Several engines serve full HTML to simple
  // clients while showing bot checks to headless browsers.
  const plainEngines = [
    ['bing', `https://www.bing.com/search?q=${query}&count=30`],
    ['mojeek', `https://www.mojeek.com/search?q=${query}`],
    ['ddg-lite', `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(`tiktok video ${keyword}`)}`],
    ['ddg-html', `https://html.duckduckgo.com/html/?q=${query}`],
  ];
  for (const [name, engine] of plainEngines) {
    if (urls.size >= limit) break;
    const before = urls.size;
    try {
      const response = await fetch(engine, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' } });
      const html = response.ok ? await response.text() : '';
      (html.match(/(?:href|u)=("|')?[^"'<>\s]{10,600}/g) ?? []).forEach(register);
      (html.match(/https?[^"'<>\s]{10,300}/g) ?? []).forEach(register);
      stats.push({ engine: `plain:${name}`, status: response.status, found: urls.size - before });
    } catch (error) { stats.push({ engine: `plain:${name}`, error: String(error).slice(0, 80) }); }
  }

  // Round 2 — real browser rendering for engines that need it.
  if (urls.size < limit) {
    const browserEngines = [
      ['ddg-html', `https://html.duckduckgo.com/html/?q=${query}`],
      ['bing', `https://www.bing.com/search?q=${query}&count=30`],
      ['ecosia', `https://www.ecosia.org/search?q=${query}`],
    ];
    for (const [name, engine] of browserEngines) {
      if (urls.size >= limit) break;
      const before = urls.size;
      try {
        await page.goto(engine, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        await sleep(1_800);
        (await page.$$eval('a', (anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? '')).catch(() => [])).forEach(register);
        ((await page.content().catch(() => '')).match(/https?[^"'<>\s]{10,300}/g) ?? []).forEach(register);
        stats.push({ engine: `browser:${name}`, found: urls.size - before });
      } catch (error) { stats.push({ engine: `browser:${name}`, error: String(error).slice(0, 80) }); }
    }
  }
  return [...urls].slice(0, limit);
}

// TikTok requires a logged-in session for keyword search (guest search now
// returns an empty shell). The user logs in ONCE in a visible window; the
// session is stored in a dedicated local browser profile and reused headless.
const TT_PROFILE_DIR = path.join(process.cwd(), 'data', 'tiktok-profile');
let ttContextLock = Promise.resolve();
let currentTtContext = null;
const forceCloseTikTok = async () => { try { await currentTtContext?.close(); } catch { /* already closed */ } };
async function withTikTokContext(options, fn) {
  let release;
  const previous = ttContextLock;
  ttContextLock = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    ensureDataDir();
    const headed = options.headless === false;
    const context = await chromium.launchPersistentContext(TT_PROFILE_DIR, {
      executablePath: CHROME_PATH,
      headless: !headed,
      viewport: headed ? null : { width: 1440, height: 1000 },
      locale: 'en-US',
      ...(headed ? {} : { userAgent: UA }),
      args: CHROME_ARGS,
      extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
    });
    currentTtContext = context;
    try { return await fn(context); } finally { currentTtContext = null; await context.close().catch(() => {}); }
  } finally { release(); }
}

const hasTikTokSession = () => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tiktok-login.json'), 'utf8')).loggedIn === true; }
  catch { return false; }
};

async function tikTokLogin() {
  return withTikTokContext({ headless: false }, async (context) => {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto('https://www.tiktok.com/login', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    const deadline = Date.now() + 240_000; // up to 4 minutes to log in manually
    let loggedIn = false;
    while (Date.now() < deadline) {
      const cookies = await context.cookies('https://www.tiktok.com').catch(() => []);
      if (cookies.some((cookie) => cookie.name === 'sessionid' && cookie.value)) { loggedIn = true; break; }
      if (page.isClosed() && !context.pages().length) break;
      await sleep(2_000);
    }
    if (loggedIn) await sleep(2_500); // let TikTok finish writing session cookies
    try { fs.writeFileSync(path.join(DATA_DIR, 'tiktok-login.json'), JSON.stringify({ loggedIn, at: new Date().toISOString() })); } catch { /* non-fatal */ }
    return loggedIn;
  });
}

const looksLikeTikTokItem = (node) => node && typeof node === 'object' && node.id && node.author && (node.stats || node.statsV2) && node.video;

// Hashtag/video pages embed the first items as JSON in the HTML — grab those too.
function collectEmbeddedItems(rawState) {
  const found = [];
  try {
    const state = safeParse(rawState);
    if (state.ItemModule && typeof state.ItemModule === 'object') found.push(...Object.values(state.ItemModule)); // SIGI_STATE shape
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 8) return;
      if (looksLikeTikTokItem(node)) { found.push(node); return; }
      for (const value of Array.isArray(node) ? node : Object.values(node)) walk(value, depth + 1);
    };
    walk(state.__DEFAULT_SCOPE__ ?? state, 0);
  } catch { /* not parseable */ }
  return found;
}

// ---------------------------------------------------------------------------
// Live scrape session — the browser context stays OPEN between "load more"
// calls, so pagination is instant and effectively unlimited: TikTok's own
// search/explore feed keeps yielding as long as we keep scrolling it.
// ---------------------------------------------------------------------------

const SESSION_IDLE_MS = 240_000;
let ttSession = null;

// Only one scrape may touch the browser profile at a time: two concurrent
// launchPersistentContext calls on the same user-data-dir make Chrome exit 21.
let opQueue = Promise.resolve();
const serialize = (fn) => {
  const run = opQueue.then(fn, fn);
  opQueue = run.then(() => {}, () => {});
  return run;
};

const cookiesFromHeader = (header) => String(header ?? '').split(';').map((pair) => {
  const index = pair.indexOf('=');
  if (index < 1) return null;
  return { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim(), domain: '.tiktok.com', path: '/' };
}).filter(Boolean);

// Chrome refuses a profile that still holds a lock from a killed run, and it
// exits 21 when it cannot write the profile at all (a full disk does that).
async function launchScrapeContext() {
  const options = {
    executablePath: CHROME_PATH,
    headless: true,
    viewport: { width: 1440, height: 1200 },
    locale: 'en-US',
    userAgent: UA,
    args: CHROME_ARGS,
    extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
  };
  // Chrome exits 21 (PROFILE_IN_USE) when a leftover headless process still
  // owns the profile, so try sibling profiles before giving up on persistence.
  const candidates = [TT_PROFILE_DIR, `${TT_PROFILE_DIR}-b`, `${TT_PROFILE_DIR}-c`];
  let lastError = null;
  for (const dir of candidates) {
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
      try { fs.rmSync(path.join(dir, name), { force: true, recursive: true }); } catch { /* not there */ }
    }
    try {
      return await chromium.launchPersistentContext(dir, options);
    } catch (error) {
      lastError = error;
      await sleep(400);
    }
  }
  // Last resort: a throwaway profile seeded with the cookies we saved, so
  // scraping still works even when every stored profile is unusable.
  try {
    const browser = await getBrowser();
    const context = await browser.newContext({ viewport: options.viewport, locale: options.locale, userAgent: UA, extraHTTPHeaders: options.extraHTTPHeaders });
    if (tiktokCookieHeader) await context.addCookies(cookiesFromHeader(tiktokCookieHeader)).catch(() => {});
    console.warn('[pulse] using a temporary browser profile:', String(lastError?.message ?? '').split('\n')[0]);
    return context;
  } catch (finalError) {
    const detail = String(finalError?.message ?? lastError?.message ?? 'unknown').split('\n')[0];
    throw new Error(`Chrome could not start (${detail}). Close any leftover chrome.exe in Task Manager, or free disk space, then try again.`);
  }
}

async function closeSession() {
  const session = ttSession;
  ttSession = null;
  if (!session) return;
  clearTimeout(session.timer);
  try { await session.context.close(); } catch { /* already gone */ }
}
function touchSession() {
  if (!ttSession) return;
  clearTimeout(ttSession.timer);
  ttSession.timer = setTimeout(() => { void closeSession(); }, SESSION_IDLE_MS);
}

const sessionKey = (mode, keyword) => `${mode}|${keyword.toLowerCase()}`;

async function openSession(mode, keyword) {
  await closeSession();
  ensureDataDir();
  const context = await launchScrapeContext();
  currentTtContext = context;

  // Never download images / video / fonts: the data arrives as JSON. This is
  // the single biggest speed win and it keeps Chrome from filling the disk.
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    const done = ['image', 'media', 'font'].includes(type) ? route.abort() : route.continue();
    return Promise.resolve(done).catch(() => {});
  }).catch(() => {});
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    window.chrome = window.chrome ?? { runtime: {} };
  }).catch(() => {});

  const page = context.pages()[0] ?? await context.newPage();
  const session = {
    key: sessionKey(mode, keyword), mode, keyword, context, page,
    collected: new Map(), returned: new Set(), exhausted: false, timer: null,
    label: mode === 'search' ? `TikTok.com · search · “${keyword}”` : 'TikTok.com · Explore',
  };

  page.on('response', async (response) => {
    try { if (!TIKTOK_LIST_PATTERN.test(response.url())) return; } catch { return; }
    try {
      const body = safeParse(await response.text());
      [
        ...(Array.isArray(body?.itemList) ? body.itemList : []),
        ...(Array.isArray(body?.item_list) ? body.item_list : []),
        ...(Array.isArray(body?.data) ? body.data.map((entry) => entry?.item ?? entry?.aweme_info ?? null) : []),
        ...(body?.itemInfo?.itemStruct ? [body.itemInfo.itemStruct] : []),
      ].filter(Boolean).forEach((raw) => {
        const video = normalizeTikTokItem(raw);
        if (video && !session.collected.has(video.id)) { video.source = session.label; session.collected.set(video.id, video); }
      });
    } catch { /* partial or non-JSON body */ }
  });

  const target = mode === 'search'
    ? `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`
    : 'https://www.tiktok.com/explore';
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 40_000 });
  await page.waitForResponse((response) => TIKTOK_LIST_PATTERN.test(response.url()), { timeout: 14_000 }).catch(() => {});
  await sleep(600);
  await page.keyboard.press('Escape').catch(() => {});
  await Promise.allSettled(['[data-e2e="modal-close-inner-button"]', 'button[aria-label="Close"]']
    .map((selector) => page.locator(selector).first().click({ timeout: 250 })));

  // Whatever the SSR payload already carries.
  const raw = await page.evaluate(() =>
    document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent
    ?? document.getElementById('SIGI_STATE')?.textContent ?? null).catch(() => null);
  if (raw) collectEmbeddedItems(raw).forEach((item) => {
    const video = normalizeTikTokItem(item);
    if (video && !session.collected.has(video.id)) { video.source = session.label; session.collected.set(video.id, video); }
  });

  // Keep this context's cookies so the video proxy can stream play URLs.
  try {
    const cookies = await context.cookies('https://www.tiktok.com');
    tiktokCookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    fs.writeFileSync(path.join(DATA_DIR, 'tiktok-session.json'), JSON.stringify({ cookie: tiktokCookieHeader, savedAt: new Date().toISOString() }));
  } catch { /* non-fatal */ }

  ttSession = session;
  touchSession();
  return session;
}

// Pull the next `want` matching videos, opening a session if needed.
// Returns { videos, hasMore, scanned } — call again to keep going forever.
const fetchTikTokBatch = (options) => serialize(() => fetchTikTokBatchInner(options));

async function fetchTikTokBatchInner({ mode, keyword, want, dateRange, fresh }) {
  const rangeStart = dateRange?.from ? new Date(`${dateRange.from}T00:00:00`).getTime() : null;
  const rangeEnd = dateRange?.to ? new Date(`${dateRange.to}T23:59:59`).getTime() : null;
  const hasRange = rangeStart != null || rangeEnd != null;
  const tokens = keyword.toLowerCase().split(/\s+/).filter(Boolean);

  const matches = (video) => {
    if (tokens.length) {
      const haystack = `${video.caption} ${video.hashtags.join(' ')} ${video.creator.username ?? ''} ${video.creator.displayName} ${video.soundName ?? ''}`.toLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) return false;
    }
    if (!hasRange) return true;
    if (!video.publishedAt) return false;
    const time = new Date(video.publishedAt).getTime();
    return (rangeStart == null || time >= rangeStart) && (rangeEnd == null || time <= rangeEnd);
  };

  const key = sessionKey(mode, keyword);
  let session = ttSession;
  const needsNewSession = fresh || !session || session.key !== key || session.page.isClosed();
  if (needsNewSession) {
    session = await openSession(mode, keyword);
    // "Load more" on a feed restored from disk: the browser session is gone,
    // so treat everything already saved as delivered and hand back only what
    // is genuinely new.
    if (!fresh) {
      const saved = readDataset('videos');
      if (saved?.videos?.length && (saved.keyword ?? '') === keyword) {
        saved.videos.forEach((video) => session.returned.add(String(video.id)));
      }
    }
  }
  if (fresh) { session.returned.clear(); session.exhausted = false; }
  touchSession();

  const readyCount = () => [...session.collected.values()].filter((video) => matches(video) && !session.returned.has(video.id)).length;

  setProgress({ active: true, phase: 'Reading TikTok results…', collected: session.collected.size, matched: readyCount(), target: want, startedAt: Date.now(), keyword: keyword || null });

  // Scroll the live feed until we have enough fresh matches.
  const deadline = Date.now() + (hasRange ? 100_000 : 55_000);
  let stagnant = 0;
  let previous = session.collected.size;
  while (readyCount() < want && stagnant < 8 && Date.now() < deadline) {
    await session.page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)).catch(() => {});
    await session.page.keyboard.press('End').catch(() => {});
    await session.page.waitForResponse((response) => TIKTOK_LIST_PATTERN.test(response.url()), { timeout: 3_500 }).catch(() => {});
    await sleep(280);
    stagnant = session.collected.size === previous ? stagnant + 1 : 0;
    previous = session.collected.size;
    setProgress({ collected: session.collected.size, matched: readyCount(), phase: `Scanned ${session.collected.size} videos…` });
  }
  if (stagnant >= 8) session.exhausted = true;

  const batch = [...session.collected.values()]
    .filter((video) => matches(video) && !session.returned.has(video.id))
    .slice(0, want);
  batch.forEach((video) => session.returned.add(video.id));

  setProgress({ active: false, phase: 'Done', collected: session.collected.size, matched: batch.length });
  return { videos: batch, hasMore: !session.exhausted, scanned: session.collected.size };
}

// Streaming proxy so play URLs (which require TikTok headers) work in <video>.
const VIDEO_HOST_PATTERN = /(^|\.)((tiktokcdn(-us|-eu)?\.com)|(tiktok\.com)|(tiktokv\.com)|(ibytedtos\.com)|(ttwstatic\.com)|(byteoversea\.com))$/;
async function proxyVideo(request, response, src) {
  let target;
  try { target = new URL(src); } catch { response.statusCode = 400; return response.end('Bad src'); }
  if (target.protocol !== 'https:' || !VIDEO_HOST_PATTERN.test(target.hostname)) { response.statusCode = 403; return response.end('Host not allowed'); }
  try {
    const headers = { 'user-agent': UA, referer: 'https://www.tiktok.com/', 'accept-language': 'en-US,en;q=0.9' };
    if (tiktokCookieHeader) headers.cookie = tiktokCookieHeader;
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
  } catch (error) {
    response.statusCode = 502;
    response.end(`Video proxy failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) return vite.middlewares(request, response);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (request.method !== 'GET') { response.statusCode = 405; return response.end(JSON.stringify({ error: 'Method not allowed' })); }

  if (url.pathname === '/api/progress') {
    return response.end(JSON.stringify(fetchProgress));
  }

  if (url.pathname === '/api/version') {
    return response.end(JSON.stringify({ build: 22, features: ['tag-search', 'explore', 'top-ads', 'video-proxy', 'persistence'] }));
  }

  if (url.pathname === '/api/datasets') {
    return response.end(JSON.stringify({ videos: readDataset('videos'), ads: readDataset('ads') }));
  }

  if (url.pathname === '/api/video') {
    response.removeHeader('Content-Type');
    return proxyVideo(request, response, String(url.searchParams.get('src') ?? ''));
  }

  if (url.pathname === '/api/tiktok-status') {
    return response.end(JSON.stringify({ loggedIn: hasTikTokSession() }));
  }

  if (url.pathname === '/api/tiktok-login') {
    try {
      const loggedIn = await tikTokLogin();
      return response.end(JSON.stringify({ loggedIn, message: loggedIn ? 'TikTok session saved — search is now available' : 'Login window closed without a completed login' }));
    } catch (error) {
      response.statusCode = 502;
      return response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Login flow failed' }));
    }
  }

  if (url.pathname === '/api/fetch-tiktok') {
    const keyword = String(url.searchParams.get('q') ?? '').trim().slice(0, 80);
    const mode = keyword ? 'search' : 'explore';
    // `want` is one PAGE of results — the client calls again as the user
    // scrolls, so the total is unlimited.
    const want = Math.min(120, Math.max(5, Number(url.searchParams.get('count') ?? 40) || 40));
    const fresh = url.searchParams.get('more') !== '1';
    const dateRange = {
      from: /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('from') ?? '') ? url.searchParams.get('from') : null,
      to: /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('to') ?? '') ? url.searchParams.get('to') : null,
    };
    try {
      const result = await Promise.race([
        fetchTikTokBatch({ mode, keyword, want, dateRange, fresh }),
        sleep(200_000).then(async () => { await closeSession(); throw new Error('TikTok stopped responding — hit Search again. (A full disk can also freeze Chrome: free some space on C:.)'); }),
      ]).finally(() => setProgress({ active: false, phase: 'Done' }));
      if (fresh && !result.videos.length) throw new Error(keyword ? `TikTok returned no public videos for “${keyword}”` : 'TikTok returned no public videos');
      const payload = {
        videos: result.videos, hasMore: result.hasMore, scanned: result.scanned,
        source: mode === 'search' ? `TikTok.com search · “${keyword}”` : 'TikTok.com Explore feed',
        keyword: keyword || null, fetchedAt: new Date().toISOString(),
      };
      if (fresh) saveDataset('videos', payload);
      else {
        // Keep the on-disk feed growing so a reload restores the whole scroll.
        const saved = readDataset('videos');
        if (saved?.videos?.length && (saved.keyword ?? '') === (keyword || null)) {
          const known = new Set(saved.videos.map((video) => String(video.id)));
          const merged = [...saved.videos, ...result.videos.filter((video) => !known.has(String(video.id)))];
          saveDataset('videos', { ...saved, videos: merged.slice(-600), hasMore: result.hasMore, scanned: result.scanned });
        }
      }
      return response.end(JSON.stringify(payload));
    } catch (error) {
      response.statusCode = 502;
      return response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'TikTok fetch failed' }));
    }
  }

  const region = String(url.searchParams.get('region') ?? 'US').toUpperCase();
  const period = String(url.searchParams.get('period') ?? '7');
  if (!ALLOWED_REGIONS.has(region) || !ALLOWED_PERIODS.has(period)) { response.statusCode = 400; return response.end(JSON.stringify({ error: 'Unsupported region or period' })); }

  if (url.pathname === '/api/fetch') {
    try {
      let videos = await fetchTrends(region, period);
      let source = 'TikTok Creative Center trends API (public, no login)';
      if (!videos.length) { videos = await fetchCreativeCenterDom(region, period); source = 'TikTok Creative Center public web page'; }
      if (!videos.length) throw new Error('TikTok returned no public videos');
      const payload = { videos, source, region, period, fetchedAt: new Date().toISOString() };
      saveDataset('videos', payload);
      return response.end(JSON.stringify(payload));
    } catch (error) {
      response.statusCode = 502;
      return response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Public fetch failed' }));
    }
  }

  if (url.pathname === '/api/fetch-ads') {
    const keyword = String(url.searchParams.get('keyword') ?? '').slice(0, 80);
    try {
      const videos = await fetchTopAds(region, period, keyword);
      if (!videos.length) throw new Error(keyword ? `No public ads matched “${keyword}”` : 'TikTok returned no public ads');
      const payload = { videos, source: 'TikTok Creative Center Top Ads (public)', region, period, keyword: keyword || null, fetchedAt: new Date().toISOString() };
      saveDataset('ads', payload);
      return response.end(JSON.stringify(payload));
    } catch (error) {
      response.statusCode = 502;
      return response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Ads fetch failed' }));
    }
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'Unknown endpoint' }));
});

// A scraping error must never kill the server — log it and keep serving.
process.on('unhandledRejection', (reason) => console.warn('[pulse] unhandled rejection:', reason instanceof Error ? reason.message : reason));
process.on('uncaughtException', (error) => console.warn('[pulse] uncaught exception:', error?.message ?? error));

server.listen(PORT, '0.0.0.0', () => console.log(`Pulse running on http://localhost:${PORT}`));
const shutdown = async () => { if (browserPromise) await (await browserPromise).close(); server.close(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
