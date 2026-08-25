# Pulse — TikTok Trend Intelligence

Discover real public TikTok videos and ads with their real engagement metrics,
then filter, sort and scroll through them without a cap.

Read [`CLAUDE.md`](CLAUDE.md) before changing anything: it holds the deployment
contract and the rules that must not be reverted.

## Repository layout

| Path | Role |
| --- | --- |
| `dashboard/` | React + Vite SPA. Static frontend, deployed to Cloudflare Workers. |
| `backend/` | Node + Playwright scraping API. Runs on a normal Node host. |
| `tiktok-profile-scraper-main/` | Apify profile collector; source of the field mapping reused by the backend. |
| `tiktok-scraper-master/` | Legacy 2020 scraper, reference only. |
| `docs/DEPLOYMENT.md` | Full deployment and verification guide. |

## Architecture in one picture

```
Browser ──HTML/JS──► Cloudflare Workers   (static SPA, no /api routes)
        └──/api/*──► Node backend         (Playwright + Chromium → public TikTok)
```

Cloudflare serves static assets only, and its SPA fallback answers unknown paths
with `index.html`. The frontend therefore points at the backend through
`VITE_API_BASE_URL` and checks every response's content type before parsing —
that is what removed the `Unexpected token '<', "<!doctype "...` failure.

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
