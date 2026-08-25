import { chromium } from 'playwright-core';
import { config } from './config.mjs';

// A single shared browser process. Contexts are EPHEMERAL: no persistent
// user-data-dir, so nothing about a TikTok session is ever written to disk and
// the backend can run on a read-only container filesystem.
const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disk-cache-size=33554432',
  '--media-cache-size=33554432',
];

export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

let browserPromise = null;

export async function getBrowser() {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    if (browser?.isConnected()) return browser;
    browserPromise = null;
  }
  browserPromise = chromium.launch({
    headless: true,
    args: LAUNCH_ARGS,
    ...(config.chromePath ? { executablePath: config.chromePath } : {}),
  });
  return browserPromise;
}

export async function closeBrowser() {
  const pending = browserPromise;
  browserPromise = null;
  if (!pending) return;
  try { (await pending).close(); } catch { /* already gone */ }
}

const cookiesFromHeader = (header) => String(header ?? '')
  .split(';')
  .map((pair) => {
    const index = pair.indexOf('=');
    if (index < 1) return null;
    return { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim(), domain: '.tiktok.com', path: '/' };
  })
  .filter(Boolean);

/**
 * Fresh, disposable context. Media downloads are blocked because every metric
 * we need arrives as JSON — this is both the main speed win and what keeps the
 * container from writing a disk cache.
 */
export async function createContext({ blockMedia = true, viewport = { width: 1440, height: 1200 } } = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport,
    locale: 'en-US',
    userAgent: USER_AGENT,
    extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
  });

  if (blockMedia) {
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      const done = ['image', 'media', 'font'].includes(type) ? route.abort() : route.continue();
      // Both reject when the page navigates mid-request; an unhandled rejection
      // here would take the process down.
      return Promise.resolve(done).catch(() => {});
    }).catch(() => {});
  }

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    window.chrome = window.chrome ?? { runtime: {} };
  }).catch(() => {});

  // Optional operator-supplied cookies (env only, never persisted by us).
  if (config.tiktokCookie) {
    await context.addCookies(cookiesFromHeader(config.tiktokCookie)).catch(() => {});
  }

  return context;
}

/**
 * TikTok only serves its JSON feed APIs to a client that already holds ttwid /
 * msToken cookies. A persistent profile used to provide those; instead we warm
 * a throwaway context by loading the public homepage first.
 */
export async function warmContext(context) {
  const page = context.pages()[0] ?? await context.newPage();
  try {
    await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1_200);
    await page.keyboard.press('Escape').catch(() => {});
  } catch { /* the caller still tries the target page */ }
  return page;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
