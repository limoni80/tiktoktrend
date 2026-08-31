// Parsers shared by every source. These follow the field mapping already used
// by tiktok-profile-scraper-main/src/parsers.ts and tiktok-scraper-master so
// the frontend keeps receiving one normalized shape.

// JSON.parse loses precision on 64-bit TikTok ids — quote them before parsing.
export const safeParse = (text) =>
  JSON.parse(String(text).replace(/"(itemID|authorID|creatorID|id)"\s*:\s*(\d{15,})/g, '"$1":"$2"'));

export const extractHashtags = (text) =>
  [...new Set(String(text ?? '').match(/#[\p{L}\p{N}_]+/gu)?.map((tag) => tag.slice(1)) ?? [])];

export const humanizeKey = (key, prefix) => {
  const raw = String(key ?? '').replace(prefix, '').replaceAll('_', ' ').trim();
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : null;
};

const numFrom = (...values) => {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.round(parsed);
  }
  return null;
};

/** www.tiktok.com item (search / explore / detail) → normalized video. */
export function normalizeTikTokItem(item, sourceLabel = 'TikTok.com') {
  const id = String(item?.id ?? '').trim();
  if (!id || !item?.author) return null;
  const author = item.author ?? {};
  const authorStats = item.authorStats ?? {};
  const stats = item.statsV2 ?? item.stats ?? {};
  const fallback = item.stats ?? {};
  const video = item.video ?? {};
  const username = String(author.uniqueId ?? '').trim() || null;
  const playAddr = video.playAddr
    ?? video.bitrateInfo?.[0]?.PlayAddr?.UrlList?.at(-1)
    ?? video.downloadAddr ?? null;
  // Keep TikTok's public download address separate from the play stream. When
  // TikTok exposes it, the dashboard can request that original file directly;
  // it never fabricates or removes any watermark itself.
  // Only advertise a download when TikTok explicitly supplied downloadAddr.
  // playAddr remains usable for playback, but is not silently re-labelled as
  // a downloadable original.
  const downloadAddr = video.downloadAddr ?? null;

  return {
    id,
    kind: item.isAd ? 'ad' : 'organic',
    url: username ? `https://www.tiktok.com/@${username}/video/${id}` : `https://www.tiktok.com/video/${id}`,
    caption: String(item.desc ?? ''),
    thumbnailUrl: video.cover ?? video.originCover ?? video.dynamicCover ?? null,
    publishedAt: item.createTime ? new Date(Number(item.createTime) * 1000).toISOString() : null,
    durationSeconds: numFrom(video.duration),
    views: numFrom(stats.playCount, fallback.playCount),
    periodViews: null,
    likes: numFrom(stats.diggCount, fallback.diggCount),
    comments: numFrom(stats.commentCount, fallback.commentCount),
    shares: numFrom(stats.shareCount, fallback.shareCount),
    saves: numFrom(stats.collectCount, fallback.collectCount),
    sourceEngagementRate: null,
    vtr: null,
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
    hashtags: Array.isArray(item.textExtra)
      ? [...new Set(item.textExtra.map((extra) => extra?.hashtagName).filter(Boolean))]
      : extractHashtags(item.desc),
    topic: null,
    soundName: item.music?.title ?? null,
    soundAuthor: item.music?.authorName ?? null,
    soundId: item.music?.id == null ? null : String(item.music.id),
    collectedAt: new Date().toISOString(),
    viewsPerHour: null,
    likesPerHour: null,
    videoFileUrl: playAddr,
    downloadFileUrl: downloadAddr,
    source: sourceLabel,
  };
}

const looksLikeItem = (node) =>
  node && typeof node === 'object' && node.id && node.author && (node.stats || node.statsV2) && node.video;

/** SSR payloads (__UNIVERSAL_DATA_FOR_REHYDRATION__ / SIGI_STATE). */
export function collectEmbeddedItems(rawState) {
  const found = [];
  try {
    const state = safeParse(rawState);
    if (state.ItemModule && typeof state.ItemModule === 'object') found.push(...Object.values(state.ItemModule));
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 8) return;
      if (looksLikeItem(node)) { found.push(node); return; }
      for (const value of Array.isArray(node) ? node : Object.values(node)) walk(value, depth + 1);
    };
    walk(state.__DEFAULT_SCOPE__ ?? state, 0);
  } catch { /* not parseable */ }
  return found;
}

/** Items carried by any of TikTok's list endpoints. */
export function itemsFromListBody(body) {
  return [
    ...(Array.isArray(body?.itemList) ? body.itemList : []),
    ...(Array.isArray(body?.item_list) ? body.item_list : []),
    ...(Array.isArray(body?.data) ? body.data.map((entry) => entry?.item ?? entry?.aweme_info ?? null) : []),
    ...(body?.itemInfo?.itemStruct ? [body.itemInfo.itemStruct] : []),
  ].filter(Boolean);
}

/** Creative Center "top contents" entity → normalized video. */
export function normalizeTrendEntity(entity, region) {
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

/** Creative Center Top Ads material → normalized ad. */
export function normalizeAd(material, region, industryNames = new Map()) {
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
