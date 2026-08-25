import { config } from './config.mjs';

// Every /api response is JSON. HTML must never leave these routes, otherwise
// the frontend hits "Unexpected token '<'" while parsing.
export function applyCors(request, response) {
  const origin = request.headers.origin;
  const allowed = config.allowedOrigins;
  if (origin && (allowed.includes('*') || allowed.includes(origin))) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  } else if (allowed.includes('*')) {
    response.setHeader('Access-Control-Allow-Origin', '*');
  }
  response.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Max-Age', '86400');
}

export function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

export function sendError(response, status, code, message, extra = {}) {
  sendJson(response, status, { error: { code, message, ...extra } });
}

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const withTimeout = (promise, ms, message) => {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ApiError(504, 'timeout', message)), ms);
    }),
  ]);
};
