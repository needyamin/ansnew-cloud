'use strict';
/*
 * Upload tray UI: per-file progress rows with working cancel, plus optimistic
 * insertion of the incoming files into the target pane.
 *
 * Previously the tray was cosmetic: the Cancel button called a method that was
 * never wired to anything, and the "finished" callback fired the instant the
 * batch STARTED, so uploaded files never appeared until the user navigated away
 * and back.
 */
import { el, clear, fmtSize } from './util.js';
import { uploadBatch } from './upload.js';
import { syntheticEntry, joinPath } from './mutation.js';

let tray = null;
let listNode = null;
/** file -> { row, bar, ctrl } for the active batch. */
let rows = new Map();

function ensureTray() {
  if (tray) return tray;
  const collapse = el('button', { class: 'btn icon', title: 'Collapse', text: '▾' });
  const cancelAll = el('button', { class: 'btn icon', title: 'Cancel all', 'aria-label': 'Cancel all uploads', text: '×' });
  cancelAll.addEventListener('click', () => {
    for (const r of rows.values()) { try { r.ctrl.abort(); } catch (_) { /* settled */ } }
  });
  const head = el('div', { class: 'tray-head' }, el('span', { style: 'flex:1', text: 'Uploads' }), cancelAll, collapse);
  collapse.addEventListener('click', () => {
    const collapsed = tray.classList.toggle('collapsed');
    collapse.textContent = collapsed ? '▴' : '▾';
    collapse.title = collapsed ? 'Expand' : 'Collapse';
  });
  listNode = el('div', { class: 'tray-body' });
  tray = el('div', { class: 'uploadtray', role: 'status', 'aria-live': 'polite' }, head, listNode);
  document.body.appendChild(tray);
  return tray;
}

function maybeHide() {
  if (listNode && listNode.children.length === 0 && tray) {
    tray.remove(); tray = null; listNode = null; rows = new Map();
  }
}

/** Paint a progress bar via transform so no layout is triggered. */
function setBar(r, ratio) {
  const now = Date.now();
  const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  // XHR progress fires far faster than the bar can be usefully repainted.
  if (pct < 100 && now - (r.lastPaint || 0) < 100) return;
  r.lastPaint = now;
  r.bar.style.transform = `scaleX(${pct / 100})`;
}

/**
 * Run a batch upload with UI. files: File[]. dir: target directory.
 *
 * `onFinished` may be a callback, or a FilesPane — in which case the incoming
 * files are shown immediately and the pane is silently revalidated once the
 * whole batch settles. Either way it fires on COMPLETION.
 *
 * @returns {Promise<Array<{name:string,path:string,size:number}>>} the files the
 *          server actually created (conflict renames included), so callers can
 *          record them in Recent.
 */
export function runUploadsWithUI(files, mount, dir, conflict, onFinished, opts = {}) {
  if (!files.length) return Promise.resolve([]);
  const relPathFor = opts.relPathFor || null;
  ensureTray();

  const pane = (onFinished && typeof onFinished === 'object') ? onFinished : null;
  const finish = typeof onFinished === 'function' ? onFinished : null;
  const onScreen = !!pane && !pane.destroyed && pane.loc.mount === mount && pane.loc.path === dir;

  // Provisional rows use a pseudo-path that cannot collide with a real entry, so
  // a name clash (which the server resolves as "name (2).ext") can't clobber the
  // existing file's row. They are swapped for the real entries on completion.
  const provisional = new Map();   // file -> tmpPath
  if (onScreen) {
    const adds = [];
    for (const f of files) {
      // For a folder upload the relative path is what identifies the file, so
      // the provisional row carries it too.
      const rel = relPathFor ? (relPathFor(f) || f.name) : f.name;
      const tmp = joinPath(dir, `__uploading__/${rel}`);
      provisional.set(f, tmp);
      adds.push(syntheticEntry(tmp, f.name, 'file', f.size));
    }
    pane.applyLocal({ add: adds });
    for (const e of adds) pane.pending.add(e.path);
    pane.refreshDecorations();
  }

  const dropProvisional = (f) => {
    if (!onScreen || pane.destroyed) return;
    const tmp = provisional.get(f);
    if (!tmp) return;
    pane.pending.delete(tmp);
    pane.applyLocal({ remove: [tmp] });
  };

  for (const f of files) {
    const bar = el('i', { style: 'width:100%' });
    const ctrl = new AbortController();
    const row = el('div', { class: 'uprow' },
      el('div', { class: 'r' },
        el('span', { class: 'n', text: f.name }),
        el('span', { class: 'muted', text: fmtSize(f.size) }),
        el('button', { class: 'btn icon', title: 'Cancel', text: '×', onclick: () => ctrl.abort() }),
      ),
      el('div', { class: 'prog' }, bar),
    );
    rows.set(f, { row, bar, ctrl });
    listNode.appendChild(row);
  }

  const uploaded = [];

  return uploadBatch(files, mount, dir, conflict,
    (f, loaded, total) => {
      const r = rows.get(f);
      if (r) setBar(r, total ? loaded / total : 0);
    },
    (f, err, result) => {
      const r = rows.get(f);
      if (r) {
        setBar(r, 1);
        if (err) {
          r.row.classList.add('err');
          const meta = r.row.querySelector('.muted');
          if (meta) meta.textContent = err;
        }
      }
      dropProvisional(f);
      // Reconcile the provisional row with what the server actually created —
      // this is what surfaces a "name (2).ext" conflict rename.
      if (result && result.path) {
        uploaded.push({ name: result.name || f.name, path: result.path, size: result.size || f.size });
        if (onScreen && !pane.destroyed) {
          pane.applyLocal({ add: [syntheticEntry(result.path, result.name || f.name, 'file', result.size || f.size)] });
        }
      }
      if (r) setTimeout(() => { r.row.remove(); rows.delete(f); maybeHide(); }, err ? 6000 : 1500);
    },
    { signalFor: (f) => (rows.get(f) ? rows.get(f).ctrl.signal : undefined), relPathFor })
    .then(() => {
      if (finish) finish();
      else if (pane && !pane.destroyed) pane.revalidate();
      maybeHide();
      return uploaded;
    })
    .catch(() => uploaded);
}
