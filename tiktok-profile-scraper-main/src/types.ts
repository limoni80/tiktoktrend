export interface ActorInput {
    usernames: string[];
    proxyConfiguration?: {
        useApifyProxy: boolean;
        apifyProxyGroups?: string[];
        apifyProxyCountry?: string;
    };
}

export interface TikTokResult {
    profile: ProfileRecord;
    videos: VideoRecord[];
}

export interface ProfileRecord {
    username: string;
    displayName: string;
    bioText: string;
    followersCount: number | null;
    followingCount: number | null;
    totalLikesReceived: number | null;
    totalVideosCount: number | null;
    verifiedBadge: boolean;
    profileImageUrl: string | null;
    profileUrl: string;
    region: string | null;
    websiteInBio: string | null;
    isPrivate: boolean;
    scrapedAt: string;
}

export interface VideoRecord {
    videoId: string;
    videoUrl: string;
    description: string;
    hashtags: string[];
    mentions: string[];
    soundName: string | null;
    soundAuthor: string | null;
    likesCount: number | null;
    commentsCount: number | null;
    sharesCount: number | null;
    viewsCount: number | null;
    postedDate: string | null;
    durationSeconds: number | null;
    thumbnailUrl: string | null;
    isAd: boolean;
    isPinned: boolean;
    scrapedAt: string;
}
