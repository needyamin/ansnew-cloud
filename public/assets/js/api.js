'use strict';
/* ANSNEW CLOUD API client: fetch wrapper with CSRF header, JSON handling, error toasts. */

let csrfToken = '';

export function setCsrf(token) { csrfToken = token || ''; }
export function getCsrf() { return csrfToken; }

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(method, url, body, opts = {}) {
  const headers = {};
  let payload;
  if (body !== undefined && body !== null && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  } else if (body instanceof FormData) {
    payload = body;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    headers['X-CSRF-Token'] = csrfToken;
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', signal: opts.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('Network error: is the server reachable?', 0, 'network');
  }
  if (opts.raw) return res;
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON */ }
  if (!res.ok || (data && data.ok === false)) {
    const msg = data && data.error ? data.error.message : ('Request failed (' + res.status + ')');
    const code = data && data.error ? data.error.code : 'error';
    throw new ApiError(msg, res.status, code);
  }
  return data ? data.data : null;
}

export const api = {
  get: (url, opts) => request('GET', url, undefined, opts),
  post: (url, body, opts) => request('POST', url, body, opts),
  delete: (url, body, opts) => request('DELETE', url, body, opts),

  /** Fetch a URL as text (for preview), enforcing same-origin & size cap. */
  text: async (url, maxBytes) => {
    const res = await request('GET', url, undefined, { raw: true });
    const len = parseInt(res.headers.get('content-length') || '0', 10);
    if (maxBytes && len > maxBytes) throw new ApiError('File too large to preview', 0, 'too_large');
    return await res.text();
  },
};
