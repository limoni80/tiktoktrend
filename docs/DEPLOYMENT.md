# Deployment

Pulse deploys in two pieces, and **the first one alone already serves real
TikTok data**:

1. **Cloudflare Worker** — serves the SPA *and* owns `/api/*`. It fetches
   TikTok Creative Center country trends itself: real data, no browser, no
   cookies, no login, no backend.
2. **Node backend** (optional but recommended) — Playwright + Chromium. Adds
   keyword search and Top Ads, which need a real browser and therefore cannot
   run on Cloudflare. The Worker proxies to it through the `BACKEND_URL`
   variable.

The Worker intercepts `/api/*` before the static-asset handler, which is what
fixes `Unexpected token '<'`: those paths can no longer return `index.html`.

| Route | Works with Worker alone | Needs the Node backend |
| --- | --- | --- |
| `/api/health`, `/api/video`, `/api/fetch` (trends) | yes | — |
| `/api/fetch-tiktok` (keyword search) | no | yes |
| `/api/fetch-ads` (Top Ads) | no | yes |

## 0a. Direct HTTP search (no browser, no quota) — the primary path

`worker/tiktok-http.js` searches TikTok with plain `fetch` calls from the
Worker. No Chromium, no Browser Rendering quota, no cookies of yours, no login:

1. one request to `https://www.tiktok.com/` collects the anonymous cookies
   TikTok gives any visitor (cached in the Worker for 15 minutes);
2. `/tag/<keyword>`, `/search?q=`, `/@user` are fetched as HTML — TikTok
   server-renders them, so the videos and their metrics are already inside the
   `__UNIVERSAL_DATA_FOR_REHYDRATION__` script tag;
3. `/api/challenge/item_list/`, `/api/post/item_list/` and
   `/api/search/*/full/` are then called with those cookies for cursor
   pagination.

**Measured result on this deployment (2026-08-29):** every route returns
`200 OK` with a large page, the embedded payload is present (~260 KB) — and it
holds **zero videos**, no `challengeId`, and the generic “TikTok - Make Your
Day” title. TikTok gives Cloudflare IPs a data-less shell. The GitHub Actions
collector, on the same code, gets 60/60 videos per keyword. So keep the HTTP
path (it costs nothing and may start working), but **the collector is what
actually gathers data.**

Check what TikTok answers from your own Worker:

```bash
curl -s "https://tiktoktrend.limoniastrum.workers.dev/api/probe?q=messi" | jq '.verdict, .usable, .results'
```

`verdict` says in one line whether browser-free search works; `results` lists
every route with its HTTP status, byte count, whether an embedded payload was
found and how many items it held. The dashboard runs the same call from the
**Test connection** button next to the search bar.

If `usable` is empty, TikTok is refusing Cloudflare's IPs — then the GitHub
Actions datasets below, or a backend on a residential IP, are the answer.

---

## 0b. Unlimited keyword search with GitHub Actions (no browser quota)

Cloudflare's free Browser Rendering plan allows only **2 browser launches per
minute per account**, which is not enough for on-demand search. A GitHub
Actions runner has a real Chromium and free minutes on public repositories, so
it collects the keywords you care about on a schedule and publishes them as
plain JSON. The Worker then answers those searches instantly, with no browser
at all.

### On-demand collection (any keyword, ~100 seconds)

When a search has no dataset, the Worker asks GitHub Actions to collect that
keyword right away, answers `{ queued: true }`, and the dashboard retries by
itself. From then on the keyword is refreshed with every scheduled run.

One-time setup:

1. GitHub → **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token**. Repository access: only
   `limoni80/tiktoktrend`. Permissions: **Actions → Read and write**. Nothing
   else.
2. Store it as a Worker **secret** (never a var, never committed):
   ```bash
   npx wrangler secret put GITHUB_TOKEN
   ```
   Paste the token at the prompt. It is write-only from then on.
3. `wrangler.jsonc` already sets `GITHUB_REPO`, `GITHUB_WORKFLOW_FILE` and
   `GITHUB_REF`. Redeploy: `npx wrangler deploy`.

Without the secret, an unknown keyword returns a clear message asking for it to
be added to `data/keywords.json` instead — nothing breaks, it just is not
automatic.

**Setup — three things, all in this repo:**

1. `data/keywords.json` — the keywords to collect. Edit, commit, done.
   ```json
   { "perKeyword": 60, "keywords": ["trump", "ai tools", "skincare"] }
   ```
2. The workflow is already committed at `.github/workflows/refresh-data.yml`.
   It runs every 30 minutes and can be started by hand from **Actions →
   Refresh TikTok datasets → Run workflow** (with an optional one-off keyword).
   It needs no secrets: the built-in `GITHUB_TOKEN` is enough.
3. `DATA_BASE_URL` in `wrangler.jsonc` points at the published branch:
   `https://raw.githubusercontent.com/<owner>/<repo>/data`. Change it if you
   fork the repo; set it to `""` to disable the dataset layer entirely.

**How the Worker chooses:**

