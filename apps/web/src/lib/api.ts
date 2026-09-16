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

export function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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
    throw new ApiError(0, 'INTERNAL_ERROR', 'Cannot reach ResortOS. Check the internet connection — nothing new was saved.');
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const body = (data ?? {}) as Partial<ApiErrorBody>;
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/login') && !window.location.pathname.startsWith('/login')) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    }
    throw new ApiError(res.status, (body.code ?? 'INTERNAL_ERROR') as ErrorCode, body.message ?? 'Something went wrong.', body.details, body.requestId);
  }
  return data as T;
}
