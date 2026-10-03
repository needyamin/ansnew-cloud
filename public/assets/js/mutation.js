'use strict';
/*
 * Optimistic mutation orchestration.
 *
 * Every filesystem operation in the UI follows the same shape:
 *   1. patch the pane's entry list immediately (the row appears/disappears now)
 *   2. send the request
 *   3. on success, reconcile; on failure, roll back and explain
 *
 * The invariant that matters: a failed operation must never blank the list,
 * clear the selection, move the scroll position, or leave the user staring at a
 * spinner. The pane keeps showing exactly what it showed before, plus an error
 * marker on the rows that failed.
 */
import { toast, toastOk, toastErr } from './ui.js';
import { api, invalidate, invalidateList } from './api.js';

/** Join a directory and a name into a virtual path. */
export function joinPath(dir, name) {
  return (dir === '/' ? '' : String(dir || '')) + '/' + name;
}

/** Containing directory of a virtual path. */
export function dirOf(path) {
  const s = String(path || '/');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
}

/**
 * Build an entry for something we just created but the server hasn't described
 * yet. It is replaced by the real entry on the next revalidate.
 */
export function syntheticEntry(path, name, type = 'file', size = 0) {
  const dot = String(name).lastIndexOf('.');
  return {
    name,
    path,
    type,
    size,
    mtime: Math.floor(Date.now() / 1000),
    mode: '',
    owner: '',
    group: '',
    isLink: false,
    mime: '',
    extension: type === 'dir' || dot <= 0 ? '' : String(name).slice(dot + 1).toLowerCase(),
    optimistic: true,
  };
}

function pathsOf(patch) {
  if (!patch) return [];
  return [
    ...(patch.remove || []),
    ...(patch.add || []).map(e => e.path),
    ...(patch.update || []).map(e => e.path),
  ];
}

function markPending(pane, paths, on) {
  if (!pane) return;
  for (const p of paths) {
    if (on) pane.pending.add(p);
    else pane.pending.delete(p);
  }
  pane.refreshDecorations();
}

/**
 * Run one filesystem mutation with optimistic UI.
 *
 * @param {object}   o
 * @param {FilesPane} o.pane      pane to patch (optional)
 * @param {Function} o.patch      () => {add, remove, update} applied up-front
 * @param {Function} o.call       () => Promise<result>
 * @param {string[]} [o.pending]  paths to mark in-flight (defaults to the patch)
 * @param {string[]} [o.invalidate] extra cache keys to drop
 * @param {string}   [o.okMsg]    success toast
 * @param {Function} [o.onResult] inspect the raw result
 * @returns {Promise<object|null>} the result, or null if the call threw
 */
export async function runOp({ pane, patch, call, pending, invalidate = [], okMsg, onResult }) {
  // Snapshot what we are about to hide, so a partial failure can put it back.
  const applied = patch ? patch() : null;
  const removedEntries = (applied && applied.remove && pane)
    ? applied.remove.map(p => pane.entryByPath(p)).filter(Boolean)
    : [];

  const undo = (applied && pane) ? pane.applyLocal(applied) : null;
  const touched = pending || pathsOf(applied);
  markPending(pane, touched, true);

  let res;
  try {
    res = await call();
  } catch (e) {
    // Whole-request failure: restore exactly what was there before.
    if (undo) undo();
    markPending(pane, touched, false);
    markFailed(pane, touched, e.message);
    toastErr(e.message);
    return null;
  }

  // Per-item failures arrive in the result instead of throwing, so one bad
  // path in a batch can't abort the rest.
  const failed = (res && res.failed) || [];
  if (failed.length) {
    const failedPaths = new Set(failed.map(f => f.path));
    const back = removedEntries.filter(e => failedPaths.has(e.path));
    if (back.length && pane) pane.applyLocal({ add: back });
    markFailed(pane, failed.map(f => f.path), null);
    toastErr(failed.length === 1
      ? failed[0].error
      : `${failed.length} of ${failed.length + ((res.done || []).length)} item(s) failed`);
  }

  // Paths still owned by a background job stay dimmed until the worker reports.
  const asyncPaths = new Set(((res && res.async) || []).map(a => a.path));
  for (const a of ((res && res.async) || [])) {
    if (a.job) watchJob(a.job, pane);
  }
  if (pane) {
    for (const p of touched) {
      if (failed.some(f => f.path === p)) continue;
      if (asyncPaths.has(p)) continue;
      pane.pending.delete(p);
    }
    pane.refreshDecorations();
  }

  for (const key of invalidate) {
    // Keys are either an explicit cache key or a [mount, path] listing pair.
    if (Array.isArray(key)) invalidateList(key[0], key[1]);
    else invalidate(key);
  }
  if (okMsg) toastOk(okMsg);
  if (onResult) onResult(res);
  return res;
}

