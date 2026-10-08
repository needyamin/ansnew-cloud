'use strict';
/*
 * Download manager.
 *
 * A browser has two ways to save a file, and this module picks the better one
 * per download:
 *
 *  1. **Stream to disk** (Chrome/Edge, File System Access API): the bytes are
 *     read from the server and written straight into the file the user picked.
 *     Real progress, speed, ETA and cancel, and nothing is ever held in memory —
 *     a 20 GB file costs the same as a 2 MB one.
 *  2. **Hand to the browser** (everywhere else): an <a download> click. The
 *     browser's own download UI takes over, so progress is shown there rather
 *     than here. The tray says so instead of pretending to know.
 *
 * Folders and multi-item selections cannot be zipped by a browser, so those are
 * packed on the server first (background job) and then downloaded through the
 * same path — the tray shows the packing phase and then the transfer.
 */
import { el, clear, fmtSize } from './util.js';
import { api } from './api.js';
import { on } from './realtime.js';
import { icon } from './icons.js';
import { toast, toastErr, toastWarn, confirmDialog } from './ui.js';
import { downloadUrl } from './fsops.js';

/** @type {Map<string, object>} id -> transfer */
const transfers = new Map();
/** Job ids this client started, so another tab's push doesn't trigger a save. */
const ownedJobs = new Set();
/** jobId -> pending transfer id (packing phase) */
const jobToTransfer = new Map();

let seq = 0;
let tray = null;
let listNode = null;

/* -------------------------------------------------------------------- tray */

function ensureTray() {
  if (tray) return tray;
  tray = el('div', { class: 'dltray', role: 'region', 'aria-label': 'Downloads' },
    el('header', {},
      icon('download'),
      el('span', { class: 'ttl', text: 'Downloads' }),
      el('span', { style: 'flex:1' }),
      el('button', { class: 'btn icon sm', title: 'Clear finished', 'aria-label': 'Clear finished', onclick: clearFinished }, icon('close')),
      el('button', { class: 'btn icon sm', title: 'Hide', 'aria-label': 'Hide downloads', onclick: closeTray }, icon('close')),
    ),
  );
  listNode = el('div', { class: 'dl-list' });
  tray.appendChild(listNode);
  document.body.appendChild(tray);
  document.body.classList.add('dltray-open');
  return tray;
}

export function openTray() { ensureTray(); render(); }
export function closeTray() {
  if (tray) { tray.remove(); tray = null; listNode = null; }
  document.body.classList.remove('dltray-open');
}

function clearFinished() {
  for (const [id, t] of [...transfers]) {
    if (t.state === 'done' || t.state === 'canceled' || t.state === 'error') transfers.delete(id);
  }
  render();
  if (!transfers.size) closeTray();
}

function humanSpeed(bps) {
  if (!bps) return '—';
  return fmtSize(bps) + '/s';
}

function humanEta(sec) {
  if (sec === null || sec === undefined || !isFinite(sec)) return '—';
  if (sec < 60) return Math.ceil(sec) + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ' + Math.round(sec % 60) + 's';
  return Math.floor(sec / 3600) + 'h ' + Math.round((sec % 3600) / 60) + 'm';
}

function render() {
  if (!listNode) return;
  clear(listNode);
  if (!transfers.size) {
    listNode.appendChild(el('div', { class: 'muted', style: 'padding:8px', text: 'No downloads.' }));
    return;
  }
  // Newest first.
  for (const t of [...transfers.values()].reverse()) {
    const pct = t.total ? Math.min(100, (t.loaded / t.total) * 100) : (t.state === 'done' ? 100 : 0);
    const bar = el('i', { style: 'width:' + pct.toFixed(1) + '%' });
    const live = t.state === 'active' || t.state === 'packing';
    const row = el('div', { class: 'dl-row' + (t.state === 'error' ? ' err' : '') },
      el('div', { class: 'dl-head' },
        icon(t.state === 'error' ? 'info' : 'download', 'ico'),
        el('span', { class: 'nm', text: t.name, title: t.name }),
        el('span', { style: 'flex:1' }),
        live ? el('button', {
          class: 'btn icon sm', title: 'Cancel download', 'aria-label': 'Cancel download',
          onclick: () => cancelTransfer(t.id),
        }, icon('close')) : null,
      ),
      el('div', { class: 'prog' }, bar),
      el('div', { class: 'dl-meta muted' },
        el('span', { text: t.state === 'packing' ? 'Preparing…' : Math.round(pct) + '%' }),
        el('span', { text: t.total ? `${fmtSize(t.loaded)} of ${fmtSize(t.total)}` : fmtSize(t.loaded) }),
        el('span', { text: humanSpeed(t.speed) }),
        el('span', { text: t.state === 'done' ? 'Done' : (t.state === 'canceled' ? 'Canceled' : (t.state === 'error' ? 'Failed' : humanEta(t.eta))) }),
      ),
      t.error ? el('div', { class: 'dl-err', text: t.error }) : null,
    );
    listNode.appendChild(row);
  }
}

