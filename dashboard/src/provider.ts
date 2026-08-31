import type { TikTokVideo } from './types';

type UnknownRecord = Record<string, any>;

export interface TikTokProvider {
  readonly name: string;
  importVideos(payload: unknown): Promise<TikTokVideo[]>;
}

const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const textOrNull = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;

export class WorkspaceJsonProvider implements TikTokProvider {
  readonly name = 'Workspace JSON / Apify';

  async importVideos(payload: unknown): Promise<TikTokVideo[]> {
    const records = Array.isArray(payload) ? payload : [payload];
    const flattened = records.flatMap((record: UnknownRecord) => Array.isArray(record?.videos)
      ? record.videos.map((video: UnknownRecord) => ({ video, profile: record.profile ?? {} }))
      : [{ video: record, profile: record?.profile ?? record?.authorMeta ?? {} }]);

    return flattened.map(({ video, profile }: { video: UnknownRecord; profile: UnknownRecord }) => {
      const id = String(video.videoId ?? video.id ?? '').trim();
      const username = textOrNull(profile.username ?? profile.name ?? video?.authorMeta?.name ?? video.username)?.replace(/^@/, '') ?? null;
      const published = video.postedDate ?? (video.createTime ? new Date(Number(video.createTime) * 1000).toISOString() : null);
      return {
        id,
        url: String(video.videoUrl ?? video.webVideoUrl ?? (username ? `https://www.tiktok.com/@${username}/video/${id}` : 'https://ads.tiktok.com/creative/creativeCenter/trends/video')),
        caption: String(video.description ?? video.text ?? ''),
        thumbnailUrl: textOrNull(video.thumbnailUrl ?? video?.covers?.origin ?? video?.covers?.default),
        publishedAt: textOrNull(published),
        durationSeconds: numberOrNull(video.durationSeconds ?? video?.videoMeta?.duration),
        views: numberOrNull(video.viewsCount ?? video.playCount),
        likes: numberOrNull(video.likesCount ?? video.diggCount),
        comments: numberOrNull(video.commentsCount ?? video.commentCount),
        shares: numberOrNull(video.sharesCount ?? video.shareCount),
        saves: numberOrNull(video.savesCount ?? video.collectCount),
        creator: {
          username,
          displayName: String(profile.displayName ?? profile.nickName ?? username ?? 'Creator unavailable'),
          profileUrl: String(profile.profileUrl ?? (username ? `https://www.tiktok.com/@${username}` : 'https://ads.tiktok.com/creative/creativeCenter/trends/video')),
          avatarUrl: textOrNull(profile.profileImageUrl ?? profile.avatar),
          followers: numberOrNull(profile.followersCount ?? profile.fans),
          following: numberOrNull(profile.followingCount ?? profile.following),
          totalLikes: numberOrNull(profile.totalLikesReceived ?? profile.heart),
          country: textOrNull(profile.region ?? profile.country ?? video.region ?? video.country),
          verified: Boolean(profile.verifiedBadge ?? profile.verified),
        },
        hashtags: Array.isArray(video.hashtags) ? video.hashtags.map((tag: UnknownRecord | string) => typeof tag === 'string' ? tag : String(tag.name ?? tag.title ?? '')).filter(Boolean) : [],
        soundName: textOrNull(video.soundName ?? video?.musicMeta?.musicName),
        soundAuthor: textOrNull(video.soundAuthor ?? video?.musicMeta?.musicAuthor),
        soundId: textOrNull(video.soundId ?? video?.musicMeta?.musicId),
        collectedAt: String(video.scrapedAt ?? new Date().toISOString()),
        viewsPerHour: numberOrNull(video.viewsPerHour),
        likesPerHour: numberOrNull(video.likesPerHour),
        videoFileUrl: textOrNull(video.videoFileUrl ?? video.playAddr ?? video?.videoMeta?.playAddr),
        downloadFileUrl: textOrNull(video.downloadFileUrl ?? video.downloadAddr ?? video.downloadUrl ?? video?.videoMeta?.downloadAddr),
        source: this.name,
      };
    }).filter((video) => video.id);
  }
}
