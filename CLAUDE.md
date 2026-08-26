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
| `worker/` | Cloudflare Worker script. Owns `/api/*` on the deployed site and serves the SPA from the ASSETS binding. |
| `dashboard/` | React + Vite SPA. Deployed to Cloudflare Workers as static assets. |
| `backend/` | Node + Playwright scraping API. **Must run on a real Node host.** |
| `tiktok-profile-scraper-main/` | Apify profile collector; source of the field mapping reused by `backend/src/normalize.mjs`. |
| `tiktok-scraper-master/` | Legacy 2020 scraper kept for reference. Its internal endpoints are dead — do not wire it up as a live provider. |
| `docs/DEPLOYMENT.md` | How to deploy both halves. |

## 2. Architecture

```
Browser
  │
  └─► Cloudflare Worker (worker/index.js)
        ├─ non-/api  ──► ASSETS binding → dashboard/dist (SPA fallback)
        ├─ /api/health, /api/video      ──► answered by the Worker
        ├─ /api/fetch  (country trends) ──► Worker fetches TikTok Creative
        │                                   Center directly. Real data, no
        │                                   browser, no cookies, no login.
        └─ /api/fetch-tiktok, /api/fetch-ads
                        ──► proxied to BACKEND_URL (Node + Playwright)
                            or a structured 501 when it is not set
```

**The Worker never lets `/api/*` reach the asset handler.** That is the
structural fix for `Unexpected token '<', "<!doctype "...`: those paths now
always return JSON, even on error.

- Cloudflare's `not_found_handling: single-page-application` still returns
  `index.html` for unknown *asset* paths — which is why `worker/index.js` must
  keep intercepting `/api/*` before the ASSETS binding, and why
  `dashboard/src/api.ts` must keep checking `Content-Type` before `JSON.parse`.
- **Keyword search cannot run on Cloudflare.** It needs a real Chromium, so it
  lives in `backend/` and the Worker proxies to it via the `BACKEND_URL`
  variable. Country trends need no backend at all.
- **The scraper needs a Node.js runtime with a real Chromium**, so it cannot run
  on Cloudflare Workers. It is a separate deployment (Railway / Render / Fly.io /
  VPS / Docker).
- **Browser Rendering quota is the tightest constraint on Cloudflare.** The
  free plan allows only *2 concurrent browsers and 2 new browsers per minute
  per account*. `worker/index.js` therefore: reuses an idle
  `puppeteer.sessions()` session before launching, launches with
  `keep_alive: 600_000` so the next request can reuse it, `disconnect()`s
  instead of `close()`, retries a 429 with backoff for ~40 s, and caches
  first-page searches in the Cache API (fresh for 2 min, kept 1 h as a
  rate-limit fallback). Do not add code that launches a browser on page load or
  on a timer.
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
  `dashboard/dist` through the `ASSETS` binding, with `main: worker/index.js`.
  **Do not point Cloudflare back at the raw `dashboard/` directory, and do not
  remove `main` — without it `/api/*` returns HTML again.** The original
  deployment fix is commit `ac7a76b`; the Worker API layer builds on it.
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

Worker (`wrangler.jsonc` vars / Cloudflare dashboard): `BACKEND_URL` — public
URL of the Node backend. Empty means trends-only.

Frontend (`dashboard/.env.example`): `VITE_API_BASE_URL` (optional now — leave
empty to use the Worker's own `/api` on the same origin; set it to call a
backend directly), `VITE_USE_DEMO_DATA`.

## 8. Files that must not be reverted

- `wrangler.jsonc` (`main: worker/index.js` + build hook + `dashboard/dist`
  assets + `ASSETS` binding + SPA fallback)
- `worker/index.js` (API routes must stay ahead of the ASSETS binding)
- `dashboard/src/api.ts` (single source of API URLs, content-type guards)
- `backend/src/**` (production API; no persistent profile)
- `.gitignore` entries for data, profiles, env files
- This `CLAUDE.md`