function markFailed(pane, paths, message) {
  if (!pane) return;
  for (const p of paths) {
    pane.pending.delete(p);
    if (message) pane.failed.set(p, message);
  }
  pane.refreshDecorations();
}

/* ------------------------------------------------------- job reconciliation
 *
 * Operations on folders are handed to a background worker. The WebSocket push
 * is the fast path for learning they finished, but it is best-effort: if the
 * socket is down — or the environment never delivers frames — the affected rows
 * would stay dimmed forever and the listing would never catch up.
 *
 * This bounded poll is the safety net. It stops as soon as nothing is pending,
 * and gives up after WATCH_MAX_MS so a wedged job can't poll indefinitely.
 */

const watched = new Map();     // jobId -> { pane, deadline, onDone }
let watchTimer = null;
const WATCH_INTERVAL = 2000;
const WATCH_MAX_MS = 5 * 60 * 1000;

/** Track a background job so its pane reconciles even if the push is lost. */
export function watchJob(jobId, pane, onDone) {
  if (!jobId) return;
  watched.set(jobId, { pane, deadline: Date.now() + WATCH_MAX_MS, onDone });
  if (!watchTimer) watchTimer = setInterval(pollWatched, WATCH_INTERVAL);
  // Short jobs shouldn't wait a full tick to settle.
  setTimeout(pollWatched, 800);
}

/** Called from the WS handler the moment a job reaches a terminal state. */
export function resolveJob(jobId, status, message) {
  const w = watched.get(jobId);
  if (!w) return;
  watched.delete(jobId);
  if (w.pane && !w.pane.destroyed) {
    // The job owns these rows no longer.
    w.pane.pending.clear();
    w.pane.refreshDecorations();
    w.pane.scheduleRevalidate(200);
  }
  if (w.onDone) w.onDone(status, message);
  stopIfIdle();
}

function stopIfIdle() {
  if (watched.size === 0 && watchTimer) { clearInterval(watchTimer); watchTimer = null; }
}

async function pollWatched() {
  if (watched.size === 0) { stopIfIdle(); return; }
  let jobs;
  try {
    ({ jobs } = await api.get('/api/jobs?limit=100', { timeout: 15000 }));
  } catch (_) {
    return;   // transient; the next tick retries
  }
  const now = Date.now();
  for (const [id, w] of [...watched]) {
    const job = (jobs || []).find((j) => j.id === id);
    if (job && (job.status === 'done' || job.status === 'error' || job.status === 'canceled')) {
      resolveJob(id, job.status, job.message);
      continue;
    }
    if (now > w.deadline) resolveJob(id, 'timeout', 'still running');
  }
}

/** Standard "run a batch and report the outcome" wrapper. */
export function reportBatch(res, { verb, openJobs }) {
  if (!res) return;
  const done = (res.done || []).length;
  const async = (res.async || []).length;
  const skipped = (res.skipped || []).length;
  if (async) {
    toast(`${verb} ${async} folder(s) in the background…`, 'info');
    if (openJobs) openJobs();
  }
  if (done) {
    toastOk(`${verb} ${done} item(s)${skipped ? `, ${skipped} skipped` : ''}`);
  }
}
