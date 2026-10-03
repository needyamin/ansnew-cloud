'use strict';
/* File operations: mkdir, rename, delete, copy/move (clipboard), archive, extract, favorites, trash helpers. */
import { api } from './api.js';
import { state } from './state.js';
import { toast, toastOk, toastErr } from './ui.js';

export async function fsList(mount, path) {
  return await api.get(`/api/fs/${encodeURIComponent(mount)}/list?path=${encodeURIComponent(path)}`);
}

export async function fsMkdir(mount, path, name) {
  return await api.post(`/api/fs/${encodeURIComponent(mount)}/mkdir`, { path, name });
}

export async function fsCreateFile(mount, path, name) {
  return await api.post(`/api/fs/${encodeURIComponent(mount)}/file`, { path, name });
}

export async function fsRename(mount, path, name) {
  return await api.post(`/api/fs/${encodeURIComponent(mount)}/rename`, { path, name });
}

export async function fsDelete(mount, path, permanent = false) {
  return await api.post(`/api/fs/${encodeURIComponent(mount)}/delete`, { path, permanent });
}

export async function fsCopy(mount, path, destDir, destMount, conflict = 'rename') {
  return await api.post(`/api/fs/${encodeURIComponent(mount)}/copy`, { path, destDir, destMount, conflict });
}

export async function fsMove(mount, path, destDir, destMount, conflict = 'rename') {
  return await api.post(`/api/fs/${encodeURIComponent(mount)}/move`, { path, destDir, destMount, conflict });
}

export async function fsArchive(mount, paths, destDir, name, format = 'zip') {
  return await api.post(`/api/fs/${encodeURIComponent(mount)}/archive`, { paths, destDir, name, format });
}

export async function fsExtract(mount, path, destDir) {
  return await api.post(`/api/fs/${encodeURIComponent(mount)}/extract`, { path, destDir });
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

export async function pasteItems(destMount, destDir) {
  const cb = state.clipboard;
  if (!cb || !cb.items.length) return;
  let ok = 0, fail = 0;
  for (const it of cb.items) {
    try {
      if (cb.mode === 'copy') await fsCopy(it.mount, it.path, destDir, destMount);
      else await fsMove(it.mount, it.path, destDir, destMount);
      ok++;
    } catch (e) {
      fail++;
      toastErr(it.name + ': ' + e.message);
    }
  }
  if (cb.mode === 'cut' && ok) state.clipboard = null;
  if (ok) toastOk(`${cb.mode === 'copy' ? 'Copied' : 'Moved'} ${ok} item(s)${fail ? `, ${fail} failed` : ''}`);
  return { ok, fail };
}

export async function toggleFavorite(mount, path, label) {
  const { favorites } = await api.get('/api/favorites');
  const exists = (favorites || []).some(f => f.mount === mount && f.path === path);
  if (exists) {
    await api.delete('/api/favorites', { mount, path });
    toastOk('Removed from favorites');
    return false;
  }
  await api.post('/api/favorites', { mount, path, label });
  toastOk('Added to favorites');
  return true;
}

export async function trashList(mount) {
  return (await api.get(`/api/trash/${encodeURIComponent(mount)}`)).items;
}
export async function trashRestore(mount, id) {
  return await api.post(`/api/trash/${encodeURIComponent(mount)}/restore`, { id });
}
export async function trashPurge(mount, id) {
  return await api.post(`/api/trash/${encodeURIComponent(mount)}/purge`, { id });
}
export async function trashEmpty(mount) {
  return await api.post(`/api/trash/${encodeURIComponent(mount)}/empty`, {});
}
