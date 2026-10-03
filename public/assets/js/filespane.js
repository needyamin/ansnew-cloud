'use strict';
/*
 * Files pane: listing, selection, sorting, context menu, drag & drop
 * (external upload AND internal move), selection action bar, keyboard nav.
 */
import { el, clear, fmtSize, fmtDate, debounce } from './util.js';
import { icon, iconFor } from './icons.js';
import { state } from './state.js';
import { fsList } from './fsops.js';
import { preview } from './preview.js';
import { runUploadsWithUI } from './uploadtray.js';
import { toastErr, toastOk } from './ui.js';
import { onLongPress } from './gestures.js';
import { isThumbnailable, thumbUrl, observeThumbs, onThumbError } from './thumbnails.js';

const DRAG_MIME = 'application/x-ansnew';
const SKELETON_ROWS = 8;
const TYPEAHEAD_MS = 700;

export class FilesPane {
  /**
   * @param {{mount:string,path:string}} loc
   * @param {object} [opts] callbacks supplied by main.js
   */
  constructor(loc, opts = {}) {
    this.loc = loc;              // { mount, path }
    this.entries = [];
    this.selected = new Set();   // paths
    this.lastClicked = null;
    this.loading = false;
    this.cursor = -1;            // keyboard navigation index into sorted()
    this.typeBuffer = '';
    this.typeTimer = null;

    this.onNavigate = null;      // callback(loc)
    this.onSelection = null;
    this.compact = !!opts.compact;

    // Action hooks — main.js owns the dialogs, this pane just reports intent.
    this.onContextMenu = opts.onContextMenu || null;
    this.onBackgroundMenu = opts.onBackgroundMenu || null;
    this.onDelete = opts.onDelete || null;
    this.onRename = opts.onRename || null;
    this.onMove = opts.onMove || null;          // (pane, paths, destMount, destDir)
    this.onDownload = opts.onDownload || null;  // (pane, entries)
    this.onCopy = opts.onCopy || null;
    this.onCut = opts.onCut || null;
    this.onNewFolder = opts.onNewFolder || null;
    this.onNewFile = opts.onNewFile || null;
    this.onUpload = opts.onUpload || null;

    this.crumbs = el('div', { class: 'crumbs' });

    // Sort control: works in BOTH view modes (grid mode has no list header).
    this.sortSelect = el('select', { class: 'sort-select', 'aria-label': 'Sort by', title: 'Sort by' },
      el('option', { value: 'name:asc', text: 'Name ↑' }),
      el('option', { value: 'name:desc', text: 'Name ↓' }),
      el('option', { value: 'size:asc', text: 'Size ↑' }),
      el('option', { value: 'size:desc', text: 'Size ↓' }),
      el('option', { value: 'mtime:desc', text: 'Newest' }),
      el('option', { value: 'mtime:asc', text: 'Oldest' }),
    );
    this.sortSelect.value = `${state.sort.key}:${state.sort.dir}`;
    this.sortSelect.addEventListener('change', () => {
      const [key, dir] = this.sortSelect.value.split(':');
      state.sort = { key, dir };
      localStorage.setItem('ansnew.sortKey', key);
      localStorage.setItem('ansnew.sortDir', dir);
      this.render();
    });

    this.search = el('input', { type: 'search', class: 'search', placeholder: 'Search this folder…', 'aria-label': 'Search this folder' });
    this.search.addEventListener('input', debounce(() => this.doSearch(this.search.value.trim()), 350));

    this.toolbar = el('div', { class: 'fm-toolbar' }, this.crumbs, this.sortSelect, this.search);

    this.listHead = el('div', { class: 'list-head', role: 'row' },
      this.headCell('Name', 'name', 'nm'),
      this.headCell('Size', 'size', 'sz'),
      this.headCell('Modified', 'mtime', 'mt'),
    );
    if (state.showPerms) this.listHead.appendChild(el('span', { class: 'ow', text: 'Owner' }));

    this.list = el('div', {
      class: 'filelist ' + state.viewMode,
      tabindex: '0',
      role: 'listbox',
      'aria-multiselectable': 'true',
      'aria-label': 'Files',
    });

    this.selbar = el('div', { class: 'selbar', hidden: true });
    this.root = el('div', { class: 'pane' }, this.toolbar, this.listHead, this.list, this.selbar);

    this.bindDnd();
    this.bindKeys();
    this.bindTouch();

    this.list.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.fitem, .frow')) return;
      e.preventDefault();
      this.menuBackground(e);
    });
    // Clicking empty space clears the selection (matches every file manager).
    this.list.addEventListener('click', (e) => {
      if (e.target.closest('.fitem, .frow, .selbar, .empty-state')) return;
      this.selected.clear();
      this.paintSelection();
    });

    this.navigate(loc.mount, loc.path);
  }

  headCell(label, key, cls) {
    const cell = el('span', { class: cls, text: label, role: 'columnheader', onclick: () => this.sortBy(key) });
    return cell;
  }

  // ---------- data ----------
  async navigate(mount, path, pushHistory = true) {
    this.loading = true;
    this.selected.clear();
    this.cursor = -1;
    this.renderSkeleton();          // immediate feedback instead of a blank pane
    try {
      const data = await fsList(mount, path);
      this.loc = { mount, path: data.path };
      this.mountInfo = data.mount;
      this.entries = data.entries || [];
      if (pushHistory && this.onNavigate) this.onNavigate(this.loc);
      this.render();
    } catch (e) {
      toastErr(e.message);
      this.render();
    } finally { this.loading = false; }
  }
  refresh() { return this.navigate(this.loc.mount, this.loc.path, false); }

  sortBy(key) {
    const dir = state.sort.key === key && state.sort.dir === 'asc' ? 'desc' : 'asc';
    state.sort = { key, dir };
    localStorage.setItem('ansnew.sortKey', key);
    localStorage.setItem('ansnew.sortDir', dir);
    this.sortSelect.value = `${key}:${dir}`;
    this.render();
  }

  sorted() {
    const { key, dir } = state.sort;
    const mul = dir === 'asc' ? 1 : -1;
    return [...this.entries].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      let r = 0;
      if (key === 'size') r = (a.size || 0) - (b.size || 0);
      else if (key === 'mtime') r = (a.mtime || 0) - (b.mtime || 0);
      else r = String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
      return r * mul;
    });
  }

  async doSearch(q) {
    if (!q) return this.refresh();
    try {
      const r = await fetch(`/api/fs/${encodeURIComponent(this.loc.mount)}/search?q=${encodeURIComponent(q)}&path=${encodeURIComponent(this.loc.path)}`, { credentials: 'same-origin' });
      const data = await r.json();
      if (data.ok) { this.entries = data.data.results || []; this.render(); }
    } catch (e) { toastErr(e.message); }
  }

  // ---------- rendering ----------
  renderCrumbs() {
    clear(this.crumbs);
    this.crumbs.appendChild(el('button', { class: 'crumb', text: this.mountInfo?.label || this.loc.mount, onclick: () => this.navigate(this.loc.mount, '/') }));
    const parts = this.loc.path.split('/').filter(Boolean);
    let acc = '';
    for (const p of parts) {
      acc += '/' + p;
      const target = acc;
      this.crumbs.appendChild(el('span', { class: 'muted', text: '›' }));
      this.crumbs.appendChild(el('button', { class: 'crumb', text: p, onclick: () => this.navigate(this.loc.mount, target) }));
    }
    // Keep the deepest crumb in view on long paths.
    this.crumbs.scrollLeft = this.crumbs.scrollWidth;
  }

  /** Shimmer placeholders so a slow listing doesn't look broken. */
  renderSkeleton() {
    this.renderCrumbs();
    this.list.className = 'filelist ' + state.viewMode;
    clear(this.list);
    if (state.viewMode === 'list') this.list.appendChild(this.listHead);
    const wrap = el('div', { class: 'skeleton-wrap' });
    for (let i = 0; i < SKELETON_ROWS; i++) {
      wrap.appendChild(state.viewMode === 'grid'
        ? el('div', { class: 'fitem skeleton' }, el('div', { class: 'sk-ico' }), el('div', { class: 'sk-line' }))
        : el('div', { class: 'frow skeleton' }, el('div', { class: 'sk-ico' }), el('div', { class: 'sk-line' })));
    }
    this.list.appendChild(wrap);
  }

  render() {
    this.renderCrumbs();
    this.list.className = 'filelist ' + state.viewMode;
    clear(this.list);
    if (state.viewMode === 'list') this.list.appendChild(this.listHead);

    const items = this.sorted();
    if (!items.length) {
      this.list.appendChild(this.emptyState());
      this.paintSelection();
      return;
    }
    for (const entry of items) {
      this.list.appendChild(state.viewMode === 'grid' ? this.gridItem(entry) : this.row(entry));
    }
    // Kick off lazy thumbnail loading for whatever is near the viewport.
    observeThumbs(this.list);
    this.paintSelection();
  }

  emptyState() {
    const box = el('div', { class: 'empty-state' },
      icon('folder', 'empty-ico'),
      el('div', { class: 'empty-title', text: 'This folder is empty' }),
      el('div', { class: 'empty-sub muted', text: 'Upload files or create something new.' }),
    );
    const actions = el('div', { class: 'empty-actions' });
    const up = el('button', { class: 'btn primary' }, icon('up'), 'Upload files');
    up.addEventListener('click', () => this.onUpload && this.onUpload(this));
    const nf = el('button', { class: 'btn' }, icon('plus'), 'New folder');
    nf.addEventListener('click', () => this.onNewFolder && this.onNewFolder(this));
    actions.append(up, nf);
    box.appendChild(actions);
    return box;
  }

  gridItem(entry) {
    const visual = isThumbnailable(entry)
      ? el('img', { class: 'thumb', alt: '', 'data-thumb': thumbUrl(this.loc.mount, entry.path), loading: 'lazy', draggable: 'false' })
      : icon(iconFor(entry), 'ico');
    if (visual.tagName === 'IMG') onThumbError(visual);

    const it = el('div', {
      class: 'fitem' + (this.selected.has(entry.path) ? ' selected' : ''),
      dataset: { path: entry.path, dir: entry.type === 'dir' ? '1' : '0' },
      role: 'option',
      'aria-selected': this.selected.has(entry.path) ? 'true' : 'false',
      draggable: 'true',
      title: entry.name,
    },
      visual,
      el('div', { class: 'nm', text: entry.name }),
    );
    this.bindItemEvents(it, entry);
    return it;
  }

  row(entry) {
    const r = el('div', {
      class: 'frow' + (this.selected.has(entry.path) ? ' selected' : ''),
      dataset: { path: entry.path, dir: entry.type === 'dir' ? '1' : '0' },
      role: 'option',
      'aria-selected': this.selected.has(entry.path) ? 'true' : 'false',
      draggable: 'true',
    },
      icon(iconFor(entry), 'ico'),
      el('span', { class: 'nm', text: entry.name, title: entry.name }),
      el('span', { class: 'sz', text: entry.type === 'dir' ? '—' : fmtSize(entry.size) }),
      el('span', { class: 'mt', text: fmtDate(entry.mtime) }),
    );
    if (state.showPerms) r.appendChild(el('span', { class: 'ow', text: `${entry.mode || ''} ${entry.owner || ''}` }));
    r.appendChild(this.rowActions(entry));
    this.bindItemEvents(r, entry);
    return r;
  }

  /** Hover-revealed quick actions (always visible on touch via CSS). */
  rowActions(entry) {
    const box = el('span', { class: 'row-actions' });
    if (entry.type !== 'dir') {
      const dl = el('button', { class: 'btn icon sm', title: 'Download', 'aria-label': 'Download' }, icon('download'));
      dl.addEventListener('click', (e) => { e.stopPropagation(); this.onDownload && this.onDownload(this, [entry]); });
      box.appendChild(dl);
    }
    const rn = el('button', { class: 'btn icon sm', title: 'Rename', 'aria-label': 'Rename' }, icon('edit'));
    rn.addEventListener('click', (e) => { e.stopPropagation(); this.onRename && this.onRename(this, entry); });
    box.appendChild(rn);
    const del = el('button', { class: 'btn icon sm danger', title: 'Delete', 'aria-label': 'Delete' }, icon('trash'));
    del.addEventListener('click', (e) => { e.stopPropagation(); this.onDelete && this.onDelete(this, [entry]); });
    box.appendChild(del);
    return box;
  }

  bindItemEvents(node, entry) {
    node.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) { this.toggleSelect(entry); }
      else if (e.shiftKey && this.lastClicked) { this.rangeSelect(entry); }
      else { this.selectOnly(entry); }
      this.lastClicked = entry.path;
      this.cursor = this.sorted().findIndex(x => x.path === entry.path);
    });
    node.addEventListener('dblclick', () => this.open(entry));
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!this.selected.has(entry.path)) this.selectOnly(entry);
      if (this.onContextMenu) this.onContextMenu(e, entry, this);
    });
    node.addEventListener('dragstart', (e) => {
      // Drag the whole selection when the grabbed item is part of it.
      if (!this.selected.has(entry.path)) this.selectOnly(entry);
      const paths = [...this.selected];
      e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ mount: this.loc.mount, paths }));
      e.dataTransfer.setData('text/plain', paths.join('\n'));
      e.dataTransfer.effectAllowed = 'move';
      node.classList.add('dragging');
      this.root.classList.add('is-dragging');
    });
    node.addEventListener('dragend', () => {
      node.classList.remove('dragging');
      this.root.classList.remove('is-dragging');
      for (const n of this.list.querySelectorAll('.drop-target')) n.classList.remove('drop-target');
    });
    // Folders are drop targets for internal moves.
    if (entry.type === 'dir') {
      node.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
        if (this.selected.has(entry.path)) return;   // don't drop onto itself
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        node.classList.add('drop-target');
      });
      node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
      node.addEventListener('drop', (e) => {
        if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        node.classList.remove('drop-target');
        const payload = this.readDrag(e);
        if (payload && this.onMove) this.onMove(this, payload.paths, this.loc.mount, entry.path, payload.mount);
      });
    }
  }

  readDrag(e) {
    try {
      const raw = e.dataTransfer.getData(DRAG_MIME);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.paths) || !parsed.paths.length) return null;
      return parsed;
    } catch (_) { return null; }
  }

  // ---------- selection ----------
  selectOnly(entry) { this.selected.clear(); this.selected.add(entry.path); this.paintSelection(); }
  toggleSelect(entry) { this.selected.has(entry.path) ? this.selected.delete(entry.path) : this.selected.add(entry.path); this.paintSelection(); }
  rangeSelect(entry) {
    const names = this.sorted().map(x => x.path);
    const a = names.indexOf(this.lastClicked), b = names.indexOf(entry.path);
    if (a < 0 || b < 0) return;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.selected.add(names[i]);
    this.paintSelection();
  }
  selectAll() { for (const e of this.entries) this.selected.add(e.path); this.paintSelection(); }
  clearSelection() { this.selected.clear(); this.paintSelection(); }

  paintSelection() {
    for (const node of this.list.querySelectorAll('[data-path]')) {
      const on = this.selected.has(node.dataset.path);
      node.classList.toggle('selected', on);
      node.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    this.renderSelbar();
    if (this.onSelection) this.onSelection(this);
  }

  /** Floating action bar shown while more than zero items are selected. */
  renderSelbar() {
    clear(this.selbar);
    const n = this.selected.size;
    if (!n) { this.selbar.hidden = true; return; }
    this.selbar.hidden = false;

    const entries = this.selectedEntries();
    const allFiles = entries.every(e => e.type !== 'dir');
    const add = (label, ico, fn, cls = 'btn') => {
      const b = el('button', { class: cls, title: label }, icon(ico), el('span', { class: 'lbl', text: label }));
      b.addEventListener('click', fn);
      this.selbar.appendChild(b);
    };

    this.selbar.appendChild(el('span', { class: 'sel-count', text: `${n} selected` }));
    if (allFiles) add('Download', 'download', () => this.onDownload && this.onDownload(this, entries));
    add('Copy', 'copy', () => this.onCopy && this.onCopy(this, entries));
    add('Cut', 'cut', () => this.onCut && this.onCut(this, entries));
    if (n === 1) add('Rename', 'edit', () => this.onRename && this.onRename(this, entries[0]));
    add('Delete', 'trash', () => this.onDelete && this.onDelete(this, entries), 'btn danger');
    const clearBtn = el('button', { class: 'btn icon', title: 'Clear selection', 'aria-label': 'Clear selection' }, icon('close'));
    clearBtn.addEventListener('click', () => this.clearSelection());
    this.selbar.appendChild(clearBtn);
  }

  selectedEntries() { return this.entries.filter(e => this.selected.has(e.path)); }

  // ---------- actions ----------
  open(entry) {
    if (entry.type === 'dir') this.navigate(this.loc.mount, entry.path);
    else preview(entry, this.loc.mount);
  }

  goUp() {
    if (this.loc.path === '/') return;
    const parent = this.loc.path.replace(/\/[^/]*$/, '') || '/';
    this.navigate(this.loc.mount, parent);
  }

  // ---------- drag & drop ----------
  bindDnd() {
    let depth = 0;
    this.list.addEventListener('dragover', (e) => {
      // External files -> upload; internal payload -> move into this folder.
      if (e.dataTransfer.types.includes(DRAG_MIME)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      } else {
        e.preventDefault();
      }
    });
    this.list.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth++;
      this.list.classList.add('dropzone-active');
    });
    this.list.addEventListener('dragleave', () => {
      if (--depth <= 0) { depth = 0; this.list.classList.remove('dropzone-active'); }
    });
    this.list.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      this.list.classList.remove('dropzone-active');
      const payload = this.readDrag(e);
      if (payload) {
        if (this.onMove) this.onMove(this, payload.paths, this.loc.mount, this.loc.path, payload.mount);
        return;
      }
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) runUploadsWithUI(files, this.loc.mount, this.loc.path, 'rename', () => this.refresh());
    });
  }

  // ---------- touch ----------
  bindTouch() {
    // Long-press opens the same context menu the mouse gets from right-click.
    this.touchOff = onLongPress(this.list, (x, y) => {
      const node = document.elementFromPoint(x, y)?.closest('[data-path]');
      if (!node) return;
      const entry = this.entries.find(en => en.path === node.dataset.path);
      if (!entry) return;
      if (!this.selected.has(entry.path)) this.selectOnly(entry);
      if (this.onContextMenu) this.onContextMenu({ clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} }, entry, this);
    });
  }

  // ---------- keyboard ----------
  bindKeys() {
    this.list.addEventListener('keydown', (e) => {
      const items = this.sorted();
      const mod = e.ctrlKey || e.metaKey;

      if (e.key === 'Backspace') { e.preventDefault(); this.goUp(); return; }
      if (e.key === 'Delete' && this.onDelete) { e.preventDefault(); this.onDelete(this, this.selectedEntries()); return; }
      if (e.key === 'F2' && this.onRename) { e.preventDefault(); const s = this.selectedEntries()[0]; if (s) this.onRename(this, s); return; }
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); this.selectAll(); return; }
      if (e.key === 'Enter') { const s = this.selectedEntries()[0]; if (s) this.open(s); return; }
      if (e.key === 'Escape') { this.clearSelection(); return; }

      // Arrow / Home / End / Page navigation
      const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1
        : e.key === 'PageDown' ? 10 : e.key === 'PageUp' ? -10
        : e.key === 'Home' ? 'first' : e.key === 'End' ? 'last' : 0;
      if (step !== 0 && items.length) {
        e.preventDefault();
        let idx = step === 'first' ? 0 : step === 'last' ? items.length - 1
          : Math.max(0, Math.min(items.length - 1, (this.cursor < 0 ? -1 : this.cursor) + step));
        this.cursor = idx;
        const entry = items[idx];
        if (e.shiftKey && this.lastClicked) this.rangeSelect(entry);
        else { this.selectOnly(entry); this.lastClicked = entry.path; }
        const node = this.list.querySelector(`[data-path="${CSS.escape(entry.path)}"]`);
        node?.scrollIntoView({ block: 'nearest' });
        return;
      }

      // Type-ahead: jump to the first entry starting with the typed prefix.
      if (e.key.length === 1 && !mod && !e.altKey && items.length) {
        this.typeBuffer += e.key.toLowerCase();
        clearTimeout(this.typeTimer);
        this.typeTimer = setTimeout(() => { this.typeBuffer = ''; }, TYPEAHEAD_MS);
        const hit = items.find(x => String(x.name).toLowerCase().startsWith(this.typeBuffer));
        if (hit) {
          this.selectOnly(hit);
          this.lastClicked = hit.path;
          this.cursor = items.indexOf(hit);
          this.list.querySelector(`[data-path="${CSS.escape(hit.path)}"]`)?.scrollIntoView({ block: 'nearest' });
        }
      }
    });
  }

  menuBackground(e) {
    if (this.onBackgroundMenu) this.onBackgroundMenu(e, this);
  }

  setView(mode) {
    state.viewMode = mode;
    localStorage.setItem('ansnew.view', mode);
    this.render();
  }

  destroy() {
    if (this.touchOff) this.touchOff();
  }
}