function update(t, patch) {
  Object.assign(t, patch);
  render();
}

/* -------------------------------------------------------------- transfers */

/**
 * Download a URL with real progress.
 *
 * @param {string} url
 * @param {string} name           suggested file name
 * @param {string[]} [jobIds]     background jobs to cancel when this is canceled
 * @returns {Promise<object>} the transfer record
 */
export async function startTransfer(url, name, jobIds = []) {
  const id = 'dl' + (++seq);
  const controller = new AbortController();
  const t = {
    id, url, name, jobIds,
    state: 'active', loaded: 0, total: 0, speed: 0, eta: null, error: null,
    controller, writable: null,
  };
  transfers.set(id, t);
  ensureTray();
  render();

  // Chrome/Edge: write the bytes straight into the file the user picks.
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name });
      const writable = await handle.createWritable();
      t.writable = writable;
      await pump(t, url, writable, controller);
      return t;
    } catch (e) {
      if (e && e.name === 'AbortError') {
        // The picker was dismissed, or Cancel was pressed during the transfer.
        update(t, { state: 'canceled' });
        return t;
      }
      // Anything else: fall through and let the browser handle it.
    }
  }

  // Fallback: the browser downloads it and shows its own progress.
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  update(t, { state: 'browser' });
  toast(`“${name}” was handed to the browser — progress is in your browser's download list.`, 'info', 5000);
  return t;
}

/** Stream url -> writable, tracking progress, speed and ETA. */
async function pump(t, url, writable, controller) {
  let res;
  try {
    res = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
  } catch (e) {
    update(t, { state: t.state === 'canceled' ? 'canceled' : 'error', error: e.message || 'Network error' });
    return;
  }
  if (!res.ok) {
    update(t, { state: 'error', error: 'Download failed (' + res.status + ')' });
    return;
  }
  const total = Number(res.headers.get('content-length')) || 0;
  update(t, { total });

  const reader = res.body ? res.body.getReader() : null;
  if (!reader) {
    update(t, { state: 'error', error: 'This browser cannot stream the response' });
    return;
  }
  const started = performance.now();
  let lastPaint = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      const loaded = t.loaded + value.length;
      const secs = Math.max(0.2, (performance.now() - started) / 1000);
      const speed = loaded / secs;
      const now = performance.now();
      if (now - lastPaint > 200 || loaded === total) {
        lastPaint = now;
        update(t, {
          loaded,
          speed,
          eta: total && speed > 0 ? (total - loaded) / speed : null,
        });
      } else {
        t.loaded = loaded;
        t.speed = speed;
      }
    }
    await writable.close();
    update(t, { state: 'done', loaded: t.loaded || total, speed: 0, eta: null });
  } catch (e) {
    if (e && (e.name === 'AbortError' || t.state === 'canceled')) {
      try { await writable.abort(); } catch (_) { /* already gone */ }
      update(t, { state: 'canceled' });
      return;
    }
    try { await writable.abort(); } catch (_) { /* already gone */ }
    update(t, { state: 'error', error: e && e.message ? e.message : 'Download failed' });
  }
}

export function cancelTransfer(id) {
  const t = transfers.get(id);
  if (!t) return;
  t.state = 'canceled';
  try { t.controller.abort(); } catch (_) { /* already settled */ }
  if (t.writable) { try { t.writable.abort(); } catch (_) { /* ignore */ } }
  for (const j of t.jobIds || []) {
    api.post(`/api/jobs/${encodeURIComponent(j)}/cancel`, {}).catch(() => {});
  }
  for (const j of t.jobIds || []) ownedJobs.delete(j);
  render();
}

