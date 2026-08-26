# Pulse — TikTok Trend Intelligence

Discover real public TikTok videos and ads with their real engagement metrics,
then filter, sort and scroll through them without a cap.

Read [`CLAUDE.md`](CLAUDE.md) before changing anything: it holds the deployment
contract and the rules that must not be reverted.

## Repository layout

| Path | Role |
| --- | --- |
| `worker/` | Cloudflare Worker: owns `/api/*` and serves the SPA assets. |
| `dashboard/` | React + Vite SPA, deployed to Cloudflare as static assets. |
| `backend/` | Node + Playwright scraping API. Runs on a normal Node host. |
| `tiktok-profile-scraper-main/` | Apify profile collector; source of the field mapping reused by the backend. |
| `tiktok-scraper-master/` | Legacy 2020 scraper, reference only. |
| `docs/DEPLOYMENT.md` | Full deployment and verification guide. |

## Architecture in one picture

```
Browser ──► Cloudflare Worker
              ├─ /            → SPA assets (dashboard/dist)
              ├─ /api/fetch   → REAL TikTok trends, fetched by the Worker
              │                 itself: no backend, no cookies, no login
              ├─ /api/video   → TikTok CDN proxy (Range supported)
              └─ /api/fetch-tiktok, /api/fetch-ads
                              → proxied to BACKEND_URL (Node + Playwright)
```

The Worker intercepts `/api/*` before the asset handler, so those paths always
return JSON instead of `index.html` — that is what removed the
`Unexpected token '<', "<!doctype "...` failure.

**What works with no backend at all:** country trend videos (views, creator
followers, TikTok's own engagement rate), video playback, health.
**What needs `backend/`:** keyword search and Top Ads, because they require a
real Chromium that Cloudflare Workers cannot run.

## Quick start (local)

```bash
npm --prefix dashboard install
npm --prefix backend install
npm --prefix dashboard run dev     # http://localhost:4173 — SPA + /api on one origin
```

## Production

```bash
# 1. Backend (Docker, Railway, Render, Fly.io or a VPS — see docs/DEPLOYMENT.md)
cd backend && docker build -t pulse-backend . && docker run -p 8787:8787 \
  -e NODE_ENV=production -e ALLOWED_ORIGINS=https://tiktoktrend.limoniastrum.workers.dev pulse-backend

# 2. Frontend (Cloudflare Workers)
VITE_API_BASE_URL=https://<your-backend> npm --prefix dashboard run build
npx wrangler deploy
```

Live frontend: <https://tiktoktrend.limoniastrum.workers.dev>

## API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Liveness + configuration snapshot |
| `GET /api/fetch-tiktok?q=&count=&from=&to=&more=1` | Real TikTok search / Explore feed, paginated |
| `GET /api/fetch?region=&period=` | Creative Center country trends |
| `GET /api/fetch-ads?region=&period=&keyword=` | Creative Center Top Ads |
| `GET /api/progress` | Live progress of the running scrape |
| `GET /api/datasets` | Last successful payloads (real data, in memory) |
| `GET /api/video?src=` | Range-capable proxy for TikTok play URLs |

Every `/api` response is JSON. Errors are
`{"error":{"code":"...","message":"..."}}` with a matching HTTP status — HTML is
never returned.

## Metrics honesty

| Source | Real metrics | Not published by the source |
| --- | --- | --- |
| tiktok.com search / Explore | views, likes, comments, shares, saves, followers, following, total likes, publish date, duration, sound, playable URL | — |
| Creative Center trends | views, followers, engagement rate, 6s watch rate | likes, comments, shares, saves |
| Creative Center Top Ads | likes, CTR, cost tier, industry, objective, duration, playable URL | views, saves, followers |

Missing values stay `—` in the UI and `null` in the API. Nothing is estimated,
and a filter never treats a missing value as a match.

## Demo data

`dashboard/src/sample-data.ts` is only loaded when `VITE_USE_DEMO_DATA=true`, and
the UI labels it loudly. A production build without the flag tree-shakes it out
completely:

```bash
grep -c "Aria Studio" dashboard/dist/assets/*.js   # 0
```