| Situation | Answer | Browser used |
| --- | --- | --- |
| Dataset < 30 min old (exact keyword, or its singular/prefix alias) | dataset, labelled with its age | none |
| Same search repeated within 2 min | Worker cache | none |
| Dataset exists but is older | that dataset, labelled with its age | none |
| Keyword never collected | a collection run is triggered; `{queued:true}` and the UI retries | none |
| Everything above failed and a browser is bound | Browser Rendering | 1 launch |
| `?live=1` | forced live run | 1 launch |

Every dataset answer carries `cached: true`, `dataset: true`, `cacheAgeSeconds`
and a `notice`, and the UI shows the age — a collected result is never
presented as a live one.

**Checks after the first run:**

```bash
curl -s https://raw.githubusercontent.com/<owner>/<repo>/data/index.json | jq '.keywords'
curl -s https://tiktoktrend.limoniastrum.workers.dev/api/catalogue | jq .
```

The workflow's job summary lists every keyword with `ok` / `empty` / `stale`
and the video count, so a run that collected nothing is visible instead of
silent. **A run that collects nothing never overwrites good data** — the
previous payload is kept and marked `stale`.

**Measured (2026-08-29):** GitHub runners *do* get real data — 60/60 videos for
every keyword, about 30 seconds each. Cloudflare IPs do not. If that ever
changes, the job summary shows `empty` per keyword and the previous payload is
kept rather than overwritten, so a bad run is visible instead of silent; the
fallback then is `backend/` on a residential IP behind `BACKEND_URL`.

---

## 0. Deploy just the Worker (fastest path to real data)

```bash
npx wrangler deploy
```

Then open the site and use **Load real trends** / the Overview → Creative Center
fetch. Keyword search will return a clear `501 backend_not_configured` until you
finish step 1 and set `BACKEND_URL`.

---

## 1. Backend (adds keyword search + Top Ads)

Skip this if country trends are enough for now — the Worker already serves those. Deploy this to unlock keyword search and Top Ads.

### Requirements

- Node.js 20+
- A Chromium that Playwright can drive (the Docker image below ships one)
- **Unrestricted outbound internet.** If the host cannot reach
  `www.tiktok.com`, `/api/fetch-tiktok` answers
  `502 {"error":{"code":"tiktok_unreachable"}}`.
- ~1 GB RAM (Chromium), 1 vCPU is enough for a single-user dashboard

### Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | no | `8787` | Listen port (Railway/Render/Fly set it for you) |
| `HOST` | no | `0.0.0.0` | Bind address |
| `NODE_ENV` | yes | `development` | Set to `production` |
| `ALLOWED_ORIGINS` | **yes** | Cloudflare + localhost | Comma separated CORS allow-list. Must include your Cloudflare URL. |
| `CHROME_PATH` | no | Playwright's own | Absolute path to a Chromium binary |
| `REQUEST_TIMEOUT_MS` | no | `120000` | Hard ceiling for one scrape |
| `SESSION_IDLE_MS` | no | `240000` | How long a warm TikTok session is kept for pagination |
| `MAX_BATCH` | no | `120` | Largest page size a client may request |
| `TIKTOK_COOKIE` | no | — | Optional cookie header if the host IP gets rate limited. **Never commit a value.** |

### Option A — Docker (works on Fly.io, Render, a VPS, anywhere)

```bash
cd backend
docker build -t pulse-backend .
docker run --rm -p 8787:8787 \
  -e NODE_ENV=production \
  -e ALLOWED_ORIGINS=https://tiktoktrend.limoniastrum.workers.dev \
  pulse-backend
```

The image is based on `mcr.microsoft.com/playwright`, so Chromium and every
system library are already present. A `HEALTHCHECK` polls `/api/health`.

### Option B — Railway / Render (no Docker)

- **Root directory:** `backend`
- **Build command:** `npm install` (the `postinstall` hook runs
  `playwright install --with-deps chromium`)
- **Start command:** `npm start`
- **Env:** `NODE_ENV=production`, `ALLOWED_ORIGINS=<your Cloudflare URL>`
- **Health check path:** `/api/health`

If the platform blocks `--with-deps` (no root), use the Docker option instead.

### Option C — VPS with systemd

