'use strict';
/* File operations: mkdir, rename, delete, copy/move (clipboard), archive, extract, favorites, trash helpers. */
import { api, listKey, invalidate, invalidateList } from './api.js';
import { state, isFavorite, setFavorites } from './state.js';
import { toast, toastOk, toastErr } from './ui.js';

export { listKey };

/**
 * Directory listing. Cached briefly and revalidated with an ETag, so re-entering
 * a folder (or refreshing after a mutation) is usually a 304 instead of a full
 * directory walk. Pass {signal} to opt out of request sharing.
 */
export async function fsList(mount, path, opts = {}) {
  return await api.get(
    `/api/fs/${encodeURIComponent(mount)}/list?path=${encodeURIComponent(path)}`,
    { cacheKey: listKey(mount, path), ttl: 15000, stale: 300000, ...opts },
  );
}

/** Containing directory of a virtual path. */
export function dirOf(path) {
  const s = String(path || '/');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
}

/**
 * Drop cached listings that a mutation at `path` can have changed: its parent
 * directory, and — since `path` may be a directory — its whole subtree.
 */
export function invalidatePath(mount, path) {
  invalidateList(mount, dirOf(path));
  invalidateList(mount, path);
}

export async function fsMkdir(mount, path, name) {
  const r = await api.post(`/api/fs/${encodeURIComponent(mount)}/mkdir`, { path, name });
  invalidateList(mount, path);
  return r;
}

export async function fsCreateFile(mount, path, name) {
  const r = await api.post(`/api/fs/${encodeURIComponent(mount)}/file`, { path, name });
  invalidateList(mount, path);
  return r;
}

export async function fsRename(mount, path, name) {
  const r = await api.post(`/api/fs/${encodeURIComponent(mount)}/rename`, { path, name });
  invalidatePath(mount, path);
  if (r && r.path) invalidateList(mount, dirOf(r.path));
  return r;
}

/* ------------------------------------------------------------------ batch
 * One request for a whole selection. Each returns
 * { done: [...], async: [{path, job}], failed: [{path, error}], skipped: [...] }
 * so a single bad path can't abort the rest.
 */

export async function fsDeleteBatch(mount, items, permanent = false) {
  const r = await api.post(`/api/fs/${encodeURIComponent(mount)}/delete-batch`, { items, permanent });
  for (const it of items) invalidatePath(mount, it.path);
  return r;
}

export async function fsMoveBatch(mount, items, destDir, destMount, conflict = 'rename') {
  const r = await api.post(`/api/fs/${encodeURIComponent(mount)}/move-batch`, { items, destDir, destMount, conflict });
  for (const it of items) invalidatePath(mount, it.path);
  invalidateList(destMount || mount, destDir);
  return r;
}

export async function fsCopyBatch(mount, items, destDir, destMount, conflict = 'rename') {
  const r = await api.post(`/api/fs/${encodeURIComponent(mount)}/copy-batch`, { items, destDir, destMount, conflict });
  invalidateList(destMount || mount, destDir);
  return r;
}

export async function fsArchive(mount, paths, destDir, name, format = 'zip') {
  const r = await api.post(`/api/fs/${encodeURIComponent(mount)}/archive`, { paths, destDir, name, format });
  invalidateList(mount, destDir);
  return r;
}

export async function fsExtract(mount, path, destDir) {
  const r = await api.post(`/api/fs/${encodeURIComponent(mount)}/extract`, { path, destDir });
  invalidateList(mount, destDir || dirOf(path));
  return r;
}

export function downloadUrl(mount, path) {
  return `/api/fs/${encodeURIComponent(mount)}/download?path=${encodeURIComponent(path)}`;
}

export function triggerDownload(mount, path) {
  const a = document.createElement('a');
  a.href = downloadUrl(mount, path);
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function downloadFolder(mount, path) {
  const r = await api.post(`/api/fs/${encodeURIComponent(mount)}/download-folder`, { path });
  toast('Preparing ZIP download… you will be notified when ready.', 'info');
  return r;
}

export async function consumeDownloadToken(token) {
  const a = document.createElement('a');
  a.href = `/api/download/${encodeURIComponent(token)}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Add or remove a favourite.
 *
 * The current state comes from the in-memory set (kept in sync with the server
 * by refreshSidebarData) rather than a fresh GET, so the star flips instantly
 * and the call can't be wrong-footed by a stale cached list.
 *
 * @returns {Promise<boolean>} the NEW state — true if now favourited
 */
export async function toggleFavorite(mount, path, label) {
  const on = isFavorite(mount, path);
  if (on) {
    // Params go in the query string, not a DELETE body — see the note on
    // FavoritesController::remove.
    await api.delete(`/api/favorites?mount=${encodeURIComponent(mount)}&path=${encodeURIComponent(path)}`);
    setFavorites(state.favorites.filter((f) => !(f.mount === mount && f.path === path)));
  } else {
    await api.post('/api/favorites', { mount, path, label });
    setFavorites([{ mount, path, label }, ...state.favorites]);
  }
  invalidate('favorites');
  toastOk(on ? 'Removed from favourites' : 'Added to favourites');
  return !on;
}

export async function trashList(mount) {
  return (await api.get(`/api/trash/${encodeURIComponent(mount)}`)).items;
}
/** Trash ops restore to an unknown original location, so drop the whole mount. */
export async function trashRestore(mount, id) {
  const r = await api.post(`/api/trash/${encodeURIComponent(mount)}/restore`, { id });
  invalidateList(mount, '/');
  return r;
}
export async function trashPurge(mount, id) {
  const r = await api.post(`/api/trash/${encodeURIComponent(mount)}/purge`, { id });
  invalidateList(mount, '/');
  return r;
}
export async function trashEmpty(mount) {
  const r = await api.post(`/api/trash/${encodeURIComponent(mount)}/empty`, {});
  invalidateList(mount, '/');
  return r;
}
