import { createContext, sleep, USER_AGENT } from './browser.mjs';
import { ApiError } from './http.mjs';
import { normalizeAd, normalizeTrendEntity, safeParse } from './normalize.mjs';

export const ALLOWED_REGIONS = new Set(['US','FR','DE','IT','ES','GB','AR','AU','BR','CA','CO','EG','ID','IL','JP','KR','MY','MX','PH','SA','SG','ZA','TW','TH','TR','AE','VN']);
export const ALLOWED_PERIODS = new Set(['7', '30']);

// Content categories verified against the live TikTok One Creative Suite page.
const CONTENT_LABELS = ['11001','11002','11003','11004','11005','11007','11008','11009','11010','11013','11014','11015'];
const TRENDS_HOSTS = ['ads.us.tiktok.com', 'ads.tiktok.com', 'ads-sg.tiktok.com'];

async function directJson(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT, accept: 'application/json',
      referer: 'https://ads.tiktok.com/', origin: 'https://ads.tiktok.com',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return safeParse(await response.text());
}

async function pickTrendsHost() {
  for (const host of TRENDS_HOSTS) {
    try {
      const overview = await directJson(`https://${host}/CreativeOne/Report/GetTopContentsOverview`);
      if (overview?.BaseResp?.StatusCode === 0) return { host, overview };
    } catch { /* try the next host */ }
  }
  return null;
}

/**
 * Country trend rankings. This endpoint is unsigned and needs no cookies, so it
 * works from any server. It exposes views / followers / engagement rate, but
 * TikTok does not publish likes, comments, shares or saves on this surface —
 * those stay null rather than being estimated.
 */
export async function fetchTrends(region, period) {
  const direct = await pickTrendsHost();
  if (!direct) throw new ApiError(502, 'trends_unreachable', 'TikTok Creative Center did not respond from this server.');

  const endTs = period === '30'
    ? direct.overview?.lastMonthlyEndTimestamp ?? direct.overview?.lastWeeklyEndTimestamp
    : direct.overview?.lastWeeklyEndTimestamp ?? direct.overview?.lastDailyEndTimestamp;
  const dimension = period === '30' ? '5' : '3';

  const collected = new Map();
  const jobs = [
    ...['1', '2', '3'].map((order) => ({ label: '', order })),
    ...CONTENT_LABELS.map((label) => ({ label, order: '1' })),
  ];

  for (const job of jobs) {
    try {
      const params = new URLSearchParams({
        contentLabelIDs: job.label, countryCode: region, limit: '20', orderByMetric: job.order,
        organicOnly: 'false', page: '1', periodDimension: dimension, periodEndTimestamp: String(endTs ?? ''),
      });
      const result = await directJson(`https://${direct.host}/CreativeOne/Report/CreativeCenterGetTopContentsList?${params}`);
      if (result?.BaseResp?.StatusCode !== 0) continue;
      for (const entity of result?.entityInfos ?? []) {
        const video = normalizeTrendEntity(entity, region);
        if (video && !collected.has(video.id)) collected.set(video.id, video);
      }
      await sleep(120);
    } catch { /* keep sweeping the remaining categories */ }
  }

  if (!collected.size) throw new ApiError(502, 'trends_empty', `TikTok Creative Center returned no trend videos for ${region}.`);
  return [...collected.values()].sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
}

/**
 * Top Ads. The list endpoint is signed by the page itself, so we let the public
 * dashboard issue its own requests and read the responses it receives.
 */
export async function fetchTopAds(region, period, keyword) {
  const context = await createContext();
  const page = await context.newPage();
  const materials = new Map();
  const industryNames = new Map();
  const wantKeyword = keyword.trim().length > 0;

  page.on('response', async (response) => {
    const url = response.url();
    try {
      if (url.includes('top_ads/v2/list')) {
        const hasKeyword = new URL(url).searchParams.has('keyword');
        if (wantKeyword && !hasKeyword) return;
        const body = safeParse(await response.text());
        if (body?.code !== 0) return;
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
    await page.keyboard.press('Escape').catch(() => {});

    if (wantKeyword) {
      const input = page.locator('input[placeholder="Search by brand or product keywords"]').first();
      await input.waitFor({ state: 'visible', timeout: 10_000 });
      await input.fill(keyword);
      await input.press('Enter');
      await sleep(4_000);
    }

    for (let round = 0; round < 3; round += 1) {
      const before = materials.size;
      const viewMore = page.getByText('View More', { exact: true }).last();
      if (!(await viewMore.isVisible().catch(() => false))) break;
      await viewMore.click().catch(() => {});
      await sleep(2_500);
      if (await page.getByText('Log in with', { exact: false }).first().isVisible().catch(() => false)) {
        await page.keyboard.press('Escape').catch(() => {});
        break;
      }
      if (materials.size === before) break;
    }

    if (!materials.size) {
      throw new ApiError(502, 'ads_empty', keyword
        ? `TikTok Top Ads returned nothing for “${keyword}”.`
        : 'TikTok Top Ads returned no public ads.');
    }
    return [...materials.values()];
  } finally {
    await context.close().catch(() => {});
  }
}
