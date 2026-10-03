'use strict';
/*
 * Upload pipeline: small files direct, large files chunked; XHR progress + cancel.
 *
 * Files upload through a small worker pool rather than strictly one at a time.
 * Sequential uploads meant a batch of ten small files took ten round trips end
 * to end; three in flight saturates a typical uplink without piling up 2 GB
 * temp files or exhausting php-fpm workers.
 */
import { api, ApiError, invalidateList } from './api.js';
import { state } from './state.js';
import { toastErr, toastOk } from './ui.js';
import { fmtSize } from './util.js';

const CHUNK_THRESHOLD = 8 * 1024 * 1024; // > 8 MiB → chunked
const CHUNK_SIZE = 4 * 1024 * 1024;
/** Concurrent files. Kept modest so one upload can't starve everything else. */
const UPLOAD_CONCURRENCY = 3;

const activeUploads = new Set(); // upload jobs with abort()

export function uploadsActive() { return activeUploads.size; }

/** Abort every in-flight upload (used on logout). */
export function abortAllUploads() {
  for (const job of [...activeUploads]) {
    try { job.abort(); } catch (_) { /* already settled */ }
  }
  activeUploads.clear();
}

/**
 * Upload a File to mount:/path. Returns Promise<{path}|{skipped}>.
 * conflict: 'rename' | 'overwrite' | 'skip'
 * opts.signal: AbortSignal that cancels this file.
 */
export function uploadFile(file, mount, dir, conflict = 'rename', onProgress = null, opts = {}) {
  if (file.size > CHUNK_THRESHOLD) {
    return uploadChunked(file, mount, dir, conflict, onProgress, opts.signal, opts.relPath);
  }
  return uploadDirect(file, mount, dir, conflict, onProgress, opts.signal, opts.relPath);
}

function uploadDirect(file, mount, dir, conflict, onProgress, signal, relPath) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new ApiError('Canceled', 0, 'aborted')); return; }
    const xhr = new XMLHttpRequest();
    const onAbortSignal = () => { try { xhr.abort(); } catch (_) { /* already done */ } };
    const job = { abort: onAbortSignal };
    activeUploads.add(job);
    if (signal) signal.addEventListener('abort', onAbortSignal, { once: true });

    const cleanup = () => {
      activeUploads.delete(job);
      if (signal) signal.removeEventListener('abort', onAbortSignal);
    };

    const fd = new FormData();
    fd.append('path', dir);
    fd.append('conflict', conflict);
    // Relative path (folder uploads) — index-aligned with the single file.
    if (relPath) fd.append('relPaths', JSON.stringify([relPath]));
    // `files[]`, not `files`: PHP keeps only the LAST value for a repeated
    // non-array field name, so a plain `files` silently reduced any multi-file
    // POST to a single upload.
    fd.append('files[]', file, file.name);
    xhr.upload.onprogress = (e) => { if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total); };
    xhr.onload = () => {
      cleanup();
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300 && data.ok) {
          const f = (data.data.files || [])[0] || {};
          resolve(f);
        } else {
          reject(new ApiError(data?.error?.message || 'Upload failed', xhr.status, data?.error?.code));
        }
      } catch (_) { reject(new ApiError('Upload failed', xhr.status, 'error')); }
    };
    xhr.onerror = () => { cleanup(); reject(new ApiError('Upload failed (network)', 0, 'network')); };
    xhr.onabort = () => { cleanup(); reject(new ApiError('Canceled', 0, 'aborted')); };
    xhr.open('POST', `/api/upload/${encodeURIComponent(mount)}`);
    xhr.setRequestHeader('X-CSRF-Token', state.csrf);
    xhr.withCredentials = true;
    xhr.send(fd);
  });
}

async function uploadChunked(file, mount, dir, conflict, onProgress, signal, relPath) {
  const uploadId = 'u' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const total = Math.ceil(file.size / CHUNK_SIZE);
  // Reuse the caller's signal so the tray's Cancel button works for large files
  // too — previously this path made its own controller that nothing could reach.
  const controller = new AbortController();
  const onAbortSignal = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbortSignal, { once: true });
  }
  const job = { abort: () => controller.abort() };
  activeUploads.add(job);
  try {
    for (let i = 0; i < total; i++) {
      if (controller.signal.aborted) throw new ApiError('Canceled', 0, 'aborted');
      const start = i * CHUNK_SIZE;
      const blob = file.slice(start, Math.min(file.size, start + CHUNK_SIZE));
      const fd = new FormData();
      fd.append('uploadId', uploadId);
      fd.append('index', String(i));
      fd.append('chunk', blob, 'chunk');
      await api.post(`/api/upload/${encodeURIComponent(mount)}/chunk`, fd, { signal: controller.signal });
      if (onProgress) onProgress(Math.min(file.size, start + blob.size), file.size);
    }
    return await api.post(`/api/upload/${encodeURIComponent(mount)}/complete`, {
      uploadId, path: dir, name: file.name, total, conflict,
      ...(relPath ? { relPath } : {}),
    }, { signal: controller.signal });
  } finally {
    if (signal) signal.removeEventListener('abort', onAbortSignal);
    activeUploads.delete(job);
  }
}

/**
 * Upload a batch through a bounded worker pool. Resolves only once EVERY file
 * has settled, so callers can rely on it for "the batch is done".
 *
 * @param {File[]} files
 * @param {Function} onFileProgress (file, loaded, total)
 * @param {Function} onFileDone     (file, errorMessageOrNull, result)
 * @param {object}  [opts]          { signalFor: (file) => AbortSignal }
 */
export async function uploadBatch(files, mount, dir, conflict, onFileProgress, onFileDone, opts = {}) {
  const queue = [...files];
  const signalFor = opts.signalFor || null;
  const relPathFor = opts.relPathFor || null;
  const limit = Math.max(1, Math.min(opts.concurrency || UPLOAD_CONCURRENCY, queue.length));

  const worker = async () => {
    for (;;) {
      const f = queue.shift();
      if (!f) return;
      const signal = signalFor ? signalFor(f) : undefined;
      const relPath = relPathFor ? relPathFor(f) : undefined;
      try {
        const r = await uploadFile(f, mount, dir, conflict,
          (loaded, total) => onFileProgress(f, loaded, total), { signal, relPath });
        invalidateList(mount, dir);
        onFileDone(f, null, r);
      } catch (e) {
        if (e && (e.code === 'aborted' || e.name === 'AbortError')) onFileDone(f, 'canceled', null);
        else onFileDone(f, (e && e.message) || 'Upload failed', null);
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, worker));
}
