'use strict';
/* Upload pipeline: small files direct, large files chunked; XHR progress + cancel. */
import { api, ApiError } from './api.js';
import { state } from './state.js';
import { toastErr, toastOk } from './ui.js';
import { fmtSize } from './util.js';

const CHUNK_THRESHOLD = 8 * 1024 * 1024; // > 8 MiB → chunked
const CHUNK_SIZE = 4 * 1024 * 1024;

const activeUploads = new Set(); // upload jobs with abort()

export function uploadsActive() { return activeUploads.size; }

/**
 * Upload a File to mount:/path. Returns Promise<{path}|{skipped}>.
 * conflict: 'rename' | 'overwrite' | 'skip'
 */
export function uploadFile(file, mount, dir, conflict = 'rename', onProgress = null) {
  if (file.size > CHUNK_THRESHOLD) return uploadChunked(file, mount, dir, conflict, onProgress);
  return uploadDirect(file, mount, dir, conflict, onProgress);
}

function uploadDirect(file, mount, dir, conflict, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const job = { abort: () => xhr.abort() };
    activeUploads.add(job);
    const fd = new FormData();
    fd.append('path', dir);
    fd.append('conflict', conflict);
    fd.append('files', file, file.name);
    xhr.upload.onprogress = (e) => { if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total); };
    xhr.onload = () => {
      activeUploads.delete(job);
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
    xhr.onerror = () => { activeUploads.delete(job); reject(new ApiError('Upload failed (network)', 0, 'network')); };
    xhr.onabort = () => { activeUploads.delete(job); reject(new ApiError('Canceled', 0, 'aborted')); };
    xhr.open('POST', `/api/upload/${encodeURIComponent(mount)}`);
    xhr.setRequestHeader('X-CSRF-Token', state.csrf);
    xhr.withCredentials = true;
    xhr.send(fd);
  });
}

async function uploadChunked(file, mount, dir, conflict, onProgress) {
  const uploadId = 'u' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const total = Math.ceil(file.size / CHUNK_SIZE);
  const controller = new AbortController();
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
    const r = await api.post(`/api/upload/${encodeURIComponent(mount)}/complete`, {
      uploadId, path: dir, name: file.name, total, conflict,
    }, { signal: controller.signal });
    return r;
  } finally {
    activeUploads.delete(job);
  }
}

/** Queue a batch of files sequentially; reports each result via cb. */
export async function uploadBatch(files, mount, dir, conflict, onFileProgress, onFileDone) {
  for (const f of files) {
    try {
      const r = await uploadFile(f, mount, dir, conflict, (loaded, total) => onFileProgress(f, loaded, total));
      onFileDone(f, null, r);
    } catch (e) {
      if (e.code === 'aborted') onFileDone(f, 'canceled', null);
      else onFileDone(f, e.message, null);
    }
  }
}
