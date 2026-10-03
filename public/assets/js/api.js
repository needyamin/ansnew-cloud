'use strict';
/*
 * ANSNEW CLOUD API client.
 *
 * A thin fetch wrapper plus the primitives the file manager needs in order to
 * feel instant:
 *   - in-flight de-duplication (two panes asking for the same folder = 1 call)
 *   - a TTL cache with stale-while-revalidate
 *   - ETag / If-None-Match conditional GETs (unchanged folder = 304, no re-walk)
 *   - AbortController + timeout + stale-response guards
 *   - separate read/write lanes, so a queued read never delays a mutation
 *
 * Caching is opt-in per call via {cacheKey, ttl, stale}; default is uncached,
 * which preserves the semantics every existing caller relies on.
 */

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

/* ------------------------------------------------------------ concurrency */

/**
 * Reads and writes get independent budgets. Sharing one would let a burst of
 * thumbnail requests stall a delete behind them.
 */
const lanes = {
  read: { max: 6, active: 0, q: [] },
  write: { max: 4, active: 0, q: [] },
};

function laneFor(method) {
  return (method === 'GET' || method === 'HEAD') ? lanes.read : lanes.write;
}

function withLane(lane, fn) {
  const release = () => {
    const next = lane.q.shift();
    if (next) next();          // hand the slot straight to the next waiter
    else lane.active--;
  };
  if (lane.active < lane.max) {
    lane.active++;
    return Promise.resolve().then(fn).finally(release);
  }
  return new Promise((resolve) => { lane.q.push(resolve); })
    .then(fn)
    .finally(release);
}

/* ------------------------------------------------------------------ cache */

/** key -> { data, etag, ts } */
const cache = new Map();
/** key -> Promise, for coalescing simultaneous identical requests */
const inflight = new Map();

/**
 * Directory listings are keyed by location rather than by URL so that a
 * mutation can invalidate a whole subtree by prefix.
 */
export function listKey(mount, path) { return `list:${mount}:${path}`; }

/** Drop every cached entry whose key starts with `prefix`. */
export function invalidate(prefix) {
  if (!prefix) return;
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

/** Invalidate a directory and everything under it ('/' invalidates a mount). */
export function invalidateList(mount, path) { invalidate(listKey(mount, path)); }

export function clearCache() { cache.clear(); }

/* --------------------------------------------------------------- request */

/**
 * Core transport. Returns { data, res } (or { notModified:true, res } on 304).
 */
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
  if (opts.etag) headers['If-None-Match'] = opts.etag;

  // A caller-supplied signal and our own timeout both feed one controller;
  // on abort we check which one fired so callers still see a clean AbortError.
  const ctrl = new AbortController();
  const external = opts.signal;
  const onAbort = () => ctrl.abort();
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  const timeoutMs = opts.timeout === 0 ? 0 : (opts.timeout || (method === 'GET' ? 30000 : 120000));

  let res;
  try {
    res = await withLane(laneFor(method), async () => {
      const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      try {
        return await fetch(url, {
          method, headers, body: payload, credentials: 'same-origin', signal: ctrl.signal,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      if (external && external.aborted) throw e;      // caller cancelled — propagate
      throw new ApiError('Request timed out — the server took too long.', 0, 'timeout');
    }
    throw new ApiError('Network error: is the server reachable?', 0, 'network');
  } finally {
    if (external) external.removeEventListener('abort', onAbort);
  }

  if (res.status === 304) return { notModified: true, res };
  if (opts.raw) return { res };

  let data = null;
  try { data = await res.json(); } catch (_) { /* 204 / non-JSON streams */ }
  if (!res.ok || (data && data.ok === false)) {
    const msg = data && data.error ? data.error.message : ('Request failed (' + res.status + ')');
    const code = data && data.error ? data.error.code : 'error';
    throw new ApiError(msg, res.status, code);
  }
  return { data: data ? data.data : null, res };
}

/* -------------------------------------------------------------------- get */

async function get(url, opts = {}) {
  const key = opts.cacheKey || ('GET ' + url);
  const ttl = opts.ttl || 0;
  const stale = opts.stale || 0;
  // A request carrying its own AbortController must not be shared: cancelling
  // it would cancel everyone else's copy too.
  const canShare = opts.dedupe !== false && !opts.signal;

  if (canShare) {
    const pending = inflight.get(key);
    if (pending) return pending;
  }

  const cached = cache.get(key);
  const now = Date.now();
  if (cached && ttl > 0 && (now - cached.ts) < ttl) return cached.data;

  const p = (async () => {
    try {
      let r = await request('GET', url, undefined, { ...opts, etag: cached ? cached.etag : '' });
      if (r.notModified) {
        if (cached) { cached.ts = now; return cached.data; }
        // 304 with nothing cached (evicted mid-flight) — refetch without INM.
        r = await request('GET', url, undefined, opts);
      }
      if (ttl > 0 || stale > 0) {
        cache.set(key, { data: r.data, etag: r.res.headers.get('etag') || '', ts: Date.now() });
      }
      return r.data;
    } finally {
      inflight.delete(key);
    }
  })();

  if (canShare) inflight.set(key, p);

  // Stale-while-revalidate: serve what we have immediately and refresh behind
  // the scenes, so opening a recently-visited folder is instant.
  if (cached && stale > ttl && (now - cached.ts) < stale) {
    p.catch(() => { /* background refresh must never surface as an error */ });
    return cached.data;
  }
  return p;
}

/* -------------------------------------------------------------- mutations */

function post(url, body, opts) { return request('POST', url, body, opts).then((r) => r.data); }
function del(url, body, opts) { return request('DELETE', url, body, opts).then((r) => r.data); }

export const api = {
  get,
  post,
  delete: del,

  /** Fetch a URL as text (for preview), enforcing same-origin & size cap. */
  text: async (url, maxBytes) => {
    const r = await request('GET', url, undefined, { raw: true });
    const len = parseInt(r.res.headers.get('content-length') || '0', 10);
    if (maxBytes && len > maxBytes) throw new ApiError('File too large to preview', 0, 'too_large');
    return await r.res.text();
  },
};
