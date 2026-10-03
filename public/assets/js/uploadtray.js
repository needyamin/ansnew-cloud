'use strict';
/* Upload tray UI: per-file progress rows with cancel. */
import { el, clear, fmtSize } from './util.js';
import { uploadBatch } from './upload.js';

let tray = null;
let listNode = null;

function ensureTray() {
  if (tray) return tray;
  const collapse = el('button', { class: 'btn icon', title: 'Collapse', text: '▾' });
  const head = el('div', { class: 'tray-head' }, el('span', { style: 'flex:1', text: 'Uploads' }), collapse);
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
  if (listNode && listNode.children.length === 0 && tray) { tray.remove(); tray = null; listNode = null; }
}

/**
 * Run a batch upload with UI. files: File[]. dir: target directory.
 */
export function runUploadsWithUI(files, mount, dir, conflict, onFinished) {
  if (!files.length) return;
  ensureTray();
  const rows = new Map();
  for (const f of files) {
    const bar = el('i', { style: 'width:0%' });
    const row = el('div', { class: 'uprow' },
      el('div', { class: 'r' },
        el('span', { class: 'n', text: f.name }),
        el('span', { class: 'muted', text: fmtSize(f.size) }),
        el('button', { class: 'btn icon', title: 'Cancel', text: '×', onclick: () => ctrl.abort() }),
      ),
      el('div', { class: 'prog' }, bar),
    );
    const ctrl = { abort() { row._abort && row._abort(); } };
    rows.set(f, { row, bar });
    listNode.appendChild(row);
  }

  uploadBatch(files, mount, dir, conflict,
    (f, loaded, total) => {
      const r = rows.get(f);
      if (r) r.bar.style.width = Math.round((loaded / total) * 100) + '%';
    },
    (f, err) => {
      const r = rows.get(f);
      if (r) {
        r.bar.style.width = '100%';
        if (err) { r.row.classList.add('err'); r.row.querySelector('.muted').textContent = err; }
        setTimeout(() => { r.row.remove(); maybeHide(); }, err ? 6000 : 1500);
      }
    });
  if (onFinished) onFinished();
}
