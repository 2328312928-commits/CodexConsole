import type { ErrorCode } from '../../shared/errors.js';

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'network',
    readonly detail?: string,
    readonly retryAfterSec?: number,
  ) {
    super(code);
  }
}

const AUTH_CODES = new Set(['device_required', 'login_required', 'setup_required']);

/** Lets the app re-check its auth state when any call reports a lost login. */
export const authEvents = new EventTarget();

async function parseFailure(res: Response): Promise<ApiFailure> {
  let body: { error?: { code?: ErrorCode; detail?: string; retryAfterSec?: number } } = {};
  try {
    body = await res.json();
  } catch {
    // non-JSON error (e.g. proxy)
  }
  const code = body.error?.code ?? (res.status === 429 ? 'rate_limited' : 'internal');
  if (AUTH_CODES.has(code)) authEvents.dispatchEvent(new Event('lost'));
  const retry = body.error?.retryAfterSec ?? (Number(res.headers.get('Retry-After')) || undefined);
  return new ApiFailure(res.status, code, body.error?.detail, retry);
}

export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        'X-Codex-Console': '1',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiFailure(0, 'network');
  }
  if (!res.ok) throw await parseFailure(res);
  return (await res.json()) as T;
}

export const get = <T>(url: string) => api<T>('GET', url);
export const post = <T>(url: string, body: unknown = {}) => api<T>('POST', url, body);
export const patch = <T>(url: string, body: unknown) => api<T>('PATCH', url, body);
export const put = <T>(url: string, body: unknown) => api<T>('PUT', url, body);
export const del = <T>(url: string) => api<T>('DELETE', url);

export function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function fileUrl(path: string, mode: 'view' | 'download' = 'view', session?: string): string {
  return `/api/files/${mode}${qs({ path, session })}`;
}

/** Upload with progress (fetch has no upload progress events). */
export function uploadFiles(
  dir: string,
  files: File[],
  opts: { session?: string; onProgress?: (fraction: number) => void } = {},
): Promise<{ files: Array<{ path: string; name: string; size: number }> }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/files/upload${qs({ path: dir, session: opts.session })}`);
    xhr.setRequestHeader('X-Codex-Console', '1');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiFailure(0, 'network'));
    xhr.onload = () => {
      let body: any = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // ignore
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else {
        const code = body.error?.code ?? (xhr.status === 413 ? 'file_too_large' : 'internal');
        if (AUTH_CODES.has(code)) authEvents.dispatchEvent(new Event('lost'));
        reject(new ApiFailure(xhr.status, code, body.error?.detail, body.error?.retryAfterSec));
      }
    };
    const form = new FormData();
    for (const f of files) form.append('file', f, f.name);
    xhr.send(form);
  });
}
