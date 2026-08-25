import type { ProfileRecord, TikTokResult, VideoRecord } from './types.js';

type JsonRecord = Record<string, any>;
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export function parseTikTokOEmbed(payload: JsonRecord, requestedUsername: string): TikTokResult | null {
    if (text(payload.provider_name).toLowerCase() !== 'tiktok' || text(payload.type) !== 'rich') return null;

    const authorUrl = text(payload.author_url);
    const urlUsername = authorUrl.match(/tiktok\.com\/@([^/?#]+)/i)?.[1] ?? '';
    const htmlUsername = text(payload.html).match(/data-unique-id=["']([^"']+)["']/i)?.[1] ?? '';
    const username = urlUsername || htmlUsername || requestedUsername;
    if (!username || username.toLowerCase() !== requestedUsername.toLowerCase()) return null;

    const displayName = text(payload.author_name)
        || text(payload.title).replace(/(?:'s)?\s+Creator Profile$/i, '').trim()
        || username;
    return {
        profile: {
            username,
            displayName,
            bioText: '',
            followersCount: null,
            followingCount: null,
            totalLikesReceived: null,
            totalVideosCount: null,
            verifiedBadge: false,
            profileImageUrl: text(payload.thumbnail_url) || null,
            profileUrl: authorUrl || `https://www.tiktok.com/@${username}`,
            region: null,
            websiteInBio: null,
            isPrivate: false,
            scrapedAt: new Date().toISOString(),
        },
        videos: [],
    };
}

export function parseAbbreviatedNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const cleaned = String(value).replace(/,/g, '').trim();
    const match = cleaned.match(/([\d.]+)\s*([bmk])?/i);
    if (!match) return null;
    const multiplier = match[2]?.toLowerCase() === 'b' ? 1_000_000_000
        : match[2]?.toLowerCase() === 'm' ? 1_000_000
            : match[2]?.toLowerCase() === 'k' ? 1_000 : 1;
    return Math.round(Number(match[1]) * multiplier);
}

function hashtags(value: string): string[] {
    return [...new Set((value.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((tag) => tag.slice(1)))];
}

function mentions(value: string): string[] {
    return [...new Set((value.match(/@[a-z0-9._]+/gi) ?? []).map((tag) => tag.slice(1)))];
}

export function mapTikTokVideo(item: JsonRecord, username: string): VideoRecord | null {
    const id = text(item.id);
    if (!id) return null;
    const description = text(item.desc);
    const author = text(item?.author?.uniqueId) || username;
    const stats = item.statsV2 ?? item.stats ?? {};
    const timestamp = parseAbbreviatedNumber(item.createTime);
    return {
        videoId: id,
        videoUrl: `https://www.tiktok.com/@${author}/video/${id}`,
        description,
        hashtags: hashtags(description),
        mentions: mentions(description),
        soundName: text(item?.music?.title) || null,
        soundAuthor: text(item?.music?.authorName) || null,
        likesCount: parseAbbreviatedNumber(stats.diggCount),
        commentsCount: parseAbbreviatedNumber(stats.commentCount),
        sharesCount: parseAbbreviatedNumber(stats.shareCount),
        viewsCount: parseAbbreviatedNumber(stats.playCount),
        postedDate: timestamp ? new Date(timestamp * 1000).toISOString() : null,
        durationSeconds: parseAbbreviatedNumber(item?.video?.duration),
        thumbnailUrl: text(item?.video?.cover ?? item?.video?.originCover ?? item?.video?.dynamicCover) || null,
        isAd: Boolean(item.isAd),
        isPinned: Boolean(item.isPinnedItem ?? item.is_pinned_item),
        scrapedAt: new Date().toISOString(),
    };
}

function findItems(value: unknown, depth = 0): JsonRecord[] {
    if (!value || typeof value !== 'object' || depth > 10) return [];
    const record = value as JsonRecord;
    if (Array.isArray(record.itemList)) return record.itemList.filter((item: unknown) => item && typeof item === 'object');
    for (const child of Object.values(record)) {
        if (Array.isArray(child)) {
            for (const item of child) {
                const found = findItems(item, depth + 1);
                if (found.length > 0) return found;
            }
        } else {
            const found = findItems(child, depth + 1);
            if (found.length > 0) return found;
        }
    }
    return [];
}

export function parseTikTokPayload(payload: JsonRecord, requestedUsername: string): TikTokResult | null {
    const userInfo = payload?.['__DEFAULT_SCOPE__']?.['webapp.user-detail']?.userInfo
        ?? payload?.userInfo
        ?? payload?.data?.userInfo;
    const user = userInfo?.user;
    const stats = userInfo?.statsV2 ?? userInfo?.stats;
    if (!user || !text(user.uniqueId)) return null;
    const username = text(user.uniqueId) || requestedUsername;
    const profile: ProfileRecord = {
        username,
        displayName: text(user.nickname) || username,
        bioText: text(user.signature),
        followersCount: parseAbbreviatedNumber(stats?.followerCount),
        followingCount: parseAbbreviatedNumber(stats?.followingCount),
        totalLikesReceived: parseAbbreviatedNumber(stats?.heartCount ?? stats?.heart),
        totalVideosCount: parseAbbreviatedNumber(stats?.videoCount),
        verifiedBadge: Boolean(user.verified),
        profileImageUrl: text(user.avatarLarger ?? user.avatarMedium) || null,
        profileUrl: `https://www.tiktok.com/@${username}`,
        region: text(user.region) || null,
        websiteInBio: text(user?.bioLink?.link) || null,
        isPrivate: Boolean(user.privateAccount),
        scrapedAt: new Date().toISOString(),
    };
    const videos = findItems(payload)
        .map((item) => mapTikTokVideo(item, username))
        .filter((video: VideoRecord | null): video is VideoRecord => Boolean(video));
    return { profile, videos };
}

export function parseTikTokHtml(html: string, requestedUsername: string): TikTokResult | null {
    const match = html.match(/<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (match?.[1]) {
        try {
            const result = parseTikTokPayload(JSON.parse(match[1]), requestedUsername);
            if (result) return result;
        } catch {
            // Fall through to TikTok's older SIGI_STATE payload.
        }
    }

    const sigiMatch = html.match(/<script[^>]+id=["'](?:SIGI_STATE|sigi-persisted-data)["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!sigiMatch?.[1]) return null;
    try {
        const sigi = JSON.parse(sigiMatch[1]);
        const users = sigi?.UserModule?.users ?? {};
        const statsByUser = sigi?.UserModule?.stats ?? {};
        const requested = requestedUsername.toLowerCase();
        const user = Object.values(users).find((candidate: any) => text(candidate?.uniqueId).toLowerCase() === requested)
            ?? Object.values(users)[0];
        if (!user || typeof user !== 'object') return null;
        const userRecord = user as JsonRecord;
        const stats = statsByUser[userRecord.id] ?? statsByUser[userRecord.uniqueId] ?? Object.values(statsByUser)[0] ?? {};
        return parseTikTokPayload({ userInfo: { user: userRecord, stats } }, requestedUsername);
    } catch {
        return null;
    }
}
