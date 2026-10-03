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
import { isThumbnailable, thumbUrl } from './thumbnails.js';

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

    if (entries.length > 1) {
      const total = entries.reduce((n, e) => n + (e.size || 0), 0);
      const dirs = entries.filter(e => e.type === 'dir').length;
      this.body.appendChild(el('div', { class: 'details-title', text: `${entries.length} items selected` }));
      this.body.appendChild(this.rows([
        ['Folders', String(dirs)],
        ['Files', String(entries.length - dirs)],
        ['Total size', fmtSize(total)],
      ]));
      this.body.appendChild(this.actions(entries, pane, true));
      return;
    }

    const e = entries[0];
    const mount = pane ? pane.loc.mount : '';
    const head = el('div', { class: 'details-head' });

    if (isThumbnailable(e)) {
      const img = el('img', { class: 'details-thumb', alt: e.name, 'data-thumb': thumbUrl(mount, e.path, 256) });
      img.src = img.dataset.thumb;
      head.appendChild(img);
    } else {
      head.appendChild(icon(iconFor(e), 'details-ico'));
    }
    head.appendChild(el('div', { class: 'details-title', text: e.name, title: e.name }));
    head.appendChild(el('div', { class: 'muted', text: e.type === 'dir' ? 'Folder' : (e.mime || 'File') }));
    this.body.appendChild(head);

    this.body.appendChild(this.rows([
      ['Size', e.type === 'dir' ? '—' : fmtSize(e.size)],
      ['Modified', fmtDate(e.mtime)],
      ['Type', e.extension ? String(e.extension).toUpperCase() : (e.type === 'dir' ? 'Folder' : '—')],
      ['MIME', e.mime || '—'],
      ['Mode', e.mode || '—'],
      ['Owner', [e.owner, e.group].filter(Boolean).join(':') || '—'],
      ['Mount', mount],
      ['Path', e.path],
    ]));

    this.body.appendChild(this.actions([e], pane, false));
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
