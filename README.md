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
