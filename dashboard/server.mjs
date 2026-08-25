/**
 * DEVELOPMENT ONLY.
 *
 * Runs the Vite dev server and mounts the production API router on the same
 * origin, so `npm run dev` keeps working with relative /api paths and no CORS.
 *
 * Production never runs this file:
 *   - the SPA is built by Vite and served by Cloudflare Workers (wrangler.jsonc)
 *   - the API is served by ../backend (npm start), with CORS + VITE_API_BASE_URL
 */
import http from 'node:http';
import process from 'node:process';
import { createServer as createViteServer } from 'vite';
import { handleApiRequest } from '../backend/src/api.mjs';

if (process.env.NODE_ENV === 'production') {
  console.error('dashboard/server.mjs is a development launcher. Run the backend with `npm --prefix backend start` instead.');
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 4173);

const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });

const server = http.createServer(async (request, response) => {
  try {
    if (await handleApiRequest(request, response)) return;
  } catch (error) {
    console.error('[dev] api error', error);
    if (!response.headersSent) {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { code: 'internal_error', message: 'Unexpected server error' } }));
    }
    return;
  }
  vite.middlewares(request, response);
});

server.listen(PORT, () => console.log(`Pulse dev server on http://localhost:${PORT} (SPA + /api)`));

process.on('unhandledRejection', (reason) => console.warn('[dev] unhandled rejection:', reason instanceof Error ? reason.message : reason));
process.on('uncaughtException', (error) => console.warn('[dev] uncaught exception:', error?.message ?? error));

const shutdown = async () => {
  const { shutdownTikTok } = await import('../backend/src/tiktok.mjs');
  const { closeBrowser } = await import('../backend/src/browser.mjs');
  await shutdownTikTok().catch(() => {});
  await closeBrowser().catch(() => {});
  await vite.close().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
