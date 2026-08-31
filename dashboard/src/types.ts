export type Quality = 'verified' | 'derived' | 'unavailable';

export interface Creator {
  username: string | null;
  displayName: string;
  profileUrl: string;
  avatarUrl: string | null;
  followers: number | null;
  following: number | null;
  totalLikes: number | null;
  country: string | null;
  verified: boolean;
}

export interface TikTokVideo {
  id: string;
  kind?: 'organic' | 'ad';
  url: string;
  caption: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  views: number | null;
  periodViews?: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  sourceEngagementRate?: number | null;
  vtr?: number | null;
  ctr?: number | null;
  costTier?: number | null;
  industry?: string | null;
  objective?: string | null;
  creator: Creator;
  hashtags: string[];
  topic?: string | null;
  soundName: string | null;
  soundAuthor: string | null;
  soundId: string | null;
  collectedAt: string;
  viewsPerHour: number | null;
  likesPerHour: number | null;
  videoFileUrl?: string | null;
  /** TikTok's public download stream when the source exposes one. */
  downloadFileUrl?: string | null;
  source: string;
}

export interface EnrichedVideo extends TikTokVideo {
  ageHours: number | null;
  engagementRate: number | null;
  likeRate: number | null;
  commentRate: number | null;
  shareRate: number | null;
  followerEfficiency: number | null;
  winningScore: number;
  status: 'Exploding' | 'Rising Fast' | 'Winning' | 'Growing' | 'Promising' | 'Normal';
}

export type SortKey = 'winningScore' | 'views' | 'likes' | 'comments' | 'shares' | 'publishedAt' | 'engagementRate' | 'viewsPerHour' | 'followerEfficiency' | 'followers' | 'durationSeconds' | 'ctr';

export interface DatasetPayload {
  videos: TikTokVideo[];
  source: string;
  region?: string;
  period?: string;
  keyword?: string | null;
  fetchedAt: string;
}

export type MetricKey = 'views' | 'likes' | 'comments' | 'shares' | 'saves' | 'followers'
  | 'following' | 'totalLikes' | 'durationSeconds' | 'engagementRate' | 'winningScore' | 'ageHours' | 'ctr';

export interface CustomFilter {
  id: string;
  metric: MetricKey;
  op: 'gte' | 'lte' | 'between';
  value: string;
  value2: string;
}

export interface DiscoverFilters {
  minViews: string; maxViews: string;
  minLikes: string; minComments: string; minShares: string;
  minFollowers: string; maxFollowers: string;
  dateFrom: string; dateTo: string;
  minDuration: string; maxDuration: string;
  minEngagement: string;
}
