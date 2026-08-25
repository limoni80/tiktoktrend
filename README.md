# TikTok Scraper Pilot

This workspace contains two existing TikTok collection experiments and the new Pulse analytics dashboard.

- `dashboard/` — premium React/Vite video analytics interface and normalized provider layer
- `tiktok-profile-scraper-main/` — Apify profile collector and current HTML/oEmbed parsers
- `tiktok-scraper-master/` — legacy scraper reference

Start the dashboard:

```bash
cd dashboard
npm install
npm run dev
```

See `dashboard/README.md` for supported data shapes, metrics, formulas, and limitations.

## Cloudflare Workers deployment

The root `wrangler.jsonc` builds the Vite dashboard and deploys the compiled
`dashboard/dist` directory. From the repository root, deploy with:

```bash
npx wrangler deploy
```

For Cloudflare Workers Builds, keep the root directory at the repository root
and the deploy command as `npx wrangler deploy`. The Wrangler build hook runs
the dashboard install and production build automatically.

The deployed Worker serves the dashboard UI as a static SPA. The local
Playwright-based scraping routes in `dashboard/server.mjs` require a separate
Node.js runtime and are not executed by the static Worker.
