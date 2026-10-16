import type { ApiError as ApiErrorBody, ErrorCode } from '@resortos/shared';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode, message: string, readonly details?: any, readonly requestId?: string) {
    super(message);
  }
  /** Field errors for inline form messages. */
  get fields(): Record<string, string> {
    const list: { path: string; message: string }[] = this.details?.fields ?? [];
    return Object.fromEntries(list.map((f) => [f.path, f.message]));
  }
}

export const PROPERTY_CONTEXT_KEY = 'resortos.property';
export function propertyContext(): string | null {
  // Private/restricted phone browsers can throw even when reading storage. The
  // unauthenticated QR scanner must still work without a selected property.
  try { return typeof window === 'undefined' ? null : window.sessionStorage?.getItem(PROPERTY_CONTEXT_KEY) ?? null; }
  catch { return null; }
}
export function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  query?: Record<string, string | number | undefined | null>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/**
 * Single entry point to the API. Success is only reported after the server answers 2xx
 * (spec §3.9); network failures surface as a plain-language error, never as success.
 */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const qs = opts.query
    ? '?' + new URLSearchParams(Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString()
    : '';
  const headers: Record<string, string> = { 'x-resortos': '1', ...opts.headers };
  const selectedProperty = propertyContext();
  if (selectedProperty) headers['x-resortos-property'] = selectedProperty;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`/api/v1${path}${qs}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'INTERNAL_ERROR', opts.method && opts.method !== 'GET'
      ? 'Cannot confirm the result. Check the connection and refresh this record before trying again.'
      : 'Cannot reach ResortOS. Check the internet connection and try again.');
  }

  let data: any = null;
  try { const text = await res.text(); data = text ? JSON.parse(text) : null; }
  catch {
    throw new ApiError(res.ok ? 502 : res.status, 'INTERNAL_ERROR', opts.method && opts.method !== 'GET'
      ? 'Cannot read the server response. Refresh this record to check whether your changes were saved.'
      : 'ResortOS is temporarily unavailable. Please try again.');
  }
  if (!res.ok) {
    const body = (data ?? {}) as Partial<ApiErrorBody>;
    if (res.status === 401 && typeof window !== 'undefined' && !['/auth/login','/auth/recover'].includes(path) && !window.location.pathname.startsWith('/login')) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    }
    throw new ApiError(res.status, (body.code ?? 'INTERNAL_ERROR') as ErrorCode, body.message ?? 'Something went wrong.', body.details, body.requestId);
  }
  if (typeof window !== 'undefined' && ['/auth/login','/auth/logout','/desk/switch'].includes(path)) {
    try { window.sessionStorage?.removeItem(PROPERTY_CONTEXT_KEY); } catch { /* Storage is unavailable in some private browsers. */ }
  }
  return data as T;
}

/** A same-origin API URL for things the browser opens itself — a printable PDF in a new tab. */
export function apiUrl(path: string): string {
  const selectedProperty = propertyContext();
  return `/api/v1${path}${selectedProperty ? (path.includes('?') ? '&' : '?') + 'propertyContext=' + encodeURIComponent(selectedProperty) : ''}`;
}
