import http from 'node:http';
import { config } from './config.mjs';
import { handleApiRequest } from './api.mjs';
import { sendError, sendJson } from './http.mjs';
import { closeBrowser } from './browser.mjs';
import { shutdownTikTok } from './tiktok.mjs';

// Production API server. No Vite, no dev middleware, no static assets — the
// SPA is served by Cloudflare; this process only answers /api/*.
const server = http.createServer(async (request, response) => {
  try {
    if (await handleApiRequest(request, response)) return;
    if (request.url === '/' || request.url === '') {
      return sendJson(response, 200, {
        service: 'tiktoktrend-backend',
        health: '/api/health',
        endpoints: ['/api/health', '/api/progress', '/api/datasets', '/api/fetch-tiktok', '/api/fetch', '/api/fetch-ads', '/api/video'],
      });
    }
    sendError(response, 404, 'not_found', 'This service only exposes /api routes');
  } catch (error) {
    console.error('[server] request failed', error);
    if (!response.headersSent) sendError(response, 500, 'internal_error', 'Unexpected server error');
    else try { response.end(); } catch { /* already closed */ }
  }
});

server.headersTimeout = config.requestTimeoutMs + 30_000;
server.requestTimeout = config.requestTimeoutMs + 30_000;

server.listen(config.port, config.host, () => {
  console.log(`[pulse-backend] listening on http://${config.host}:${config.port} (${config.nodeEnv})`);
  console.log(`[pulse-backend] allowed origins: ${config.allowedOrigins.join(', ')}`);
});

// A scraping failure must never take the API down.
process.on('unhandledRejection', (reason) => console.warn('[pulse-backend] unhandled rejection:', reason instanceof Error ? reason.message : reason));
process.on('uncaughtException', (error) => console.warn('[pulse-backend] uncaught exception:', error?.message ?? error));

const shutdown = async () => {
  await shutdownTikTok().catch(() => {});
  await closeBrowser().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
