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
