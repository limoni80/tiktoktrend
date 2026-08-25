# CLAUDE.md — project context for future sessions

Read this file **before** changing anything in this repository. It records the
architecture, the deployment contract, and the rules that must survive future
tasks. Keep it up to date when any of them change.

---

## 1. What this project is

**Pulse — TikTok Trend Intelligence.** A dashboard for discovering real,
public TikTok videos and ads with their real engagement metrics, plus filtering,
sorting and unbounded pagination.

| Directory | Role |
| --- | --- |
| `dashboard/` | React + Vite SPA. **Static frontend only.** Deployed to Cloudflare Workers. |
| `backend/` | Node + Playwright scraping API. **Must run on a real Node host.** |
| `tiktok-profile-scraper-main/` | Apify profile collector; source of the field mapping reused by `backend/src/normalize.mjs`. |
| `tiktok-scraper-master/` | Legacy 2020 scraper kept for reference. Its internal endpoints are dead — do not wire it up as a live provider. |
| `docs/DEPLOYMENT.md` | How to deploy both halves. |

## 2. Architecture

```
Browser
  │
  ├─ HTML/CSS/JS ────────────► Cloudflare Workers (static assets, SPA fallback)
  │                             repo root wrangler.jsonc → dashboard/dist
  │
  └─ /api/* (VITE_API_BASE_URL) ─► Node backend (Playwright + Chromium)
                                     └─► public TikTok pages & endpoints
```

- **Cloudflare hosts static assets only.** It has no `/api` routes, and
  `not_found_handling: single-page-application` means any unknown path returns
  `index.html`. That is exactly why the frontend must never call relative
  `/api/...` URLs in production, and must always check the response
  `Content-Type` before `JSON.parse`.
- **The scraper needs a Node.js runtime with a real Chromium**, so it cannot run
  on Cloudflare Workers. It is a separate deployment (Railway / Render / Fly.io /
  VPS / Docker).
- Frontend → backend URL construction lives in **one module**:
  `dashboard/src/api.ts`. Do not scatter `fetch('/api/...')` calls again.

### Data sources (all public, no paid API)

| Source | Endpoint | Gives | Does not give |
| --- | --- | --- | --- |
| tiktok.com search / Explore | `/api/fetch-tiktok` | views, likes, comments, shares, saves, creator followers/following/total likes, publish date, duration, sound, playable URL | — |
| Creative Center trends | `/api/fetch` | country ranking, views, followers, TikTok's own engagement rate, 6s watch rate | likes, comments, shares, saves |
| Creative Center Top Ads | `/api/fetch-ads` | ad title, brand, likes, CTR, cost tier, industry, objective, duration, playable URL | views, saves, follower counts |

Missing metrics stay `null`. **Never estimate or fabricate a metric**, and never
let a filter treat a missing value as if it satisfied the condition.

## 3. Deployment contract — do not revert

- Repo root `wrangler.jsonc` builds the Vite dashboard and deploys
  `dashboard/dist`. **Do not point Cloudflare back at the raw `dashboard/`
  directory.** The current deployment fix is commit `ac7a76b`.
- Frontend URL: `https://tiktoktrend.limoniastrum.workers.dev`
- `main` on GitHub and the Cloudflare deployment must both keep working.
- `dashboard/server.mjs` is a **development-only** launcher (Vite middleware +
  the backend router on one origin). Production must never start Vite:
  production runs `npm --prefix backend start`.

## 4. Production must never silently use sample data

- `dashboard/src/sample-data.ts` may only be loaded when
  `VITE_USE_DEMO_DATA=true`. A production build without that flag **tree-shakes
  the sample data out of the bundle entirely** — verify with
  `grep -c "Aria Studio" dashboard/dist/assets/*.js` (expected: `0`).
- If the backend is unreachable or answers with HTML, the UI must show a clear
  “Backend unavailable” error. It must **not** fall back to demo videos, and it
  must **not** call `JSON.parse` on an HTML body.
- Demo mode, when explicitly enabled, must be labelled in the UI.

## 5. Security rules

Never commit, log, or persist:

- TikTok cookies or session tokens (`TIKTOK_COOKIE` is env-only; the backend
  keeps captured cookies **in memory only**)
- Chrome/Playwright browser profiles or user-data directories
- `dashboard/data/` (scraped datasets, debug dumps)
- `.env` files, API keys, credentials
- `node_modules/`, `dist/`, build output

The backend deliberately uses **ephemeral Playwright contexts** — no persistent
profile — so it can run on a read-only or throwaway container filesystem.

## 6. Verification commands (run before every commit)

```bash
# Frontend
npm --prefix dashboard ci
npm --prefix dashboard run typecheck
npm --prefix dashboard run build
grep -c "Aria Studio" dashboard/dist/assets/*.js   # must print 0

# Backend
npm --prefix backend install
npm --prefix backend start &                       # or: docker build/run backend
curl -s localhost:8787/api/health | jq .
curl -s "localhost:8787/api/nope" -w '\n%{http_code} %{content_type}\n'   # JSON 404
node backend/scripts/verify.mjs http://localhost:8787 dog                 # real search
```

`backend/scripts/verify.mjs` is the end-to-end check: health, JSON-only errors,
a real TikTok search, real `tiktok.com` video URLs, and per-metric coverage.

**Known environment limitation:** an Anthropic cloud sandbox usually cannot
reach `www.tiktok.com` (the egress proxy returns `ERR_TUNNEL_CONNECTION_FAILED`).
In that environment the backend correctly answers
`502 {"error":{"code":"tiktok_unreachable"}}`. Real-data verification must
therefore be run on a host with open outbound internet (the user's machine or
the deployed backend). Do not claim real data works without such a run.

## 7. Environment variables

Backend (`backend/.env.example`): `PORT`, `HOST`, `NODE_ENV`,
`ALLOWED_ORIGINS`, `CHROME_PATH`, `REQUEST_TIMEOUT_MS`, `SESSION_IDLE_MS`,
`MAX_BATCH`, `TIKTOK_COOKIE` (optional escape hatch, never committed).

Frontend (`dashboard/.env.example`): `VITE_API_BASE_URL` (**required in
production**), `VITE_USE_DEMO_DATA`.

## 8. Files that must not be reverted

- `wrangler.jsonc` (build hook + `dashboard/dist` assets + SPA fallback)
- `dashboard/src/api.ts` (single source of API URLs, content-type guards)
- `backend/src/**` (production API; no persistent profile)
- `.gitignore` entries for data, profiles, env files
- This `CLAUDE.md`
