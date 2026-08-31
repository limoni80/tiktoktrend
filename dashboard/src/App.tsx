import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  BarChart3, Bookmark, Bug, Clapperboard, Clock3, Copy, Download, Eye, Flame, Grid2X2, Hash, Heart, Import,
  LayoutDashboard, Megaphone, Menu, MessageCircle, Moon, Music2, Play, RefreshCw, Search, Share2, Sun,
  TrendingUp, Users, X,
} from 'lucide-react';
import { enrichVideo, formatAge, formatDate, formatMetric } from './analytics';
import { WorkspaceJsonProvider } from './provider';
import { sampleVideos } from './sample-data';
import { api, ApiError, USE_DEMO_DATA } from './api';
import type { CatalogueEntry } from './api';
import type { CustomFilter, DatasetPayload, DiscoverFilters, EnrichedVideo, MetricKey, SortKey, TikTokVideo } from './types';

const METRICS: Array<[MetricKey, string, string]> = [
  ['views', 'Views', ''], ['likes', 'Likes', ''], ['comments', 'Comments', ''], ['shares', 'Shares', ''],
  ['saves', 'Saves', ''], ['followers', 'Creator followers', ''], ['following', 'Creator following', ''],
  ['totalLikes', 'Creator total likes', ''], ['durationSeconds', 'Duration', 'sec'],
  ['engagementRate', 'Engagement rate', '%'], ['winningScore', 'Winning score', '/100'],
  ['ageHours', 'Age', 'hours'], ['ctr', 'Ad CTR', '%'],
];
const metricValue = (video: EnrichedVideo, metric: MetricKey): number | null => {
  if (metric === 'followers') return video.creator.followers;
  if (metric === 'following') return video.creator.following;
  if (metric === 'totalLikes') return video.creator.totalLikes;
  const value = video[metric as keyof EnrichedVideo];
  return typeof value === 'number' ? value : null;
};

const navItems = [
  ['Discover', Search], ['Overview', LayoutDashboard], ['Creators', Users],
  ['Sounds', Music2], ['Watchlist', Bookmark], ['Exports', Download],
] as const;
type NavLabel = (typeof navItems)[number][0];

const fetchRegions = [['US','United States'],['GB','United Kingdom'],['FR','France'],['DE','Germany'],['ES','Spain'],['IT','Italy'],['EG','Egypt'],['SA','Saudi Arabia'],['AE','United Arab Emirates'],['CA','Canada'],['BR','Brazil'],['MX','Mexico'],['JP','Japan'],['KR','South Korea'],['ID','Indonesia'],['PH','Philippines'],['TR','Turkey'],['ZA','South Africa']] as const;

const emptyFilters: DiscoverFilters = { minViews: '', maxViews: '', minLikes: '', minComments: '', minShares: '', minFollowers: '', maxFollowers: '', dateFrom: '', dateTo: '', minDuration: '', maxDuration: '', minEngagement: '' };
const parseNum = (value: string): number | null => value.trim() === '' ? null : Number(value.replaceAll(',', ''));
const sortValue = (video: EnrichedVideo, key: SortKey): number => {
  if (key === 'publishedAt') return new Date(video.publishedAt ?? 0).getTime();
  if (key === 'followers') return video.creator.followers ?? -1;
  const value = video[key as keyof EnrichedVideo];
  return typeof value === 'number' ? value : -1;
};

interface Progress { active: boolean; phase: string; collected: number; matched: number; target: number; startedAt: number | null }

// Cached results older than this are refreshed automatically on open.
const STALE_MS = 10 * 60 * 1000;
const relativeTime = (iso: string) => {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 90) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
};

