# Pulse — TikTok Trend Intelligence Dashboard

Premium local dashboard for analyzing public TikTok trend datasets. Missing values remain unavailable (`—`) rather than being converted to zero.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:4173/`. The local server uses the installed Chrome browser to render TikTok Creative Center public trend pages. No API key, TikTok profile input, login cookie, or private session is used.

Production validation:

```bash
npm run typecheck
npm run build
```

## Fetch real public trends

Use **Fetch real data** and choose a country and a 7/30-day period. The provider reads TikTok Creative Center's public video ranking page and returns only fields present on that page:

- caption and thumbnail
- creator display name and follower count
- video views
- selected country and collection timestamp

Likes, comments, shares, saves, publish date, duration, sound, and username are not exposed on the public ranking page and remain `—`. The app does not estimate or fabricate them.

TikTok's current official country selector does not include Morocco. The UI says this explicitly instead of pretending Morocco-specific results are available.

## Import scraper data

Use **Import data** to load JSON produced by either existing workspace scraper:

- `tiktok-profile-scraper-main`: `{ profile, videos: [...] }`
- `tiktok-scraper-master`: collector records with `authorMeta`, counts, covers, and music metadata

`WorkspaceJsonProvider` normalizes both shapes. The sample feed is explicitly labelled demo data and is replaced when public trends are fetched or JSON is imported.

## Discover page

**Discover** is now a dedicated page with two feeds:

- **Videos** — the active organic dataset (fetched trends or imported scraper JSON)
- **Ads** — real ads from TikTok Creative Center's public Top Ads dashboard

Filters available on both feeds: text search, country, min/max views, min likes, min comments, min shares, min/max followers, posted after/before, min/max duration, and min engagement. A record is excluded by a filter when the source did not provide that metric — nothing is estimated.

## Real trend data (upgraded)

`/api/fetch` now reads TikTok One Creative Suite's public JSON API (`CreativeCenterGetTopContentsList`) instead of scraping the rendered page. Each fetch sweeps all 12 public content categories and 3 ranking metrics, deduplicates, and returns up to ~60 videos with: caption, cover, creator username + avatar + followers, publish date, lifetime and period views, TikTok-supplied engagement rate, 6s watch rate, and a direct `tiktok.com` video URL. Likes/comments/shares are still not public on this surface and remain `—`. If the JSON API is unreachable, the old rendered-page scraper is used as fallback.

## TikTok.com fetch (full stats + playable videos)

The Discover → Videos tab has a TikTok.com bar: empty input fetches the public **Explore** feed (follows your IP region), a keyword runs a real **TikTok search**. Items include full public stats — views, likes, comments, shares, saves, followers, publish date, duration, sound — plus a playable video. Playback streams through the local `/api/video` proxy using the fetch session's cookies; play URLs expire after a few hours, so refetch if playback stops. If TikTok shows a captcha, the error is surfaced — nothing is fabricated.

## Real ads data

`/api/fetch-ads?region=US&period=30&keyword=fitness` opens the public Top Ads dashboard in the local browser and reads the JSON the page itself receives (the page signs its own requests; nothing is forged). Keyword search is supported. Each ad includes: ad title, brand, likes, CTR, cost tier, industry, campaign objective, duration, cover, and a playable video URL. Anonymous access is limited to roughly 20-60 ads per query before TikTok's login wall.

## Dataset persistence

Every successful fetch is saved to `dashboard/data/last-videos.json` / `last-ads.json`. On startup the app loads the last saved datasets via `/api/datasets`, so real data survives restarts — the demo dataset only appears when nothing has ever been fetched.

## Derived metrics

- Engagement: `(likes + comments + shares) / views × 100`
- Like/comment/share rates: respective action divided by views
- Follower efficiency: `views / max(followers, 1)`
- Winning score: normalized velocity (32%), engagement (24%), share rate (12%), follower efficiency (18%), and freshness (14%)

Only available signals contribute. Velocity is never estimated from total views and age.

## Provider limitations

The bundled `tiktok-scraper-master` is a legacy 2020 scraper. Its former internal endpoints now return no posts, so it is not used as the live provider. Pulse uses TikTok Creative Center's public rendered page instead. If TikTok changes that page or blocks rendering, the fetch returns a visible error and never substitutes demo records.
