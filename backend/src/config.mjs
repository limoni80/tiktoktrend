// Runtime configuration. Everything is environment driven so the same build
// runs locally, in Docker, and on Railway / Render / Fly.io / a VPS.

const list = (value) => String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '0.0.0.0',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  // Comma separated list. "*" allows any origin (use only for local testing).
  allowedOrigins: list(process.env.ALLOWED_ORIGINS ?? 'https://tiktoktrend.limoniastrum.workers.dev,http://localhost:5173,http://localhost:4173'),
  // Playwright needs a Chromium binary. Leave unset to use the bundled one.
  chromePath: process.env.CHROME_PATH || undefined,
  // Hard ceiling for a single scrape request (ms).
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? 120_000),
  // How long an idle TikTok browser session is kept warm for pagination (ms).
  sessionIdleMs: Number(process.env.SESSION_IDLE_MS ?? 240_000),
  // Optional: a TikTok cookie header supplied by the host when guest access is
  // rate limited. NEVER commit a value for this — it is read from the env only.
  tiktokCookie: process.env.TIKTOK_COOKIE ?? '',
  maxBatch: Number(process.env.MAX_BATCH ?? 120),
};

export const isProduction = () => config.nodeEnv === 'production';