function App() {
  // Demo data is opt-in via VITE_USE_DEMO_DATA=true. Production starts empty
  // and shows a clear error if the backend cannot be reached.
  const [videos, setVideos] = useState<TikTokVideo[]>(USE_DEMO_DATA ? sampleVideos : []);
  const [ads, setAds] = useState<TikTokVideo[]>([]);
  const [adsMeta, setAdsMeta] = useState<DatasetPayload | null>(null);
  const [videosMeta, setVideosMeta] = useState<DatasetPayload | null>(null);
  const [dataMode, setDataMode] = useState<'demo' | 'imported' | 'live'>(USE_DEMO_DATA ? 'demo' : 'live');
  const [activeNav, setActiveNav] = useState<NavLabel>('Discover');
  const [feedType, setFeedType] = useState<'videos' | 'ads'>('videos');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('winningScore');
  const [view, setView] = useState<'cards' | 'table'>('cards');
  const [filters, setFilters] = useState<DiscoverFilters>(emptyFilters);
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());
  const [dark, setDark] = useState(true);
  const [sidebar, setSidebar] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [customFilters, setCustomFilters] = useState<CustomFilter[]>([]);
  const [draft, setDraft] = useState<{ metric: MetricKey; op: CustomFilter['op']; value: string; value2: string }>({ metric: 'views', op: 'gte', value: '', value2: '' });
  const [target, setTarget] = useState('40');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [scanned, setScanned] = useState(0);
  const [autoLoad, setAutoLoad] = useState(true);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [needsBackend, setNeedsBackend] = useState(false);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  // Raw server-side diagnostics for the last fetch — shown verbatim so a bad
  // search can be copied and reported instead of described.
  const [diagnostics, setDiagnostics] = useState<{ when: string; label: string; payload: unknown } | null>(null);
  const [diagOpen, setDiagOpen] = useState(false);
  const [diagCopied, setDiagCopied] = useState(false);
  const [probing, setProbing] = useState(false);
  // Keywords GitHub Actions keeps collected — these answer instantly and cost
  // no Cloudflare browser quota.
  const [catalogue, setCatalogue] = useState<CatalogueEntry[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [region, setRegion] = useState('US');
  const [ccBusy, setCcBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // The polling state lives in a ref so scheduled retries always see the
  // latest attempt count even when they were created by an older render.
  const collectionPoll = useRef<{ keyword: string; since: number; attempts: number; timer: number | null } | null>(null);
  const busyRef = useRef(false);
  // A keyword nobody had collected yet: a run is in flight and we are polling.
  const [collecting, setCollecting] = useState<{ keyword: string; since: number } | null>(null);

  // On open: show the cached results instantly, then silently pull FRESH ones
  // from TikTok so nobody is ever looking at yesterday's feed.
  useEffect(() => {
    (async () => {
      let cachedKeyword = '';
      let stale = true;
      try {
        const payload = await api.datasets();
        if (payload.videos?.videos?.length) {
          setVideos(payload.videos.videos); setVideosMeta(payload.videos); setDataMode('live');
          setHasMore(true); setScanned(payload.videos.videos.length);
          cachedKeyword = payload.videos.keyword ?? '';
          if (cachedKeyword) setQuery(cachedKeyword);
          stale = Date.now() - new Date(payload.videos.fetchedAt).getTime() > STALE_MS;
        }
        if (payload.ads?.videos?.length) { setAds(payload.ads.videos); setAdsMeta(payload.ads); }
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'Backend unavailable.');
      }
      if (stale) void refreshFeed(cachedKeyword);
    })();
  }, []);

  // Which keywords are pre-collected (and how fresh each one is).
  useEffect(() => {
    void api.catalogue()
      .then((payload) => setCatalogue((payload.keywords ?? []).filter((entry) => entry.count > 0)))
      .catch(() => { /* catalogue is optional */ });
  }, []);

  // Keep the "updated X ago" label honest without re-rendering constantly.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setClockTick((value) => value + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  // While a collection run is in flight, tick every second so the elapsed
  // counter on the progress card is real rather than decorative.
  useEffect(() => {
    if (!collecting) return;
    const timer = setInterval(() => setClockTick((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [collecting]);

  // Never leave a queued retry running after the dashboard unmounts.
  useEffect(() => () => {
    if (collectionPoll.current?.timer != null) window.clearTimeout(collectionPoll.current.timer);
  }, []);

  // Live progress while a fetch runs.
  useEffect(() => {
    if (!busy) { setProgress(null); return; }
    let alive = true;
    const tick = async () => {
      try {
        const data = await api.progress();
        if (alive) setProgress(data as Progress);
      } catch { /* ignore */ }
    };
    void tick();
    const timer = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [busy]);

  const enriched = useMemo(() => videos.map((video) => enrichVideo(video)), [videos]);
  const enrichedAds = useMemo(() => ads.map((video) => enrichVideo(video)), [ads]);
  const feed = feedType === 'ads' ? enrichedAds : enriched;

  const visible = useMemo(() => feed.filter((video) => {
    const needle = query.toLowerCase().trim().replace(/^#|^@/, '');
    // A server-side TikTok search is already ranked for this keyword. Applying
    // the instant local text filter again can hide valid results whose caption
    // does not literally repeat the query. Keep local filtering only while the
    // user is typing a different query over the currently loaded dataset.
    const loadedNeedle = feedType === 'videos'
      ? String(videosMeta?.keyword ?? '').toLowerCase().trim().replace(/^#|^@/, '')
      : '';
    if (needle && needle !== loadedNeedle) {
      const haystack = `${video.caption} ${video.creator.username ?? ''} ${video.creator.displayName} ${video.hashtags.join(' ')} ${video.soundName ?? ''} ${video.industry ?? ''} ${video.topic ?? ''}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (activeNav === 'Watchlist' && !watchlist.has(video.id)) return false;
    const inRange = (value: number | null | undefined, min: string, max: string) => {
      const lo = parseNum(min), hi = parseNum(max);
      if (lo == null && hi == null) return true;
      if (value == null) return false;
      return (lo == null || value >= lo) && (hi == null || value <= hi);
    };
    if (!inRange(video.views, filters.minViews, filters.maxViews)) return false;
    if (!inRange(video.likes, filters.minLikes, '')) return false;
    if (!inRange(video.comments, filters.minComments, '')) return false;
    if (!inRange(video.shares, filters.minShares, '')) return false;
    if (!inRange(video.creator.followers, filters.minFollowers, filters.maxFollowers)) return false;
    if (!inRange(video.durationSeconds, filters.minDuration, filters.maxDuration)) return false;
    if (!inRange(video.engagementRate, filters.minEngagement, '')) return false;
    for (const custom of customFilters) {
      const value = metricValue(video, custom.metric);
      const low = parseNum(custom.value), high = parseNum(custom.value2);
      if (value == null) return false;
      if (custom.op === 'gte' && low != null && value < low) return false;
      if (custom.op === 'lte' && low != null && value > low) return false;
      if (custom.op === 'between' && ((low != null && value < low) || (high != null && value > high))) return false;
    }
    if (filters.dateFrom || filters.dateTo) {
      if (!video.publishedAt) return false;
      const time = new Date(video.publishedAt).getTime();
      if (filters.dateFrom && time < new Date(`${filters.dateFrom}T00:00:00`).getTime()) return false;
      if (filters.dateTo && time > new Date(`${filters.dateTo}T23:59:59`).getTime()) return false;
    }
    return true;
  }).sort((a, b) => sortValue(b, sort) - sortValue(a, sort)), [feed, feedType, videosMeta?.keyword, query, activeNav, watchlist, filters, customFilters, sort]);

  const creators = useMemo(() => [...new Map(enriched.map((video) => [video.creator.username ?? video.creator.displayName, video.creator])).values()]
    .sort((a, b) => (b.followers ?? -1) - (a.followers ?? -1)), [enriched]);
  const sounds = useMemo(() => {
    const groups = new Map<string, { name: string; author: string | null; videos: number; views: number }>();
    enriched.forEach((video) => {
      if (!video.soundName) return;
      const key = `${video.soundName}:${video.soundId ?? ''}`;
      const current = groups.get(key) ?? { name: video.soundName, author: video.soundAuthor, videos: 0, views: 0 };
      current.videos += 1; current.views += video.views ?? 0; groups.set(key, current);
    });
    return [...groups.values()].sort((a, b) => b.views - a.views);
  }, [enriched]);
  const topHashtags = useMemo(() => {
    const counts = new Map<string, { videos: number; views: number }>();
    enriched.forEach((video) => video.hashtags.forEach((tag) => {
      const current = counts.get(tag) ?? { videos: 0, views: 0 };
      current.videos += 1; current.views += video.views ?? 0; counts.set(tag, current);
    }));
    return [...counts.entries()].sort((a, b) => b[1].views - a[1].views).slice(0, 12);
  }, [enriched]);

  const totals = useMemo(() => {
    const knownEngagement = enriched.filter((v) => v.engagementRate != null);
    return {
      views: enriched.reduce((sum, v) => sum + (v.views ?? 0), 0),
      likes: enriched.reduce((sum, v) => sum + (v.likes ?? 0), 0),
      engagement: knownEngagement.length ? knownEngagement.reduce((sum, v) => sum + (v.engagementRate ?? 0), 0) / knownEngagement.length : null,
      creators: new Set(enriched.map((v) => v.creator.username ?? v.creator.displayName)).size,
    };
  }, [enriched]);

  const localDate = (daysAgo: number) => {
    const date = new Date(); date.setDate(date.getDate() - daysAgo);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const datePresets = [
    { id: 'any', label: 'Any time', from: '', to: '' },
    { id: 'today', label: 'Today', from: localDate(0), to: localDate(0) },
    { id: 'yesterday', label: 'Yesterday', from: localDate(1), to: localDate(1) },
    { id: 'week', label: 'Last 7 days', from: localDate(7), to: '' },
    { id: 'month', label: 'Last 30 days', from: localDate(30), to: '' },
  ];
  const activeDateId = datePresets.find((preset) => preset.from === filters.dateFrom && preset.to === filters.dateTo)?.id ?? 'custom';

  const activeFilterCount = Object.values(filters).filter((value) => value.trim() !== '').length;

  // Silent background refresh — replaces the cached feed with a live one
  // without taking over the screen.
  const BACKENDLESS = [
    'backend_not_configured', 'backend_unreachable', 'backend_bad_response', 'not_json',
    'browser_rate_limited', 'browser_unavailable',
  ];

  const loadTrends = async (why?: string) => {
    const trends = await api.trends({ region, period: '7' });
    if (!trends.videos?.length) return false;
    setVideos(trends.videos); setVideosMeta(trends); setDataMode('live');
    setHasMore(false); setScanned(trends.videos.length);
    setFlash(`${trends.videos.length} real trend videos from TikTok (${region})${why ? ` — ${why}` : ''}`);
    return true;
  };

  const refreshFeed = async (keyword: string) => {
    if (busy || refreshing) return;
    setRefreshing(true);
    try {
      // Automatic refresh with no keyword: use trends, which need no browser
      // and therefore never consume the Browser Rendering launch quota.
      if (!keyword.trim()) {
        await loadTrends();
        return;
      }
      const payload = await api.searchTikTok({ q: keyword.trim(), count: target, from: filters.dateFrom, to: filters.dateTo });
      if (!payload.videos?.length) return;
      setVideos(payload.videos); setVideosMeta(payload); setDataMode('live'); setNeedsBackend(false);
      setHasMore(Boolean(payload.hasMore)); setScanned(payload.scanned ?? payload.videos.length);
    } catch (caught) {
      // No scraping backend wired up? Country trends come straight from the
      // Worker, so show those instead of an empty screen.
      if (caught instanceof ApiError && BACKENDLESS.includes(caught.code)) {
        setNeedsBackend(caught.code.startsWith('backend'));
        try {
          if (await loadTrends(caught.message)) return;
        } catch (trendError) {
          setError(trendError instanceof Error ? trendError.message : 'Could not load trends.');
          return;
        }
      }
      recordError('background refresh failed', caught);
      if (caught instanceof ApiError && caught.code !== 'tiktok_empty') setError(caught.message);
    }
    finally { setRefreshing(false); }
  };

  /** Keep the last raw server diagnostics so a failure can be copied out. */
  const recordDebug = (label: string, payload: unknown) => {
    if (payload == null) return;
    setDiagnostics({ when: new Date().toISOString(), label, payload });
    setDiagCopied(false);
  };
  const recordError = (label: string, caught: unknown) => {
    const apiError = caught instanceof ApiError ? caught : null;
    setDiagnostics({
      when: new Date().toISOString(),
      label,
      payload: {
        message: caught instanceof Error ? caught.message : String(caught),
        code: apiError?.code ?? null,
        httpStatus: apiError?.status ?? null,
        debug: apiError?.debug ?? null,
      },
    });
    setDiagCopied(false);
    setDiagOpen(true);
  };

  /** Server-side connection test: which browser-free routes still work. */
  const runProbe = async () => {
    setProbing(true);
    try {
      const payload = await api.probe(query.trim() || 'fyp');
      recordDebug('connection test', payload);
      setDiagOpen(true);
      const verdict = typeof payload.verdict === 'string' ? payload.verdict : 'Connection test finished.';
      setFlash(verdict);
    } catch (caught) {
      recordError('connection test failed', caught);
    } finally { setProbing(false); }
  };

  const runFetch = async (overrides?: { from?: string; to?: string; q?: string; live?: boolean }) => {
    if (busyRef.current) return;
    const q = (overrides?.q ?? query).trim();
    const activePoll = collectionPoll.current;
    if (activePoll && activePoll.keyword !== q) {
      if (activePoll.timer != null) window.clearTimeout(activePoll.timer);
      collectionPoll.current = null;
      setCollecting(null);
    }
    busyRef.current = true;
    setBusy(true); setError(''); setFlash(''); setHasMore(false);
    try {
      if (feedType === 'ads') {
        const payload = await api.ads({ region, period: '30', keyword: q });
        if (!payload.videos?.length) throw new ApiError('No public ads returned', 'ads_empty');
        setAds(payload.videos); setAdsMeta(payload);
        setFlash(`${payload.videos.length} real ads loaded from TikTok Top Ads`);
      } else {
        const payload = await api.searchTikTok({
          q, count: target,
          from: overrides?.from ?? filters.dateFrom, to: overrides?.to ?? filters.dateTo,
          live: overrides?.live,
        });
        recordDebug(`search “${q || 'Explore'}”`, payload.debug);

        // The keyword is not collected yet and a GitHub Actions run was just
        // started for it. Start checking early, then poll lightly until the
        // GitHub runner publishes the exact dataset.
        if (payload.queued) {
          // Never blank the screen while exact collection runs. When the
          // rolling real-data index already has matching videos, show them now
          // and replace them automatically with the exact TikTok result later.
          if (payload.videos?.length) {
            setVideos(payload.videos); setVideosMeta(payload); setDataMode('live');
            setHasMore(Boolean(payload.hasMore)); setScanned(payload.scanned ?? payload.videos.length);
          }
          const current = collectionPoll.current;
          const sameKeyword = current?.keyword === q;
          const attempts = sameKeyword ? current.attempts + 1 : 0;
          const since = sameKeyword ? current.since : Date.now();
          if (attempts < 50) {
            if (current?.timer != null) window.clearTimeout(current.timer);
            const delay = attempts === 0 ? 10_000 : 6_000;
            const timer = window.setTimeout(() => { void runFetch({ q }); }, delay);
            collectionPoll.current = { keyword: q, since, attempts, timer };
            setCollecting({ keyword: q, since });
            setFlash(payload.notice ?? `Collecting exact “${q}” results in parallel.`);
          } else {
            collectionPoll.current = null;
            setCollecting(null);
            setError(`“${q}” is still not ready after 5 minutes. Open the GitHub Actions run to see what happened, then search again.`);
          }
          return;
        }
        if (collectionPoll.current?.timer != null) window.clearTimeout(collectionPoll.current.timer);
        collectionPoll.current = null;
        setCollecting(null);

        if (!payload.videos?.length) throw new ApiError('No videos returned', 'tiktok_empty', 0, payload.debug);
        setVideos(payload.videos); setVideosMeta(payload); setDataMode('live');
        setHasMore(Boolean(payload.hasMore)); setScanned(payload.scanned ?? payload.videos.length);
        setFlash(payload.notice
          ? payload.notice
          : payload.cached
            ? `${payload.videos.length} real TikTok videos${payload.keyword ? ` for “${payload.keyword}”` : ''} — cached ${Math.max(1, Math.round((payload.cacheAgeSeconds ?? 0) / 60))} min ago, no new browser needed`
            : `${payload.videos.length} real TikTok videos loaded${payload.keyword ? ` for “${payload.keyword}”` : ' from Explore'} — scroll for more`);
      }
    } catch (caught) {
      recordError(`search “${q || 'Explore'}” failed`, caught);
      // A keyword nobody collects yet is the usual reason a live run was needed
      // at all — say how to make it instant next time.
      const uncollected = Boolean(q) && !catalogue.some((entry) => entry.keyword.toLowerCase() === q.toLowerCase());
      const hint = uncollected
        ? ` Add “${q}” to data/keywords.json (or run the “Refresh TikTok datasets” workflow with it) and it will be collected every 30 min with no quota.`
        : '';
      if (caught instanceof ApiError && BACKENDLESS.includes(caught.code)) {
        setNeedsBackend(caught.code.startsWith('backend'));
        setError(caught.code === 'browser_rate_limited'
          ? `${caught.message}${hint}`
          : `“${q}” needs the scraping backend. Country trends come straight from TikTok and work without it.`);
        await loadTrends().catch(() => {});
      } else {
        setError(`${caught instanceof Error ? caught.message : 'Fetch failed'}${hint}`);
      }
    } finally { busyRef.current = false; setBusy(false); }
  };

  // Infinite scroll — the server keeps its TikTok session open, so each call
  // just scrolls the live feed further and returns the next unseen batch.
  const loadMore = async () => {
    if (busy || loadingMore || !hasMore || feedType !== 'videos') return;
    setLoadingMore(true);
    try {
      const payload = await api.searchTikTok({
        q: query.trim(), count: target, from: filters.dateFrom, to: filters.dateTo,
        more: true, known: videos.map((video) => video.id),
      });
      const known = new Set(videos.map((video) => video.id));
      const additions = (payload.videos ?? []).filter((video) => !known.has(video.id));
      if (additions.length) setVideos((current) => [...current, ...additions]);
      setScanned(payload.scanned ?? scanned);
      setHasMore(Boolean(payload.hasMore) && (additions.length > 0 || Boolean(payload.hasMore)));
      if (!additions.length && !payload.hasMore) setFlash('TikTok has no more results for this search.');
    } catch (caught) {
      recordError('load more failed', caught);
      setError(caught instanceof Error ? caught.message : 'Could not load more');
      setHasMore(false);
    } finally { setLoadingMore(false); }
  };

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !autoLoad || !hasMore || busy || loadingMore) return;
    const observer = new IntersectionObserver((entries) => { if (entries[0]?.isIntersecting) void loadMore(); }, { rootMargin: '600px' });
    observer.observe(node);
    return () => observer.disconnect();
  });

  const applyDatePreset = (preset: typeof datePresets[number]) => {
    setFilters((current) => ({ ...current, dateFrom: preset.from, dateTo: preset.to }));
    if (preset.id !== 'any' && feedType === 'videos' && !busy) void runFetch({ from: preset.from, to: preset.to });
  };

  const fetchCreativeCenter = async () => {
    setCcBusy(true); setError('');
    try {
      const payload = await api.trends({ region, period: '7' });
      if (!payload.videos?.length) throw new ApiError('No trend videos returned', 'trends_empty');
      setVideos(payload.videos); setVideosMeta(payload); setDataMode('live'); setActiveNav('Discover'); setFeedType('videos');
      setHasMore(false); setScanned(payload.videos.length); setNeedsBackend(false);
      setFlash(`${payload.videos.length} real trend videos loaded from TikTok Creative Center (${region})`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Creative Center fetch failed'); }
    finally { setCcBusy(false); }
  };

  const importJson = async (file?: File) => {
    if (!file) return;
    try {
      const imported = await new WorkspaceJsonProvider().importVideos(JSON.parse(await file.text()));
      if (!imported.length) throw new Error('No video records found');
      setVideos(imported); setDataMode('imported'); setActiveNav('Discover'); setFeedType('videos');
      setFlash(`${imported.length} records imported`);
    } catch (caught) { setError(`Import failed: ${caught instanceof Error ? caught.message : 'invalid JSON'}`); }
  };

  const exportData = () => {
    const rows = visible.map(({ creator, ...video }) => ({ ...video, creatorUsername: creator.username, creatorFollowers: creator.followers }));
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob); link.download = 'pulse-videos.json'; link.click();
    URL.revokeObjectURL(link.href);
  };

  const toggleWatch = (id: string) => setWatchlist((current) => {
    const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next;
  });

  const rangeRow = (label: string, minKey: keyof DiscoverFilters, maxKey?: keyof DiscoverFilters, unit?: string) => (
    <div className="rail-row" key={label}>
      <span className="rail-label">{label}{unit ? ` (${unit})` : ''}</span>
      <div className="rail-inputs">
        <input type="number" min={0} placeholder="Min" value={filters[minKey]} onChange={(event) => setFilters((c) => ({ ...c, [minKey]: event.target.value }))} />
        {maxKey && <input type="number" min={0} placeholder="Max" value={filters[maxKey]} onChange={(event) => setFilters((c) => ({ ...c, [maxKey]: event.target.value }))} />}
      </div>
    </div>
  );

  const viewsChips = [['', 'Any'], ['10000', '10K+'], ['100000', '100K+'], ['1000000', '1M+'], ['10000000', '10M+']] as const;
  const followerChips = [['', '', 'Any'], ['', '10000', 'Under 10K'], ['10000', '100000', '10K – 100K'], ['100000', '1000000', '100K – 1M'], ['1000000', '', '1M+']] as const;

  const isDiscoverLike = activeNav === 'Discover' || activeNav === 'Watchlist' || activeNav === 'Exports';

  return <div className={dark ? 'app dark' : 'app'}>
    <aside className={sidebar ? 'sidebar open' : 'sidebar'}>
      <div className="brand"><span className="brand-mark"><TrendingUp size={18} /></span>pulse<span className="brand-dot">.</span></div>
      <button className="close-sidebar" onClick={() => setSidebar(false)} aria-label="Close menu"><X size={20} /></button>
      <nav>{navItems.map(([label, Icon]) => (
        <button key={label} className={activeNav === label ? 'active' : ''} onClick={() => { setActiveNav(label); setSidebar(false); if (label === 'Exports') setView('table'); }}>
          <Icon size={17} /><span>{label}</span>
          {label === 'Watchlist' && watchlist.size > 0 && <b>{watchlist.size}</b>}
        </button>
      ))}</nav>
      <div className="sidebar-foot">
        <div className={`data-badge ${dataMode}`}>
          <span className="dot" />
          <div>
            <strong>{dataMode === 'demo' ? 'Demo data' : dataMode === 'live' ? 'Live TikTok data' : 'Imported data'}</strong>
            <small>{videosMeta ? `Updated ${relativeTime(videosMeta.fetchedAt)}` : 'Search to load real data'}</small>
          </div>
        </div>
      </div>
    </aside>

    <main>
      <header>
        <button className="icon-button mobile-menu" onClick={() => setSidebar(true)} aria-label="Open menu"><Menu size={20} /></button>
        <h1>{activeNav}</h1>
        <div className="header-actions">
          {videosMeta && <span className={`freshness ${Date.now() - new Date(videosMeta.fetchedAt).getTime() > STALE_MS ? 'stale' : ''}`}>
            {refreshing ? 'Refreshing…' : `Updated ${relativeTime(videosMeta.fetchedAt)}`}
          </span>}
          <button className="icon-button" onClick={() => void refreshFeed(query)} disabled={refreshing || busy} aria-label="Refresh data">
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
          </button>
          <button className="icon-button" onClick={() => setDark(!dark)} aria-label="Toggle theme">{dark ? <Sun size={17} /> : <Moon size={17} />}</button>
          <button className="ghost" onClick={() => fileRef.current?.click()}><Import size={16} /><span>Import</span></button>
          <input ref={fileRef} hidden type="file" accept="application/json" onChange={(event) => importJson(event.target.files?.[0])} />
          <button className="ghost" onClick={exportData}><Download size={16} /><span>Export</span></button>
        </div>
      </header>

      {isDiscoverLike && <>
        <div className="feed-tabs" role="tablist">
          <button role="tab" className={feedType === 'videos' ? 'active' : ''} onClick={() => setFeedType('videos')}><Clapperboard size={15} /> Videos <b>{enriched.length}</b></button>
          <button role="tab" className={feedType === 'ads' ? 'active' : ''} onClick={() => setFeedType('ads')}><Megaphone size={15} /> Ads <b>{enrichedAds.length}</b></button>
        </div>

        <div className="searchbar">
          <div className="search-field">
            <Search size={18} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void runFetch(); }}
              placeholder={feedType === 'ads' ? 'Search real TikTok ads — brand or product keyword' : 'Search TikTok — keyword, #hashtag or @creator'}
            />
            {query && <button className="clear" onClick={() => setQuery('')} aria-label="Clear"><X size={16} /></button>}
          </div>
          {feedType === 'videos'
            ? <select className="target-select" value={target} onChange={(event) => setTarget(event.target.value)} aria-label="Results per load">
                {['20', '40', '60', '100'].map((value) => <option key={value} value={value}>{value} per load</option>)}
              </select>
            : <select className="target-select" value={region} onChange={(event) => setRegion(event.target.value)} aria-label="Ads region">
                {fetchRegions.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>}
          <button className="search-go" onClick={() => runFetch()} disabled={busy}>{busy ? 'Searching…' : 'Search'}</button>
        </div>
        <p className="search-hint">
          Typing filters the {feed.length} loaded {feedType === 'ads' ? 'ads' : 'videos'} instantly · press <kbd>Enter</kbd> or hit Search to pull fresh results straight from TikTok{feedType === 'videos' ? ' · results keep loading as you scroll, with no cap' : ''}
        </p>

        {feedType === 'videos' && <div className="instant-keywords">
          <span>{catalogue.length > 0 ? 'Instant (collected every 30 min, no quota):' : 'Search runs over direct HTTP first — no browser quota.'}</span>
          {catalogue.map((entry) => (
            <button key={entry.slug} onClick={() => { setQuery(entry.keyword); void runFetch({ q: entry.keyword }); }} disabled={busy}
              title={`${entry.count} videos · updated ${entry.updatedAt ? relativeTime(entry.updatedAt) : 'unknown'}`}>
              {entry.keyword}
            </button>
          ))}
          <button className="live" onClick={() => void runFetch({ live: true })} disabled={busy}
            title="Skip the dataset and run a live TikTok browser now (uses Cloudflare browser quota)">
            Live fetch
          </button>
          <button className="live" onClick={() => void runProbe()} disabled={busy || probing}
            title="Ask the server which browser-free routes TikTok is answering right now">
            {probing ? 'Testing…' : 'Test connection'}
          </button>
        </div>}

        {collecting && <div className="progress-card collecting">
          <div className="progress-head">
            <strong>Collecting “{collecting.keyword}” from TikTok</strong>
            <span>{Math.round((Date.now() - collecting.since) / 1000)}s</span>
          </div>
          <div className="progress-track indeterminate"><i /></div>
          <small>Exact results are collecting on a parallel runner. Matching real videos from the fresh index stay visible now; this page replaces them automatically, then keeps loading more as you scroll.</small>
        </div>}

        {busy && !collecting && <div className="progress-card">
          <div className="progress-head">
            <strong>{progress?.phase ?? 'Starting…'}</strong>
            <span>{progress?.startedAt ? `${Math.round((Date.now() - progress.startedAt) / 1000)}s` : ''}</span>
          </div>
          <div className="progress-track"><i style={{ width: `${Math.min(100, ((progress?.matched ?? 0) / Math.max(1, progress?.target ?? Number(target))) * 100)}%` }} /></div>
          <small>{progress ? `${progress.matched} matching · ${progress.collected} scanned · target ${progress.target}` : 'Contacting TikTok…'}</small>
        </div>}
        {error && <div className="alert error"><span>{error}</span><button onClick={() => setError('')}><X size={15} /></button></div>}
        {flash && !busy && <div className="alert ok"><span>{flash}</span><button onClick={() => setFlash('')}><X size={15} /></button></div>}
        {USE_DEMO_DATA && dataMode === 'demo' && <div className="alert warn"><span><strong>DEMO MODE (VITE_USE_DEMO_DATA=true)</strong> — these videos are illustrative sample data, not real TikTok results. Search above to replace them with live data.</span></div>}
        {diagnostics && <div className="diagnostics">
          <button className="diag-head" onClick={() => setDiagOpen((open) => !open)}>
            <Bug size={14} />
            <strong>Fetch log</strong>
            <span>{diagnostics.label} · {new Date(diagnostics.when).toLocaleTimeString()}</span>
            <em>{diagOpen ? 'hide' : 'show'}</em>
          </button>
          {diagOpen && <>
            <pre>{JSON.stringify(diagnostics.payload, null, 2)}</pre>
            <div className="diag-actions">
              <button onClick={() => {
                const text = JSON.stringify({ label: diagnostics.label, when: diagnostics.when, payload: diagnostics.payload }, null, 2);
                navigator.clipboard?.writeText(text).then(() => { setDiagCopied(true); }).catch(() => setDiagCopied(false));
              }}><Copy size={13} /> {diagCopied ? 'Copied' : 'Copy log'}</button>
              <button className="ghost" onClick={() => { setDiagnostics(null); setDiagOpen(false); }}>Clear</button>
            </div>
          </>}
        </div>}

        {needsBackend && <div className="alert warn">
          <span><strong>Keyword search needs the scraping backend.</strong> Country trends work right here — they come straight from TikTok with no backend, no cookies and no login.</span>
          <button className="ghost" onClick={fetchCreativeCenter} disabled={ccBusy}>{ccBusy ? 'Loading trends…' : 'Load real trends'}</button>
        </div>}

        <div className="discover-body">
          <aside className={railOpen ? 'rail open' : 'rail'}>
            <div className="rail-head"><strong>Filters</strong>{activeFilterCount + customFilters.length > 0 && <button onClick={() => { setFilters(emptyFilters); setCustomFilters([]); }}>Clear all ({activeFilterCount + customFilters.length})</button>}</div>

            <section>
              <h3>Date posted</h3>
              <ul className="rail-options">{datePresets.map((preset) => (
                <li key={preset.id}>
                  <label>
                    <input type="radio" name="date-posted" checked={activeDateId === preset.id} onChange={() => applyDatePreset(preset)} />
                    <span>{preset.label}</span>
                  </label>
                </li>
              ))}</ul>
              <div className="rail-inputs dates">
                <input type="date" value={filters.dateFrom} onChange={(event) => setFilters((c) => ({ ...c, dateFrom: event.target.value }))} />
                <input type="date" value={filters.dateTo} onChange={(event) => setFilters((c) => ({ ...c, dateTo: event.target.value }))} />
              </div>
              {feedType === 'videos' && <p className="rail-note">Picking a date range re-searches TikTok for videos posted then.</p>}
            </section>

            <section>
              <h3>Views</h3>
              <div className="chips">{viewsChips.map(([value, label]) => (
                <button key={label} className={filters.minViews === value ? 'active' : ''} onClick={() => setFilters((c) => ({ ...c, minViews: value }))}>{label}</button>
              ))}</div>
              {rangeRow('Custom range', 'minViews', 'maxViews')}
            </section>

            <section>
              <h3>Creator size</h3>
              <div className="chips">{followerChips.map(([min, max, label]) => (
                <button key={label} className={filters.minFollowers === min && filters.maxFollowers === max ? 'active' : ''}
                  onClick={() => setFilters((c) => ({ ...c, minFollowers: min, maxFollowers: max }))}>{label}</button>
              ))}</div>
            </section>

            <section>
              <h3>Engagement</h3>
              {rangeRow('Minimum likes', 'minLikes')}
              {rangeRow('Minimum comments', 'minComments')}
              {rangeRow('Minimum shares', 'minShares')}
              {rangeRow('Engagement rate', 'minEngagement', undefined, '%')}
            </section>

            <section>
              <h3>Video length</h3>
              {rangeRow('Duration', 'minDuration', 'maxDuration', 'sec')}
            </section>

            <section>
              <h3>Custom filters</h3>
              {customFilters.length > 0 && <ul className="custom-list">{customFilters.map((custom) => {
                const meta = METRICS.find(([key]) => key === custom.metric);
                return <li key={custom.id}>
                  <span>{meta?.[1] ?? custom.metric} {custom.op === 'gte' ? '≥' : custom.op === 'lte' ? '≤' : 'between'} {custom.value}{custom.op === 'between' ? ` – ${custom.value2}` : ''} {meta?.[2]}</span>
                  <button onClick={() => setCustomFilters((current) => current.filter((entry) => entry.id !== custom.id))} aria-label="Remove filter"><X size={13} /></button>
                </li>;
              })}</ul>}
              <div className="custom-builder">
                <select value={draft.metric} onChange={(event) => setDraft((c) => ({ ...c, metric: event.target.value as MetricKey }))}>
                  {METRICS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </select>
                <div className="custom-row">
                  <select value={draft.op} onChange={(event) => setDraft((c) => ({ ...c, op: event.target.value as CustomFilter['op'] }))}>
                    <option value="gte">at least</option>
                    <option value="lte">at most</option>
                    <option value="between">between</option>
                  </select>
                  <input type="number" min={0} placeholder="Value" value={draft.value} onChange={(event) => setDraft((c) => ({ ...c, value: event.target.value }))} />
                  {draft.op === 'between' && <input type="number" min={0} placeholder="and" value={draft.value2} onChange={(event) => setDraft((c) => ({ ...c, value2: event.target.value }))} />}
                </div>
                <button className="add-filter" disabled={draft.value.trim() === ''}
                  onClick={() => {
                    setCustomFilters((current) => [...current, { id: `${draft.metric}-${current.length}-${draft.value}`, ...draft }]);
                    setDraft((c) => ({ ...c, value: '', value2: '' }));
                  }}>+ Add filter</button>
              </div>
            </section>

            <p className="rail-note">A video is hidden by a filter when TikTok did not publish that metric for it.</p>
          </aside>

          <div className="results">
            <div className="results-head">
              <div>
                <strong>{visible.length}</strong> {visible.length === 1 ? 'result' : 'results'}
                {query && <span className="for-query"> for “{query}”</span>}
                {activeFilterCount + customFilters.length > 0 && <span className="for-query"> · {activeFilterCount + customFilters.length} filter{activeFilterCount + customFilters.length > 1 ? 's' : ''}</span>}
                {scanned > 0 && <span className="for-query"> · {scanned} scanned on TikTok</span>}
              </div>
              <div className="results-tools">
                <label>Sort
                  <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
                    <option value="winningScore">Best performing</option>
                    <option value="views">Most views</option>
                    <option value="likes">Most likes</option>
                    <option value="comments">Most comments</option>
                    <option value="shares">Most shares</option>
                    <option value="engagementRate">Highest engagement</option>
                    <option value="followers">Biggest creator</option>
                    <option value="publishedAt">Newest first</option>
                    <option value="durationSeconds">Longest</option>
                    {feedType === 'ads' && <option value="ctr">Highest CTR</option>}
                  </select>
                </label>
                <div className="view-switch">
                  <button className={view === 'cards' ? 'active' : ''} onClick={() => setView('cards')} aria-label="Card view"><Grid2X2 size={15} /></button>
                  <button className={view === 'table' ? 'active' : ''} onClick={() => setView('table')} aria-label="Table view"><BarChart3 size={15} /></button>
                </div>
                {feedType === 'videos' && <label className="auto-load"><input type="checkbox" checked={autoLoad} onChange={(event) => setAutoLoad(event.target.checked)} />Auto-load on scroll</label>}
                <button className="rail-toggle" onClick={() => setRailOpen(!railOpen)}>Filters{activeFilterCount + customFilters.length > 0 ? ` (${activeFilterCount + customFilters.length})` : ''}</button>
              </div>
            </div>

            {visible.length === 0
              ? <div className="empty">
                  <Search size={30} />
                  <h3>Nothing to show yet</h3>
                  <p>{collecting && feedType === 'videos'
                    ? `Collecting exact real results for “${collecting.keyword}” now — they will appear here automatically.`
                    : feed.length === 0
                      ? `Hit Search to pull real ${feedType === 'ads' ? 'ads' : 'videos'} from TikTok via the backend.`
                    : (filters.dateFrom || filters.dateTo)
                      ? 'No loaded video was posted in that date range — try a wider range or search again.'
                      : 'No loaded result matches these filters — try clearing a few.'}</p>
                </div>
              : <>
                  {view === 'cards'
                    ? <div className="grid">{visible.map((video) => <VideoCard key={video.id} video={video} saved={watchlist.has(video.id)} onSave={() => toggleWatch(video.id)} onDownloadError={setError} />)}</div>
                    : <ResultTable videos={visible} saved={watchlist} onSave={toggleWatch} onDownloadError={setError} />}

                  {feedType === 'videos' && <div className="load-zone" ref={sentinelRef}>
                    {loadingMore
                      ? <span className="loading-more"><span className="spinner" /> Loading more from TikTok…</span>
                      : hasMore
                        ? <button className="load-more" onClick={() => void loadMore()}>Load more results</button>
                        : videos.length > 0 && <span className="end-note">That's everything TikTok returned for this search · {scanned} videos scanned</span>}
                  </div>}
                </>}
          </div>
        </div>
      </>}

      {activeNav === 'Overview' && <div className="overview">
        <div className="stat-grid">
          {[
            ['Videos loaded', formatMetric(enriched.length), Play],
            ['Total views', formatMetric(totals.views), Eye],
            ['Total likes', formatMetric(totals.likes), Heart],
            ['Avg. engagement', totals.engagement == null ? '—' : `${totals.engagement.toFixed(1)}%`, Flame],
          ].map(([label, value, Icon]) => {
            const IconComponent = Icon as typeof Eye;
            return <article className="stat" key={label as string}>
              <IconComponent size={17} /><span>{label as string}</span><strong>{value as string}</strong>
            </article>;
          })}
        </div>

        <div className="overview-cols">
          <section className="panel">
            <h2>Data sources</h2>
            <p className="panel-note">Everything is public data pulled live on this machine — no API key, no login.</p>
            <div className="source-row">
              <div><strong>TikTok search &amp; Explore</strong><small>Full stats + playable videos. Used by the Discover search bar.</small></div>
              <button className="ghost" onClick={() => { setActiveNav('Discover'); setFeedType('videos'); }}>Go to search</button>
            </div>
            <div className="source-row">
              <div><strong>Creative Center trends</strong><small>Country trend rankings — no likes/comments on that surface.</small></div>
              <span className="inline-controls">
                <select value={region} onChange={(event) => setRegion(event.target.value)}>{fetchRegions.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select>
                <button className="ghost" onClick={fetchCreativeCenter} disabled={ccBusy}>{ccBusy ? 'Fetching…' : 'Fetch'}</button>
              </span>
            </div>
            <div className="source-row">
              <div><strong>Top Ads</strong><small>Real ads with CTR, cost tier, industry and objective.</small></div>
              <button className="ghost" onClick={() => { setActiveNav('Discover'); setFeedType('ads'); }}>Go to ads</button>
            </div>
          </section>

          <section className="panel">
            <h2>Top hashtags in this dataset</h2>
            {topHashtags.length === 0 ? <p className="panel-note">No hashtags in the loaded videos yet.</p> : <div className="tag-cloud">
              {topHashtags.map(([tag, stats]) => (
                <button key={tag} onClick={() => { setQuery(`#${tag}`); setActiveNav('Discover'); }}>
                  <Hash size={12} />{tag}<em>{formatMetric(stats.views)}</em>
                </button>
              ))}
            </div>}
          </section>
        </div>
      </div>}

      {activeNav === 'Creators' && <div className="directory">
        {creators.length === 0 ? <div className="empty"><Users size={30} /><h3>No creators yet</h3><p>Search TikTok first.</p></div> : creators.map((creator) => (
          <article key={creator.username ?? creator.displayName}>
            <span className="avatar">{creator.avatarUrl ? <img src={creator.avatarUrl} alt="" /> : creator.displayName.slice(0, 1)}</span>
            <div className="who"><strong>{creator.displayName}</strong><small>{creator.username ? `@${creator.username}` : 'Username unavailable'}</small></div>
            <dl>
              <div><dt>Followers</dt><dd>{formatMetric(creator.followers)}</dd></div>
              <div><dt>Following</dt><dd>{formatMetric(creator.following)}</dd></div>
              <div><dt>Total likes</dt><dd>{formatMetric(creator.totalLikes)}</dd></div>
            </dl>
            <a href={creator.profileUrl} target="_blank" rel="noreferrer">Open profile</a>
          </article>
        ))}
      </div>}

      {activeNav === 'Sounds' && <div className="directory">
        {sounds.length === 0 ? <div className="empty"><Music2 size={30} /><h3>No sounds yet</h3><p>Search TikTok first — sound data comes with real videos.</p></div> : sounds.map((sound) => (
          <article key={`${sound.name}:${sound.author}`}>
            <span className="avatar"><Music2 size={16} /></span>
            <div className="who"><strong>{sound.name}</strong><small>{sound.author ?? 'Author unavailable'}</small></div>
            <dl>
              <div><dt>Videos</dt><dd>{sound.videos}</dd></div>
              <div><dt>Total views</dt><dd>{formatMetric(sound.views)}</dd></div>
            </dl>
          </article>
        ))}
      </div>}
    </main>
  </div>;
}

function DownloadVideoLink({ source, id, className, onProblem }: { source: string; id: string; className: string; onProblem: (message: string) => void }) {
  const [checking, setChecking] = useState(false);
  const href = api.videoDownloadUrl(source, id);

  const startDownload = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (checking) return;
    setChecking(true);
    try {
      // Test a single byte before navigating. This prevents browsers from
      // saving an error page as a fake .mp4 when TikTok denies a CDN source.
      const probe = await fetch(href, { headers: { range: 'bytes=0-0' } });
      if (!probe.ok) {
        let message = 'TikTok is not permitting this video file to be downloaded right now. Try a newer result or open it on TikTok.';
        if ((probe.headers.get('content-type') ?? '').includes('application/json')) {
          const payload = await probe.json().catch(() => null) as { error?: { message?: string } } | null;
          message = payload?.error?.message ?? message;
        }
        await probe.body?.cancel();
        throw new Error(message);
      }
      const contentType = probe.headers.get('content-type') ?? '';
      await probe.body?.cancel();
      if (!contentType.startsWith('video/')) throw new Error('The server did not return a video file, so nothing was downloaded.');
      // The full navigation keeps the download streaming instead of buffering
      // a potentially large video in the browser's JavaScript heap.
      window.location.assign(href);
    } catch (error) {
      onProblem(error instanceof Error ? error.message : 'Could not verify this TikTok video download.');
    } finally {
      setChecking(false);
    }
  };

  return <a className={className} href={href} onClick={(event) => void startDownload(event)}
    title={checking ? 'Checking video availability…' : "Download TikTok's public source file"}
    aria-label="Download video" aria-busy={checking}><Download size={15} /></a>;
}

function VideoCard({ video, saved, onSave, onDownloadError }: { video: EnrichedVideo; saved: boolean; onSave: () => void; onDownloadError: (message: string) => void }) {
  const isAd = video.kind === 'ad';
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const playable = Boolean(video.videoFileUrl) && !failed;
  // Prefer the stable R2 copy; otherwise download through the same proxied
  // stream that is already playing the video. The proxy refuses non-video
  // bytes, so an expired source shows an error instead of saving an HTML file.
  const downloadable = (api.isHostedMediaUrl(video.downloadFileUrl) ? video.downloadFileUrl : null)
    ?? video.videoFileUrl ?? null;

  return <article className={isAd ? 'card is-ad' : 'card'}>
    <div className={playable ? 'card-media playable' : 'card-media'} onClick={() => playable && !playing && setPlaying(true)}>
      {playing && playable
        ? <video src={api.videoStreamUrl(video.videoFileUrl!)} poster={video.thumbnailUrl ?? undefined} controls autoPlay playsInline onError={() => { setFailed(true); setPlaying(false); }} />
        : <>
            {video.thumbnailUrl ? <img src={video.thumbnailUrl} alt="" loading="lazy" decoding="async" /> : <div className="no-media"><Play size={22} /></div>}
            {playable && <span className="play"><Play size={20} fill="currentColor" /></span>}
          </>}
      {isAd ? <span className="badge ad">Ad</span> : <span className={`badge score s${Math.min(4, Math.floor(video.winningScore / 25))}`}>{video.winningScore}</span>}
      {video.durationSeconds != null && <span className="badge dur">{video.durationSeconds}s</span>}
      <button className={saved ? 'save on' : 'save'} onClick={(event) => { event.stopPropagation(); onSave(); }} aria-label="Save"><Bookmark size={15} fill={saved ? 'currentColor' : 'none'} /></button>
      {downloadable && <DownloadVideoLink className="download-media" source={downloadable} id={video.id} onProblem={onDownloadError} />}
    </div>

    <div className="card-body">
      <a className="card-title" href={video.url} target="_blank" rel="noreferrer">{video.caption || 'No caption'}</a>
      <div className="card-creator">
        <span className="avatar sm">{video.creator.avatarUrl ? <img src={video.creator.avatarUrl} alt="" /> : video.creator.displayName.slice(0, 1)}</span>
        <span className="name">{video.creator.username ? `@${video.creator.username}` : video.creator.displayName}</span>
        <span className="sep">·</span>
        <span>{isAd ? (video.industry ?? 'Advertiser') : `${formatMetric(video.creator.followers)} followers`}</span>
      </div>

      <div className="card-metrics">
        {isAd
          ? <>
              <div><Heart size={14} /><b>{formatMetric(video.likes)}</b></div>
              <div><TrendingUp size={14} /><b>{video.ctr == null ? '—' : `${video.ctr.toFixed(2)}%`}</b><i>CTR</i></div>
              <div><MessageCircle size={14} /><b>{formatMetric(video.comments)}</b></div>
              <div><Share2 size={14} /><b>{formatMetric(video.shares)}</b></div>
            </>
          : <>
              <div className="lead"><Eye size={14} /><b>{formatMetric(video.views)}</b></div>
              <div><Heart size={14} /><b>{formatMetric(video.likes)}</b></div>
              <div><MessageCircle size={14} /><b>{formatMetric(video.comments)}</b></div>
              <div><Share2 size={14} /><b>{formatMetric(video.shares)}</b></div>
            </>}
      </div>

      <div className="card-foot">
        <span className="eng">{video.engagementRate == null ? 'Engagement —' : `${video.engagementRate.toFixed(1)}% engagement`}</span>
        <span className="when"><Clock3 size={12} />{video.publishedAt ? `${formatDate(video.publishedAt)} · ${formatAge(video.ageHours)}` : 'Date unavailable'}</span>
      </div>
    </div>
  </article>;
}

function ResultTable({ videos, saved, onSave, onDownloadError }: { videos: EnrichedVideo[]; saved: Set<string>; onSave: (id: string) => void; onDownloadError: (message: string) => void }) {
  return <div className="table-wrap">
    <table>
      <thead><tr>
        <th>Video</th><th>Creator</th><th>Posted</th><th>Views</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Engagement</th><th>Length</th><th>Score</th><th />
      </tr></thead>
      <tbody>{videos.map((video) => (
        <tr key={video.id}>
          <td>
            <div className="cell-video">
              {video.thumbnailUrl && <img src={video.thumbnailUrl} alt="" loading="lazy" decoding="async" />}
              <a href={video.url} target="_blank" rel="noreferrer">{video.caption || 'No caption'}</a>
            </div>
          </td>
          <td><strong>{video.creator.username ? `@${video.creator.username}` : video.creator.displayName}</strong><small>{video.kind === 'ad' ? (video.industry ?? 'Ad') : `${formatMetric(video.creator.followers)} followers`}</small></td>
          <td><strong>{formatDate(video.publishedAt)}</strong><small>{video.ageHours == null ? '—' : `${formatAge(video.ageHours)} old`}</small></td>
          <td>{formatMetric(video.views)}</td>
          <td>{formatMetric(video.likes)}</td>
          <td>{formatMetric(video.comments)}</td>
          <td>{formatMetric(video.shares)}</td>
          <td>{video.engagementRate == null ? '—' : `${video.engagementRate.toFixed(1)}%`}</td>
          <td>{video.durationSeconds == null ? '—' : `${video.durationSeconds}s`}</td>
          <td>{video.kind === 'ad' ? <span className="pill ad">Ad</span> : <span className="pill">{video.winningScore}</span>}</td>
          <td className="table-actions">
            {(api.isHostedMediaUrl(video.downloadFileUrl) || video.videoFileUrl)
              ? <DownloadVideoLink className="icon-button" source={(api.isHostedMediaUrl(video.downloadFileUrl) ? video.downloadFileUrl : null) ?? video.videoFileUrl!} id={video.id} onProblem={onDownloadError} />
              : null}
            <button className="icon-button" onClick={() => onSave(video.id)} aria-label="Save"><Bookmark size={15} fill={saved.has(video.id) ? 'currentColor' : 'none'} /></button>
          </td>
        </tr>
      ))}</tbody>
    </table>
  </div>;
}

export default App;