/* --------------------------------------------------------- packed downloads */

/**
 * Download files and/or folders as one zip.
 *
 * The packing happens on the server (a browser cannot zip a folder), so the
 * tray tracks the job first and the transfer second.
 *
 * @param {string} mount
 * @param {string[]} paths
 * @param {string} [name]
 */
export async function downloadSelection(mount, paths, name = '') {
  if (!paths || !paths.length) return;
  let r;
  try {
    r = await api.post(`/api/fs/${encodeURIComponent(mount)}/download-selection`, { paths, name });
  } catch (e) {
    toastErr(e.message);
    return;
  }
  const jobId = r.job;
  if (!jobId) return;

  ownedJobs.add(jobId);
  const id = 'dl' + (++seq);
  const t = {
    id, name: r.name || name || 'download.zip', url: null, jobIds: [jobId],
    state: 'packing', loaded: 0, total: 0, speed: 0, eta: null, error: null,
    controller: new AbortController(), writable: null,
    mount, paths,
  };
  transfers.set(id, t);
  jobToTransfer.set(jobId, id);
  ensureTray();
  render();
  return t;
}

/** Wire job progress -> tray, and start the transfer when packing finishes. */
export function initDownloads() {
  on('job.progress', (d) => {
    if (!d || !d.id) return;
    const id = jobToTransfer.get(d.id);
    if (!id) return;
    const t = transfers.get(id);
    if (!t) { jobToTransfer.delete(d.id); return; }

    if (d.status === 'canceled' || d.status === 'error') {
      update(t, { state: d.status === 'canceled' ? 'canceled' : 'error', error: d.message || null });
      jobToTransfer.delete(d.id);
      ownedJobs.delete(d.id);
      return;
    }
    const m = d.result || {};
    if (m.bytesTotal) {
      update(t, {
        loaded: m.bytesDone || 0,
        total: m.bytesTotal,
        speed: m.speed || 0,
        eta: m.etaSeconds ?? null,
      });
    }
    if (d.status === 'done') {
      const token = d.result && d.result.token;
      const mine = ownedTransfer(t);
      jobToTransfer.delete(d.id);
      ownedJobs.delete(d.id);
      if (!token) { update(t, { state: 'error', error: 'The archive was not produced' }); return; }
      // Another tab asked for this one; it owns the save dialog.
      if (!mine) { transfers.delete(t.id); render(); return; }
      t.state = 'active';
      t.url = `/api/download/${encodeURIComponent(token)}`;
      t.name = (d.result && d.result.name) || t.name;
      t.loaded = 0;
      t.total = (d.result && d.result.size) || 0;
      // Replace the record with a live transfer over the finished archive.
      startTransferWith(t);
    }
  });
}

/** Only the tab that asked for the download should pop a save dialog. */
function ownedTransfer(t) {
  return (t.jobIds || []).some((j) => ownedJobs.has(j)) || !t.jobIds.length;
}

async function startTransferWith(t) {
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: t.name });
      const writable = await handle.createWritable();
      t.writable = writable;
      await pump(t, t.url, writable, t.controller);
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') { update(t, { state: 'canceled' }); return; }
    }
  }
  const a = document.createElement('a');
  a.href = t.url;
  a.download = t.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  update(t, { state: 'browser' });
}

/* ------------------------------------------------------------------ helpers */

/** Download a single file with progress. */
export async function downloadFile(mount, entry) {
  return startTransfer(downloadUrl(mount, entry.path), entry.name);
}

/**
 * Download a selection: one file goes straight out with progress, anything
 * else is packed into a zip first.
 */
export async function downloadEntriesWithProgress(mount, entries) {
  if (!entries || !entries.length) return;
  const files = entries.filter((e) => e.type !== 'dir');
  const others = entries.filter((e) => e.type === 'dir');

  for (const f of files) await downloadFile(mount, f);
  if (others.length) {
    await downloadSelection(mount, others.map((e) => e.path),
      others.length === 1 ? others[0].name + '.zip' : '');
  }
}

/** Ask before starting a download that will hit the browser's own UI. */
export async function confirmBigDownload(count) {
  if (count < 5) return true;
  return confirmDialog(`Start ${count} downloads? Each one opens a save dialog.`, {
    title: 'Download', okLabel: 'Start',
  });
}
