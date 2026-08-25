import type { EnrichedVideo, TikTokVideo } from './types';

const safeRate = (value: number | null, views: number | null) =>
  value == null || views == null || views <= 0 ? null : (value / views) * 100;

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));

export function enrichVideo(video: TikTokVideo, now = Date.now()): EnrichedVideo {
  const reactions = [video.likes, video.comments, video.shares];
  const computedEngagement = video.views && reactions.every((v) => v != null)
    ? (reactions.reduce<number>((sum, value) => sum + (value ?? 0), 0) / video.views) * 100
    : null;
  // TikTok's trends API supplies its own engagement rate when reactions are not public.
  const engagementRate = computedEngagement ?? video.sourceEngagementRate ?? null;
  const ageHours = video.publishedAt ? Math.max(0, (now - new Date(video.publishedAt).getTime()) / 3_600_000) : null;
  const followerEfficiency = video.views != null && video.creator.followers != null
    ? video.views / Math.max(video.creator.followers, 1)
    : null;

  const velocitySignal = video.viewsPerHour == null ? 0 : clamp(Math.log10(video.viewsPerHour + 1) * 18);
  const engagementSignal = engagementRate == null ? 0 : clamp(engagementRate * 6.5);
  const shareSignal = safeRate(video.shares, video.views) == null ? 0 : clamp((safeRate(video.shares, video.views) ?? 0) * 28);
  const efficiencySignal = followerEfficiency == null ? 0 : clamp(Math.log10(followerEfficiency + 1) * 45);
  const freshnessSignal = ageHours == null ? 0 : clamp(100 - ageHours / 3.5);
  const winningScore = Math.round(
    velocitySignal * 0.32 + engagementSignal * 0.24 + shareSignal * 0.12 +
    efficiencySignal * 0.18 + freshnessSignal * 0.14,
  );
  const status: EnrichedVideo['status'] = winningScore >= 85 ? 'Exploding'
    : winningScore >= 72 ? 'Rising Fast'
      : winningScore >= 60 ? 'Winning'
        : winningScore >= 45 ? 'Growing'
          : winningScore >= 30 ? 'Promising' : 'Normal';

  return {
    ...video,
    ageHours,
    engagementRate,
    likeRate: safeRate(video.likes, video.views),
    commentRate: safeRate(video.comments, video.views),
    shareRate: safeRate(video.shares, video.views),
    followerEfficiency,
    winningScore,
    status,
  };
}

export function formatMetric(value: number | null, compact = true): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('en', compact ? { notation: 'compact', maximumFractionDigits: 1 } : undefined).format(value);
}

export function formatAge(hours: number | null): string {
  if (hours == null) return 'Unavailable';
  if (hours < 1) return `${Math.max(1, Math.floor(hours * 60))}m`;
  if (hours < 24) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatDate(value: string | null): string {
  if (!value) return 'Unavailable';
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
