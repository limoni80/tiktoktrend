# Deployment

Pulse is two deployments:

1. **Frontend** — static SPA on Cloudflare Workers.
2. **Backend** — Node + Playwright scraping API on a normal Node host.

Cloudflare cannot run the scraper: it needs a real Chromium process. Keeping the
two apart is what fixes the `Unexpected token '<'` error — the SPA used to call
relative `/api/...` paths, and Cloudflare's SPA fallback answered them with
`index.html`.

---

## 1. Backend (deploy this first)

The frontend needs the backend URL at build time, so deploy the backend first.

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

## 2. Frontend (Cloudflare Workers)

`wrangler.jsonc` at the repo root already builds the dashboard and serves
`dashboard/dist` with SPA fallback. **Do not change it to serve the raw
`dashboard/` directory.**

Set the backend URL as a build-time variable, then deploy:

```bash
# Cloudflare dashboard → Workers → tiktoktrend → Settings → Variables →
#   Build variables:  VITE_API_BASE_URL = https://<your-backend>
npx wrangler deploy
```

Or locally:

```bash
VITE_API_BASE_URL=https://<your-backend> npm --prefix dashboard run build
npx wrangler deploy
```

`VITE_API_BASE_URL` is inlined at build time, so **rebuild and redeploy whenever
the backend URL changes**. A production build without it renders a
“Backend not configured” banner instead of silently showing demo videos.

### Verify the frontend

1. Open `https://tiktoktrend.limoniastrum.workers.dev`.
2. DevTools → Network: the `/api/...` requests must go to your backend host,
   return `200` and `content-type: application/json`.
3. Search for a keyword; cards must show real creators and real counts.
4. Confirm no “DEMO MODE” banner appears.

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
| `Unexpected token '<'` | Frontend calling relative `/api/...` on Cloudflare | Set `VITE_API_BASE_URL` and rebuild |
| `502 tiktok_unreachable` | Host cannot reach tiktok.com | Deploy where outbound internet is open |
| `429 tiktok_captcha` | TikTok challenged the server IP | Retry later, or set `TIKTOK_COOKIE` |
| CORS error in the console | Origin not allow-listed | Add the exact origin to `ALLOWED_ORIGINS` |
| Playback fails after a while | TikTok play URLs expire in hours | Re-run the search |
