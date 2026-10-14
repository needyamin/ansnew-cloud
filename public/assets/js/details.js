'use strict';
/*
 * Details side panel — metadata for the current selection.
 *
 * Reuses the long-dead `.pane-head` styling hook from the stylesheet. On narrow
 * screens CSS hides it (`.details { display: none }` under 900px) so it never
 * competes with the file list for width.
 */
import { el, clear, fmtSize, fmtDate } from './util.js';
import { icon, iconFor } from './icons.js';
import { isFavorite } from './state.js';
import { api } from './api.js';

export class DetailsPanel {
  /**
   * @param {object} handlers callbacks owned by main.js
   */
  constructor(handlers = {}) {
    this.h = handlers;
    this.body = el('div', { class: 'details-body' });
    this.root = el('aside', { class: 'details', 'aria-label': 'Details' }, this.body);
    this.render(null, null);
  }

  /** Re-render from a pane's current selection. */
  update(pane) {
    if (!pane) return this.render(null, null);
    const sel = pane.selectedEntries();
    this.render(sel.length ? sel : null, pane);
  }

  render(entries, pane) {
    clear(this.body);

    if (!entries || !entries.length) {
      this.body.appendChild(el('div', { class: 'details-empty muted' },
        icon('info', 'ico'), el('span', { text: 'Select a file to see its details' })));
      return;
    }

    // Needed by BOTH branches (folder measuring) — declare before either runs.
    const mount = pane ? pane.loc.mount : '';

    if (entries.length > 1) {
      const dirs = entries.filter(e => e.type === 'dir');
      // Folder contents are not in the listing entry's `size`, so the first
      // figure covers plain files only; folder walks fill the rest in.
      const fileTotal = entries.reduce((n, e) => n + (e.type === 'dir' ? 0 : (e.size || 0)), 0);
      this.body.appendChild(el('div', { class: 'details-title', text: `${entries.length} items selected` }));
      const list = this.rows([
        ['Folders', String(dirs.length)],
        ['Files', String(entries.length - dirs.length)],
        ['Total size', fmtSize(fileTotal) + (dirs.length ? ' + folders…' : '')],
      ]);
      this.body.appendChild(list);
      if (dirs.length) {
        // Measure every selected folder's contents (capped) and update in place.
        const dd = list.children[5]; // 3rd pair's <dd>
        dd.textContent = 'Calculating…';
        this.measureFolders(dirs.slice(0, 10), mount).then((sum) => {
          dd.textContent = fmtSize(fileTotal + sum) + (dirs.length > 10 ? ' (first 10 folders)' : '');
        }).catch(() => { dd.textContent = fmtSize(fileTotal) + ' + folders'; });
      }
      this.body.appendChild(this.actions(entries, pane, true));
      return;
    }

    const e = entries[0];
    const head = el('div', { class: 'details-head' });

    head.appendChild(icon(iconFor(e), 'details-ico'));
    head.appendChild(el('div', { class: 'details-title', text: e.name, title: e.name }));
    head.appendChild(el('div', { class: 'muted', text: e.type === 'dir' ? 'Folder' : (e.mime || 'File') }));
    this.body.appendChild(head);

    const list = this.rows([
      ['Size', e.type === 'dir' ? 'Calculating…' : fmtSize(e.size)],
      ['Modified', fmtDate(e.mtime)],
      ['Type', e.extension ? String(e.extension).toUpperCase() : (e.type === 'dir' ? 'Folder' : '—')],
      ['MIME', e.mime || '—'],
      ['Mode', e.mode || '—'],
      ['Owner', [e.owner, e.group].filter(Boolean).join(':') || '—'],
      ['Mount', mount],
      ['Path', e.path],
    ]);
    this.body.appendChild(list);

    // A folder's listing entry has no meaningful size: measure its contents
    // recursively (same source as the Properties dialog) and fill the row in.
    if (e.type === 'dir' && mount) {
      const dd = list.children[1]; // first pair's <dd>
      api.get(`/api/fs/${encodeURIComponent(mount)}/du?path=${encodeURIComponent(e.path)}`)
        .then((d) => {
          if (!d || typeof d.used !== 'number') throw new Error('no data');
          dd.textContent = fmtSize(d.used) + (typeof d.files === 'number' ? ` · ${d.files} file${d.files === 1 ? '' : 's'}` : '');
        })
        .catch(() => { dd.textContent = '—'; });
    }

    this.body.appendChild(this.actions([e], pane, false));
  }

  /** Sum the recursive size of the given folder entries (best effort). */
  async measureFolders(dirs, mount) {
    let sum = 0;
    for (const d of dirs) {
      try {
        const r = await api.get(
          `/api/fs/${encodeURIComponent(mount)}/du?path=${encodeURIComponent(d.path)}`);
        if (r && typeof r.used === 'number') sum += r.used;
      } catch (_) { /* skip unmeasurable folders */ }
    }
    return sum;
  }

  rows(pairs) {
    const list = el('dl', { class: 'details-rows' });
    for (const [k, v] of pairs) {
      list.appendChild(el('dt', { text: k }));
      list.appendChild(el('dd', { text: String(v), title: String(v) }));
    }
    return list;
  }

  actions(entries, pane, bulk) {
    const box = el('div', { class: 'details-actions' });
    const add = (label, ico, fn, cls = 'btn') => {
      if (!fn) return;
      const b = el('button', { class: cls, title: label }, icon(ico), el('span', { class: 'lbl', text: label }));
      b.addEventListener('click', () => fn(entries, pane));
      box.appendChild(b);
    };

    if (!bulk && entries[0].type !== 'dir') {
      add('Open', 'file', (es, p) => this.h.onOpen && this.h.onOpen(es[0], p));
    }
    add('Download', 'download', (es, p) => this.h.onDownload && this.h.onDownload(p, es));
    if (!bulk) add('Rename', 'edit', (es, p) => this.h.onRename && this.h.onRename(p, es[0]));
    if (!bulk && this.h.onToggleFavorite) {
      // Reflect the real state so the button is a toggle, not a one-way action.
      const on = pane ? isFavorite(pane.loc.mount, entries[0].path) : false;
      add(on ? 'Unfavourite' : 'Favourite', on ? 'star' : 'star-outline',
        (es, p) => this.h.onToggleFavorite(es[0], p), on ? 'btn active' : 'btn');
    }
    add('Delete', 'trash', (es, p) => this.h.onDelete && this.h.onDelete(p, es), 'btn danger');
    return box;
  }
}