```ini
[Unit]
Description=Pulse TikTok backend
After=network.target

[Service]
WorkingDirectory=/opt/tiktoktrend/backend
Environment=NODE_ENV=production
Environment=PORT=8787
Environment=ALLOWED_ORIGINS=https://tiktoktrend.limoniastrum.workers.dev
ExecStart=/usr/bin/node src/server.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

### Verify the backend

```bash
curl -s https://<your-backend>/api/health | jq .
node backend/scripts/verify.mjs https://<your-backend> dog
```

`verify.mjs` fails loudly if the API returns HTML, if a search returns nothing,
or if the videos do not carry real `tiktok.com` URLs and real metrics.

---

## 2. Cloudflare Worker (frontend + API layer)

`wrangler.jsonc` builds the dashboard, serves `dashboard/dist` through the
`ASSETS` binding, and runs `worker/index.js` as the entry point. **Do not remove
`main`, and do not point the assets directory at the raw `dashboard/` folder.**

Point the Worker at your backend so keyword search works, then deploy:

```bash
# Cloudflare dashboard → Workers → tiktoktrend → Settings → Variables →
#   Environment variable:  BACKEND_URL = https://<your-backend>
npx wrangler deploy
```

Or from the CLI:

```bash
npx wrangler deploy --var BACKEND_URL:https://<your-backend>
```

`BACKEND_URL` is a **runtime** variable — changing it does not require
rebuilding the frontend. `VITE_API_BASE_URL` stays optional: leave it empty and
the SPA uses the Worker's own `/api` on the same origin (no CORS at all). Set it
only if you want the browser to call a backend directly, in which case that
backend's `ALLOWED_ORIGINS` must include your Cloudflare URL.

### Verify the deployed site

```bash
curl -s https://tiktoktrend.limoniastrum.workers.dev/api/health | jq .
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' \
  https://tiktoktrend.limoniastrum.workers.dev/api/nope        # JSON 404, never HTML
curl -s "https://tiktoktrend.limoniastrum.workers.dev/api/fetch?region=US&period=7" \
  | jq '.videos | length, .[0].url'                            # real trend videos
```

Then in the browser:

1. Open the site; `/api/*` requests must return `content-type: application/json`.
2. **Load real trends** must fill the grid with real creators and view counts.
3. With `BACKEND_URL` set, a keyword search must return real videos whose URLs
   are `https://www.tiktok.com/@user/video/<id>`.
4. No “DEMO MODE” banner may appear.

---

## 3. Local development

```bash
# One origin, no CORS: Vite + the API router together
npm --prefix dashboard install
npm --prefix backend install
npm --prefix dashboard run dev          # http://localhost:4173
```

To develop against a separately running backend instead:

```bash
npm --prefix backend run dev                     # http://localhost:8787
echo 'VITE_API_BASE_URL=http://localhost:8787' > dashboard/.env.local
npm --prefix dashboard run dev:spa               # http://localhost:5173
```

## 4. Production verification checklist

```bash
npm --prefix dashboard run typecheck
npm --prefix dashboard run build
grep -c "Aria Studio" dashboard/dist/assets/*.js        # must be 0
curl -s <backend>/api/health
curl -s "<backend>/api/nope" -w '\n%{http_code} %{content_type}\n'
node backend/scripts/verify.mjs <backend> dog
```

## 5. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Unexpected token '<'` | Worker not deployed, or `main` missing from `wrangler.jsonc`, so `/api/*` hit the SPA fallback | Redeploy with `main: worker/index.js` |
| `501 backend_not_configured` | Keyword search without a backend | Deploy `backend/` and set `BACKEND_URL` on the Worker |
| `502 tiktok_unreachable` | Host cannot reach tiktok.com | Deploy where outbound internet is open |
| `429 tiktok_captcha` | TikTok challenged the server IP | Retry later, or set `TIKTOK_COOKIE` |
| CORS error in the console | Origin not allow-listed | Add the exact origin to `ALLOWED_ORIGINS` |
| Playback fails after a while | TikTok play URLs expire in hours | Re-run the search |
| `browser_rate_limited` / “Rate limit exceeded” | Browser Rendering on the Workers Free plan allows 3 concurrent browsers, one new browser per 20s, and **10 minutes of browser time per day per account** — a 429 with zero open sessions usually means the daily 10 minutes are spent | Direct HTTP (§0a) now runs first and needs no browser at all, so this should no longer block a search. The browser is only the last resort, and a failure falls back to a labelled dataset or cached copy |
| A search returns 0 results | TikTok served the generic feed instead of search results to the Cloudflare IP | Open **Fetch log** under the search bar and read `apiHits` / `fromSearchEndpoints`. `fromSearchEndpoints: 0` means no `/api/search/...` response ever arrived — the Worker then retries the video tab and the hashtag page automatically; if all three fail, that IP is being served the feed only. |

### Reading the fetch log

Every `/api/fetch-tiktok` response — success or failure — now carries a `debug`
object, and the dashboard shows it in a collapsible **Fetch log** panel with a
copy button. Fields worth reading first:

| Field | Meaning |
| --- | --- |
| `strategies[]` | Each route tried (`search`, `search-video-tab`, `hashtag`), its final URL, page title, scroll rounds, and how many videos matched after it |
| `apiHits` | Per TikTok endpoint: how many responses arrived, how many videos they contributed, and whether that endpoint counts as `search` or generic `feed` |
| `fromSearchEndpoints` | Videos that came from a real search/hashtag endpoint. `0` = TikTok never answered a search request |
| `loginWall` / `captchaWall` | TikTok showed a login or verification page instead of results |
| `bodySnippet` | First 300 characters of the rendered page — the fastest way to see what TikTok actually served |
| `sampleCaptions` | First five collected videos, tagged `[search]` or `[feed]` |
