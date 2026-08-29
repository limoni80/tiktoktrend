import type { DatasetPayload, TikTokVideo } from './types';

/**
 * Single place where API URLs are built.
 *
 * - Production (Cloudflare) MUST set VITE_API_BASE_URL to the public backend.
 * - Local dev falls back to the dev server on the same origin.
 *
 * Cloudflare serves the SPA with single-page-application fallback, so an
 * unknown path returns index.html. If we ever parsed that as JSON we would get
 * `Unexpected token '<'` — every response is therefore checked for a JSON
 * content type before parsing.
 */
const RAW_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').trim();
export const API_BASE = RAW_BASE.replace(/\/+$/, '');
export const USE_DEMO_DATA = String(import.meta.env.VITE_USE_DEMO_DATA ?? '').toLowerCase() === 'true';
export const IS_PRODUCTION = import.meta.env.PROD;

/**
 * Same-origin is a valid production target: the Cloudflare Worker itself now
 * serves /api/* (country trends natively, search proxied to BACKEND_URL), so a
 * build without VITE_API_BASE_URL still talks to a real API rather than the
 * SPA fallback. Setting the variable points the app at a backend directly.
 */
export const BACKEND_CONFIGURED = true;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** Server-side diagnostics, when the API sends them. Shown in the UI so a
   *  failure can be copied and reported instead of described. */
  readonly debug: unknown;
  constructor(message: string, code = 'request_failed', status = 0, debug: unknown = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.debug = debug;
  }
}

export const apiUrl = (path: string, params?: Record<string, string | number | undefined>): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && String(value) !== '') query.set(key, String(value));
  }
  const suffix = query.toString() ? `?${query}` : '';
  return `${API_BASE}${path}${suffix}`;
};

const BACKEND_UNAVAILABLE =
  'Backend unavailable — the analytics API did not respond. Start the local backend, or set VITE_API_BASE_URL to your deployed backend.';

async function request<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path, params), { headers: { accept: 'application/json' } });
  } catch {
    throw new ApiError(BACKEND_UNAVAILABLE, 'network_error');
  }

  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();

  // Static hosts answer unknown paths with index.html. Never JSON.parse that.
  if (!contentType.includes('application/json')) {
    const looksLikeHtml = text.trimStart().startsWith('<');
    throw new ApiError(
      looksLikeHtml
        ? 'Backend unavailable — that URL returned a web page instead of data. Check VITE_API_BASE_URL: it must point at the Node backend, not at the Cloudflare site.'
        : BACKEND_UNAVAILABLE,
      'not_json',
      response.status,
    );
  }

  let body: unknown;
  try { body = JSON.parse(text); }
  catch { throw new ApiError('The backend returned malformed JSON.', 'bad_json', response.status); }

  if (!response.ok) {
    const payload = body as { error?: { code?: string; message?: string; debug?: unknown }; debug?: unknown };
    const error = payload?.error;
    throw new ApiError(
      error?.message ?? `Request failed (HTTP ${response.status})`,
      error?.code ?? 'http_error',
      response.status,
      error?.debug ?? payload?.debug ?? null,
    );
  }
  return body as T;
}

export interface HealthResponse { status: string; service: string; uptimeSeconds: number; nodeEnv: string; persistentProfile: boolean }
export interface ProgressResponse { active: boolean; phase: string; collected: number; matched: number; target: number; startedAt: number | null }
export interface FeedResponse extends DatasetPayload {
  hasMore?: boolean;
  scanned?: number;
  debug?: unknown;
  /** Answered from the Worker's cache instead of a fresh browser run. */
  cached?: boolean;
  stale?: boolean;
  cacheAgeSeconds?: number;
  notice?: string;
  /** Which path produced this: 'http' (no browser), 'browser', or a dataset. */
  provider?: 'http' | 'browser';
  dataset?: boolean;
  /** Matching real videos from the rolling index while exact collection runs. */
  preview?: boolean;
  exactPending?: boolean;
  /** A GitHub Actions run was started to collect this keyword; retry shortly. */
  queued?: boolean;
  etaSeconds?: number;
  /** Which collected keyword answered, when it is not an exact match. */
  matchedKeyword?: string | null;
}

export interface CatalogueEntry { keyword: string; slug: string; status: 'ok' | 'empty' | 'stale'; count: number; updatedAt: string | null }
export interface CatalogueResponse { configured: boolean; generatedAt: string | null; runUrl?: string | null; keywords: CatalogueEntry[] }

export const api = {
  health: () => request<HealthResponse>('/api/health'),
  progress: () => request<ProgressResponse>('/api/progress'),
  datasets: () => request<{ videos: FeedResponse | null; ads: FeedResponse | null }>('/api/datasets'),
  /** Catalogue of datasets collected by GitHub Actions (instant, no browser). */
  catalogue: () => request<CatalogueResponse>('/api/catalogue'),
  /** Runs every browser-free route once and reports what TikTok answered. */
  probe: (q: string) => request<Record<string, unknown>>('/api/probe', { q }),
  searchTikTok: (params: { q: string; count: string | number; from?: string; to?: string; more?: boolean; known?: string[]; live?: boolean }) =>
    request<FeedResponse>('/api/fetch-tiktok', {
      q: params.q, count: params.count, from: params.from, to: params.to,
      more: params.more ? '1' : undefined,
      live: params.live ? '1' : undefined,
      known: params.known?.length ? params.known.slice(0, 400).join(',') : undefined,
    }),
  trends: (params: { region: string; period: string }) => request<FeedResponse>('/api/fetch', params),
  ads: (params: { region: string; period: string; keyword: string }) => request<FeedResponse>('/api/fetch-ads', params),
  /** Play URLs need TikTok headers, so they stream through the backend. */
  videoStreamUrl: (source: string) => apiUrl('/api/video', { src: source }),
};

export type { TikTokVideo };
