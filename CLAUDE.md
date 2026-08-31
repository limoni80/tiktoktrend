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
| `tiktok-profile-scraper-main/` | Apify profile collector. Source of the field mapping in `backend/src/normalize.mjs` **and of the browser-free technique** in `worker/tiktok-http.js`: plain HTTP + `__UNIVERSAL_DATA_FOR_REHYDRATION__` + cookies from the first response. |
| `tiktok-scraper-master/` | Legacy 2020 scraper. Reference for web-API parameter names only — its `_signature` scheme and `m.tiktok.com` endpoints are dead. Do not wire it up as a live provider. |
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
- **Keyword search does run on Cloudflare, without a browser.**
  `worker/tiktok-http.js` fetches TikTok's server-rendered pages and its own
  list endpoints with plain `fetch`. `backend/` (Node + Playwright) remains the
  optional high-fidelity provider behind `BACKEND_URL`; country trends need
  neither.
- **Browser Rendering quota is the tightest constraint on Cloudflare.** Workers
  Free gives 3 concurrent browsers, one new browser every 20 seconds, and
  **10 minutes of browser time per day per account** — a hard daily wall.
  So the browser is the *last* resort: `worker/index.js` reuses an idle
  `puppeteer.sessions()` session before launching, launches with
  `keep_alive: 600_000`, `disconnect()`s instead of `close()`, retries a 429
  only briefly (~12 s, because HTTP was already tried), and caches first-page
  searches in the Cache API. Never launch a browser on page load or on a timer,
  and never put the browser ahead of the HTTP provider.
- Frontend → backend URL construction lives in **one module**:
  `dashboard/src/api.ts`. Do not scatter `fetch('/api/...')` calls again.

### Search resolution order (do not reorder without reading this)

```
/api/fetch-tiktok
  1. Exact GitHub Actions dataset page (< 30 min)       → instant, no quota  ← primary
  2. Worker cache           (same search < 2 min)       → no quota
  3. rolling-index preview + parallel workflow_dispatch → visible now; exact replaces it
  4. worker/tiktok-http.js  DIRECT HTTP when no preview → no quota, but see below
  5. Exact dataset of ANY age (labelled with its age)    → no quota
  6. Browser Rendering      genuinely last              → 10 min/DAY, free plan
```

**Measured, not assumed (`/api/probe`, 2026-08-29):** direct HTTP from a
Cloudflare Worker gets `200 OK`, a ~350 KB page and a ~260 KB
`__UNIVERSAL_DATA_FOR_REHYDRATION__` that contains **only app config** — zero
items, no `challengeId`, and the generic “TikTok - Make Your Day” title. That
is IP-level anti-bot: no header, signature, cookie or retry changes it from
Cloudflare. The same collector on a **GitHub Actions runner returns 60/60
videos per keyword**. So Cloudflare serves data; it does not gather it.

Therefore step 5 is the engine that makes *any* keyword work: when a keyword
has no dataset, the Worker fires `workflow_dispatch` on
`.github/workflows/refresh-data.yml` with that keyword, answers
`{ queued: true, etaSeconds }`, and the dashboard retries by itself. Requires
`GITHUB_REPO` (var) and `GITHUB_TOKEN` (**secret only** —
`npx wrangler secret put GITHUB_TOKEN`, fine-grained PAT, this repo,
*Actions: read and write* and *Contents: read* when the repository is private).
A 2-minute per-keyword cooldown stops repeat
dispatches.

Step 1 always probes the deterministic exact slug. Approximate matches may be
shown only as a clearly labelled rolling-index preview while the exact keyword
collects; they must never prevent that exact collection from being dispatched.

Scheduled collection is a dynamic GitHub Actions matrix (up to 10 collectors
in parallel). Each collector emits one shard; a short serialized `publish` job
uses `backend/scripts/merge-publish.mjs` to merge those shards into the latest
`data` branch. Never return to rebuilding/force-pushing the branch from a stale
collector checkout: concurrent searches would delete one another. The merge
also builds `search-index.json`, a real-data-only rolling index used for an
immediate matching preview while a new exact keyword is still collecting.

`worker/tiktok-http.js` implements what `tiktok-profile-scraper-main/` proved:
TikTok server-renders its pages, so a plain `fetch` of `/tag/<slug>`, `/@user`
or `/search?q=` returns HTML whose `__UNIVERSAL_DATA_FOR_REHYDRATION__` carries
real items and metrics; cookies from that first response then authorise
`/api/challenge/item_list/`, `/api/post/item_list/` and `/api/search/*/full/`
for cursor pagination. Parameter names come from `tiktok-scraper-master/`, but
its `_signature` scheme and `m.tiktok.com` endpoints are dead — never revive
them.

That technique works from a residential or GitHub-runner IP and is exactly what
`backend/scripts/collect.mjs` relies on. From Cloudflare it currently returns
the empty shell described above, so it is kept (it costs nothing, needs no
quota, and may start working) but it is **not** what the product depends on.
Re-run `/api/probe` before assuming either way.

`GET /api/probe?q=<keyword>` runs every browser-free route once and reports
status, bytes, embedded-payload detection and item counts from Cloudflare's own
IP. Use it before diagnosing anything by guesswork; the dashboard exposes it as
**Test connection**.

### Unlimited search without a browser: the GitHub Actions dataset layer

Cloudflare's browser quota is too small for on-demand search, so keyword
results are also collected **outside** Cloudflare and served as static JSON:

```
.github/workflows/refresh-data.yml   cron every 30 min + workflow_dispatch
        ├─► plan-keywords.mjs             dynamic matrix (recent/configured keywords)
        ├─► up to 10 × collect.mjs         real Chromium runners in parallel
        └─► merge-publish.mjs              short serialized, race-safe publish
                └─► `data` branch
                        index.json, search-index.json, search/<slug>.json
                                └─► Worker reads DATA_BASE_URL (raw.githubusercontent.com)
```

- `data/keywords.json` (on `main`) is the list of keywords to collect. Editing
  it is how the user adds a keyword.
- The Worker serves a dataset **before** touching a browser when it is younger
  than `DATASET_FRESH_S` (30 min), falls back to a dataset of any age when a
  live run fails, and exposes the catalogue on `/api/catalogue`. `?live=1`
  forces a real browser run.
- Every dataset-served response carries `cached: true`, `dataset: true`,
  `cacheAgeSeconds` and a `notice`; the UI must keep showing that age. **Never
  present a dataset answer as a live one.**
- A run that collects nothing must not overwrite good data: `collect.mjs` keeps
  the previous payload and marks it `stale`.
- The `data` branch is merge-updated and must never be merged into `main`;
  pushing datasets to `main` would trigger a Cloudflare rebuild every 30 min.

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
- `worker/tiktok-http.js` (the browser-free provider — the only path with no
  quota; it must stay ahead of Browser Rendering in `/api/fetch-tiktok`)
- `dashboard/src/api.ts` (single source of API URLs, content-type guards)
- `backend/src/**` (production API; no persistent profile)
- `.gitignore` entries for data, profiles, env files
- `.github/workflows/refresh-data.yml` + `backend/scripts/collect.mjs` (the
  dataset layer that makes search work without browser quota)
- This `CLAUDE.md`
