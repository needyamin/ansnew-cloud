'use strict';
/*
 * Files pane: windowed listing, selection, sorting, context menu, drag & drop
 * (external upload AND internal move), selection action bar, keyboard nav.
 *
 * WINDOWING
 * ---------
 * Only the rows near the viewport exist in the DOM. Rows are absolutely
 * positioned inside a spacer element whose height stands in for the full
 * listing, so a 10 000-entry folder scrolls with a constant node count instead
 * of 10 000 nodes and ~60 000 listeners.
 *
 * Two rules make recycling safe, and breaking either one causes subtle,
 * hard-to-find bugs:
 *   1. Listeners are bound ONCE per node, in createNode(). Never in fill().
 *   2. No handler closes over an entry. They resolve it from dataset.path at
 *      event time, so a recycled node always acts on the row it currently shows.
 *
 * REFRESH
 * -------
 * `navigate()` is the only thing that resets scroll/selection. `refresh()` and
 * `revalidate()` re-fetch *silently*: no skeleton, no cleared selection, no
 * scroll jump, and errors leave whatever is on screen untouched.
 */
import { el, clear, fmtSize, fmtDate, debounce } from './util.js';
import { icon, iconFor } from './icons.js';
import { state, isFavorite } from './state.js';
import { api } from './api.js';
import { fsList } from './fsops.js';
import { preview } from './preview.js';
import { runUploadsWithUI } from './uploadtray.js';
import { toastErr, toastOk } from './ui.js';
import { onLongPress } from './gestures.js';
import { isThumbnailable, thumbUrl, createThumbObserver, onThumbError } from './thumbnails.js';
import { FilterBar, matches } from './filters.js';

const DRAG_MIME = 'application/x-ansnew';
const SKELETON_ROWS = 8;
const TYPEAHEAD_MS = 700;

/** Rows rendered beyond the viewport, so scrolling never shows a blank edge. */
const LIST_BUFFER = 6;
const GRID_BUFFER = 3;
/** Hard ceiling on live nodes, whatever the viewport claims to need. */
const MAX_NODES = 400;
/** Used before the first real measurement; corrected on the first layout. */
const LIST_ROW_FALLBACK = 30;

/**
 * Rubber-band selection. The slop is the travel needed before a press on empty
 * space counts as a drag rather than a click (which just clears the selection).
 */
const MARQUEE_SLOP = 4;
/** Distance from the top/bottom edge at which a drag starts auto-scrolling. */
const MARQUEE_EDGE = 26;
/** Auto-scroll speed in px/frame at the very edge. */
const MARQUEE_MAX_SPEED = 18;

/** True for the two tile-shaped modes (Large icons and List). */
const isTileMode = () => state.viewMode === 'icons' || state.viewMode === 'list';

/** Monotonic pane id — panes need identity so WS/cache events can target them. */
let paneSeq = 0;

export class FilesPane {
  /**
   * @param {{mount:string,path:string}} loc
   * @param {object} [opts] callbacks supplied by main.js
   */
  constructor(loc, opts = {}) {
    this.id = 'pane' + (++paneSeq);
    this.loc = loc;              // { mount, path }
    this.entries = [];
    this.byPath = new Map();     // path -> entry, the lookup recyclers use
    this.selected = new Set();   // paths
    this.lastClicked = null;
    this.loading = false;
    this.cursor = -1;            // keyboard navigation index into view()
    this.typeBuffer = '';
    this.typeTimer = null;

    // Lifecycle. reqSeq guards against stale responses landing after a
    // navigation or destroy(); listAbort cancels the in-flight listing.
    this.destroyed = false;
    this.reqSeq = 0;
    this.searchSeq = 0;
    this.listAbort = null;
    this.ro = null;
    this.scrollRaf = 0;

    // Windowing state.
    this.rendered = new Map();   // index -> node
    this.pool = [];              // recycled, detached nodes
    this._view = [];
    this.viewDirty = true;
    this.indexByPath = new Map();
    this.cols = 1;
    this.colW = 0;
    this.rowH = 0;
    this.rowPitch = LIST_ROW_FALLBACK;
    this.gapY = 0;
    this.padL = 0;
    this.rowMeasured = false;
    this.skeletonNode = null;
    this.emptyNode = null;

    // Row decoration applied by fill() — optimistic UI state lives here.
    this.pending = new Set();    // paths with an in-flight operation
    this.failed = new Map();     // path -> error message

    this.dragging = false;
    this.dropTargetNode = null;
    this.pendingRevalidate = false;
    this.thumbs = createThumbObserver();

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
    this.onOpenEntry = opts.onOpenEntry || null;   // (pane, entry) — Recent tracking
    this.onColumnsMenu = opts.onColumnsMenu || null; // (event) — list header right-click
    this.onFindDuplicates = opts.onFindDuplicates || null; // (pane) — toolbar action
    this.onBulkRename = opts.onBulkRename || null;         // (pane, entries)

    // Explorer-style address bar: breadcrumbs by default, a typeable path on
    // demand (click it, or Ctrl+L / Alt+D). Typing "other-drive:/docs" jumps
    // straight across drives.
    this.crumbs = el('div', { class: 'crumbs' });
    this.addrInput = el('input', {
      type: 'text', class: 'addr-input', hidden: true,
      'aria-label': 'Address (drive:/folder)', spellcheck: 'false',
    });
    this.addrBar = el('div', { class: 'addrbar' }, this.crumbs, this.addrInput);
    this.addrBar.addEventListener('click', (e) => {
      if (e.target.closest('.crumb') || e.target === this.addrInput) return;
      this.editAddress();
    });
    this.addrInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.commitAddress(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.endAddress(); }
      e.stopPropagation();
    });
    this.addrInput.addEventListener('blur', () => this.endAddress());

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
      this.applySort(key, dir);
    });

    this.search = el('input', { type: 'search', class: 'search', placeholder: 'Search this folder…', 'aria-label': 'Search this folder' });
    this.search.addEventListener('input', debounce(() => this.doSearch(this.search.value.trim()), 350));

    // Duplicate scan is folder-scoped, so it belongs with the other
    // folder-level controls rather than in the selection bar.
    this.dupBtn = el('button', {
      class: 'btn icon sm', title: 'Find duplicate files in this folder',
      'aria-label': 'Find duplicate files in this folder',
      onclick: () => this.onFindDuplicates && this.onFindDuplicates(this),
    }, icon('copy'));

    this.toolbar = el('div', { class: 'fm-toolbar' }, this.addrBar, this.sortSelect, this.dupBtn, this.search);

    // File-type filter. Filtering is client-side over the listing the pane
    // already holds, so a chip click is instant and costs no request.
    this.filterBar = new FilterBar({
      onChange: () => { this.viewDirty = true; this.render(); },
    });

    this.listHead = el('div', { class: 'list-head', role: 'row' },
      this.headCell('Name', 'name', 'nm'),
      this.headCell('Size', 'size', 'sz'),
      this.headCell('Modified', 'mtime', 'mt'),
    );
    this.ownerHead = el('span', { class: 'ow', text: 'Owner' });
    this.listHead.appendChild(this.ownerHead);
    // Right-click the header to pick which columns are shown.
    this.listHead.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.onColumnsMenu) this.onColumnsMenu(e);
    });
    this.syncColumns();

    // The scroll viewport. The header lives outside it (see below) because a
    // sticky header cannot coexist with absolutely-positioned rows.
    this.list = el('div', {
      class: 'filelist ' + state.viewMode,
      tabindex: '0',
      role: 'listbox',
      'aria-multiselectable': 'true',
      'aria-label': 'Files',
    });
    this.spacer = el('div', { class: 'fl-spacer' });
    this.list.appendChild(this.spacer);

    // Rubber-band selection. The overlay lives inside the spacer so it shares
    // the coordinate space the rows are positioned in — which means it scrolls
    // with the content for free, and its geometry can be computed from the same
    // rowPitch/colW numbers fill() uses.
    this.marquee = el('div', { class: 'marquee', hidden: true, 'aria-hidden': 'true' });
    this.spacer.appendChild(this.marquee);
    this.mq = null;              // active drag state, or null
    this.mqSuppressClick = false;// swallow the click that follows a drag
    this.mqSuppressTimer = 0;
    this.mqRaf = 0;              // auto-scroll frame

    this.selbar = el('div', { class: 'selbar', hidden: true });
    this.root = el('div', { class: 'pane' }, this.toolbar, this.filterBar.root, this.listHead, this.list, this.selbar);

    this.bindDnd();
    this.bindKeys();
    this.bindTouch();
    this.bindScroll();
    this.bindMarquee();

    this.list.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.fitem, .frow')) return;
      e.preventDefault();
      this.menuBackground(e);
    });
    // Clicking empty space clears the selection (matches every file manager) —
    // unless that click is the tail of a rubber-band drag, which has just set it.
    this.list.addEventListener('click', (e) => {
      if (this.consumeSuppressedClick()) return;
      if (e.target.closest('.fitem, .frow, .selbar, .empty-state')) return;
      this.selected.clear();
      this.paintSelection();
    });

    state.panes.add(this);
    this.navigate(loc.mount, loc.path);
  }

  headCell(label, key, cls) {
    return el('span', { class: cls, text: label, role: 'columnheader', onclick: () => this.sortBy(key) });
  }

  /**
   * Show/hide the Size, Modified and Owner columns.
   *
   * Toggling `hidden` on the header cells and the row cells is enough because
   * both are fixed-width flex children — the name column simply absorbs the
   * space, so no CSS grid template has to change.
   */
  syncColumns() {
    this.headCells = this.headCells || {
      sz: this.listHead.querySelector('.sz'),
      mt: this.listHead.querySelector('.mt'),
    };
    const { sz, mt } = this.headCells;
    if (sz) sz.hidden = !state.cols.size;
    if (mt) mt.hidden = !state.cols.mtime;
    if (this.ownerHead) this.ownerHead.hidden = !state.cols.owner;
  }

  /** Refresh the filter bar's counts and extension list for the current listing. */
  syncFilterBar() {
    this.filterBar.setLocation(this.loc.mount, this.loc.path);
    this.filterBar.update(this.entries);
    this.filterBar.applyRemembered();
    this.viewDirty = true;
  }

  /* ================================================================ data */

  /**
   * Point the pane at a directory. Only a *different* location resets scroll
   * and selection; a soft refresh of the same directory leaves both alone.
   */
  async navigate(mount, path, pushHistory = true, opts = {}) {
    const soft = !!opts.soft;
    const seq = ++this.reqSeq;

    if (this.listAbort) { try { this.listAbort.abort(); } catch (_) { /* settled */ } }
    this.listAbort = new AbortController();

    if (!soft) {
      this.selected.clear();
      this.cursor = -1;
      this.loading = true;
      this.renderSkeleton();
    }

    try {
      const data = await fsList(mount, path, { signal: this.listAbort.signal, force: !!opts.force });
      if (this.destroyed || seq !== this.reqSeq) return;      // superseded

      const sameLoc = this.loc.mount === mount && this.loc.path === data.path;
      const anchor = sameLoc ? this.captureAnchor() : null;

      this.loc = { mount, path: data.path };
      this.mountInfo = data.mount;
      this.setEntries(data.entries || []);
      this.syncFilterBar();
      if (pushHistory && this.onNavigate) this.onNavigate(this.loc);
      if (!sameLoc) this.resetViewport();

      this.render({ anchor });
      this.pending.clear();
      this.failed.clear();
    } catch (e) {
      if (this.destroyed || seq !== this.reqSeq) return;
      if (e && e.name === 'AbortError') return;
      // A failed refresh must never wipe the pane: keep the stale listing and
      // just surface the problem.
      if (!soft) toastErr(e.message);
      if (!this.entries.length) this.render({});
    } finally {
      if (seq === this.reqSeq) this.loading = false;
    }
  }

  /** Re-fetch the current directory. Cheap: usually answers 304 Not Modified. */
  refresh() {
    return this.navigate(this.loc.mount, this.loc.path, false, { soft: true, force: true });
  }

  /** Silent background revalidate (WS events, post-job reconciliation). */
  revalidate(opts = {}) {
    // Never yank rows out from under an in-flight drag.
    if (this.dragging) { this.pendingRevalidate = true; return Promise.resolve(); }
    // Don't overwrite optimistic rows with server state that predates them —
    // the operation that created them revalidates once it settles.
    if (this.pending.size) { this.scheduleRevalidate(900); return Promise.resolve(); }
    return this.navigate(this.loc.mount, this.loc.path, false, { soft: true, ...opts });
  }

  /** Debounced revalidate, for bursty event sources (e.g. 500 upload events). */
  scheduleRevalidate(delay = 750) {
    clearTimeout(this._revalidateTimer);
    this._revalidateTimer = setTimeout(() => { this.revalidate(); }, delay);
  }

  setEntries(list) {
    this.entries = list;
    this.byPath = new Map();
    for (const e of list) this.byPath.set(e.path, e);
    this.viewDirty = true;
  }

  /** Rebuild the path lookup + sorted view after a local mutation. */
  reindex() {
    this.byPath = new Map();
    for (const e of this.entries) this.byPath.set(e.path, e);
    this.viewDirty = true;
  }

  entryByPath(path) { return this.byPath.get(path) || null; }

  /**
   * Apply a local change without a round trip — the basis of every optimistic
   * operation. Returns an undo closure that restores the previous state.
   *
   * @param {{add?:Array, remove?:string[], update?:Array}} patch
   */
  applyLocal({ add = [], remove = [], update = [] }) {
    const prev = new Map();                       // path -> entry | null
    const snapshot = (path) => { if (!prev.has(path)) prev.set(path, this.byPath.get(path) || null); };

    for (const p of remove) { snapshot(p); this.byPath.delete(p); }
    for (const e of add) { snapshot(e.path); this.byPath.set(e.path, e); }
    for (const e of update) { snapshot(e.path); this.byPath.set(e.path, e); }

    this.commitLocal();

    return () => {
      for (const [path, entry] of prev) {
        if (entry) this.byPath.set(path, entry);
        else this.byPath.delete(path);
      }
      this.commitLocal();
    };
  }

  /** Rebuild entries/view from byPath and repaint, holding the scroll anchor. */
  commitLocal() {
    this.entries = [...this.byPath.values()];
    this.syncFilterBar();
    this.viewDirty = true;
    // Drop selections whose row no longer exists.
    for (const p of [...this.selected]) {
      if (!this.byPath.has(p)) this.selected.delete(p);
    }
    const anchor = this.captureAnchor();
    this.render({ anchor });
  }

  /**
   * Re-apply row decorations (favourite star, pending, failed) to the rows
   * currently on screen, without a re-render.
   */
  refreshDecorations() {
    for (const node of this.rendered.values()) {
      const entry = this.entryOf(node);
      if (!entry) continue;
      node.classList.toggle('pending', this.pending.has(entry.path));
      const msg = this.failed.get(entry.path);
      node.classList.toggle('failed', !!msg);
      node.title = msg || entry.name;
      this.applyFavMark(node, entry);
    }
  }

  /** Resolve the entry a DOM node currently represents (recycle-safe). */
  entryOf(node) {
    if (!node || !node.dataset || !node.dataset.path) return null;
    return this.byPath.get(node.dataset.path) || null;
  }

  sortBy(key) {
    const dir = state.sort.key === key && state.sort.dir === 'asc' ? 'desc' : 'asc';
    this.applySort(key, dir);
  }

  applySort(key, dir) {
    state.sort = { key, dir };
    localStorage.setItem('ansnew.sortKey', key);
    localStorage.setItem('ansnew.sortDir', dir);
    this.sortSelect.value = `${key}:${dir}`;
    this.viewDirty = true;
    const anchor = this.captureAnchor();
    this.render({ anchor });
  }

  /**
   * Sorted view of `entries`. Cached — this used to be recomputed (and
   * reallocated) on every click, keydown and range selection.
   */
  view() {
    if (!this.viewDirty) return this._view;
    const { key, dir } = state.sort;
    const mul = dir === 'asc' ? 1 : -1;
    // The type filter is applied before sorting so the sort only ever works on
    // the rows that will actually be shown.
    const src = this.filterBar && this.filterBar.isActive
      ? this.entries.filter((e) => matches(e, this.filterBar.filter))
      : this.entries;
    const arr = [...src].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      let r = 0;
      if (key === 'size') r = (a.size || 0) - (b.size || 0);
      else if (key === 'mtime') r = (a.mtime || 0) - (b.mtime || 0);
      else r = String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
      return r * mul;
    });
    this._view = arr;
    this.indexByPath = new Map();
    for (let i = 0; i < arr.length; i++) this.indexByPath.set(arr[i].path, i);
    this.viewDirty = false;
    return arr;
  }

  /** Kept for callers that used the old name. */
  sorted() { return this.view(); }

  async doSearch(q) {
    const seq = ++this.searchSeq;
    if (!q) { this.refresh(); return; }
    try {
      const data = await api.get(
        `/api/fs/${encodeURIComponent(this.loc.mount)}/search?q=${encodeURIComponent(q)}&path=${encodeURIComponent(this.loc.path)}`,
        { timeout: 20000 },
      );
      if (this.destroyed || seq !== this.searchSeq) return;
      const anchor = this.captureAnchor();
      this.setEntries(data.results || []);
      this.syncFilterBar();
      this.render({ anchor });
    } catch (e) {
      if (seq !== this.searchSeq) return;
      toastErr(e.message);
    }
  }

  /* ========================================================== windowing */

  /** Recompute geometry from the current view mode and the viewport width. */
  measure() {
    const cs = getComputedStyle(this.list);
    this.padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const innerW = Math.max(0, this.list.clientWidth - this.padL - padR);

    if (isTileMode()) {
      const min = parseFloat(cs.getPropertyValue('--tile-min')) || 110;
      const gap = parseFloat(cs.getPropertyValue('--tile-gap')) || 4;
      const tileH = parseFloat(cs.getPropertyValue('--tile-h')) || 120;
      this.cols = Math.max(1, Math.floor((innerW + gap) / (min + gap)));
      this.colW = Math.max(0, (innerW - (this.cols - 1) * gap) / this.cols);
      this.rowH = tileH;
      this.gapY = gap;
    } else {
      this.cols = 1;
      this.colW = innerW;
      this.gapY = 0;
      if (!this.rowH) this.rowH = LIST_ROW_FALLBACK;
    }
    this.rowPitch = this.rowH + this.gapY;
    // Only Details has a header row; List and Icons are free-flowing.
    this.listHead.hidden = state.viewMode !== 'details';
  }

  /** Total scrollable height of the virtual listing. */
  contentHeight() {
    const n = this.view().length;
    if (!n) return 0;
    const rows = Math.ceil(n / this.cols);
    return Math.max(0, rows * this.rowPitch - this.gapY);
  }

  /** Render exactly the rows that overlap the viewport (plus a small buffer). */
  layout() {
    if (this.destroyed) return;
    const v = this.view();
    const n = v.length;

    if (!n) {
      for (const node of this.rendered.values()) this.releaseNode(node);
      this.rendered.clear();
      this.spacer.style.height = '0px';
      // "No files of this type" is a different message from "this folder is
      // empty": one offers a way out (clear the filter), the other offers
      // upload. Showing the wrong one makes the pane look broken.
      this.showEmpty(true, this.entries.length > 0 && !!(this.filterBar && this.filterBar.isActive));
      return;
    }
    this.showEmpty(false);

    const rows = Math.ceil(n / this.cols);
    this.spacer.style.height = this.contentHeight() + 'px';

    const vh = this.list.clientHeight || 400;
    const st = this.list.scrollTop;
    const buf = isTileMode() ? GRID_BUFFER : LIST_BUFFER;

    const firstRow = Math.max(0, Math.floor(st / this.rowPitch) - buf);
    let lastRow = Math.min(rows - 1, Math.floor((st + vh) / this.rowPitch) + buf);
    if (lastRow < firstRow) lastRow = firstRow;

    const firstIdx = firstRow * this.cols;
    let lastIdx = Math.min(n - 1, (lastRow + 1) * this.cols - 1);
    if (lastIdx - firstIdx + 1 > MAX_NODES) lastIdx = firstIdx + MAX_NODES - 1;

    for (const [i, node] of this.rendered) {
      if (i < firstIdx || i > lastIdx) {
        this.releaseNode(node);
        this.rendered.delete(i);
      }
    }
    for (let i = firstIdx; i <= lastIdx; i++) {
      let node = this.rendered.get(i);
      if (!node) {
        node = this.pool.pop() || this.createNode();
        this.rendered.set(i, node);
        this.spacer.appendChild(node);
      }
      this.fill(node, v[i], i);
    }

    // Row height isn't known until a real row exists; correct it once and redo
    // the pass so every row lands on the right pixel.
    if (state.viewMode === 'details' && !this.rowMeasured) {
      const probe = this.rendered.values().next().value;
      const h = probe ? probe.offsetHeight : 0;
      if (h > 0) {
        this.rowMeasured = true;
        if (Math.abs(h - this.rowH) > 0.5) {
          this.rowH = h;
          this.rowPitch = h;
          this.layout();
          return;
        }
      }
    }
    this.applyActiveDescendant();
  }

  /** Build a node once — including its listeners. */
  createNode() {
    const node = isTileMode() ? this.buildTileNode() : this.buildRowNode();
    node.style.position = 'absolute';
    node.style.top = '0';
    node.style.left = '0';
    this.bindNodeEvents(node);
    return node;
  }

  buildRowNode() {
    const ico = icon('file', 'ico');
    const nm = el('span', { class: 'nm' });
    // Always-visible marker so favourite state is scannable without hovering.
    const favMark = icon('star', 'fav-mark');
    const sz = el('span', { class: 'sz' });
    const mt = el('span', { class: 'mt' });
    const ow = el('span', { class: 'ow' });
    const actions = this.buildRowActions();
    const node = el('div', { class: 'frow', role: 'option', draggable: 'true' }, ico, nm, favMark, sz, mt, ow, actions);
    node._refs = { ico, nm, favMark, sz, mt, ow, actions };
    return node;
  }

  buildTileNode() {
    const ico = icon('file', 'ico');
    const visual = el('div', { class: 'visual' }, ico);
    const favMark = icon('star', 'fav-mark');
    const nm = el('div', { class: 'nm' });
    const node = el('div', { class: 'fitem', role: 'option', draggable: 'true' }, visual, favMark, nm);
    node._refs = { visual, ico, favMark, nm };
    return node;
  }

  /**
   * Hover-revealed quick actions (always visible on touch via CSS).
   * Built once per node; the entry is resolved at click time.
   */
  buildRowActions() {
    const box = el('span', { class: 'row-actions' });
    const mk = (icoName, title, handler, cls = '') => {
      const b = el('button', { class: 'btn icon sm' + (cls ? ' ' + cls : ''), title, 'aria-label': title }, icon(icoName));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const entry = this.entryOf(e.currentTarget.closest('[data-path]'));
        if (entry) handler(entry);
      });
      box.appendChild(b);
      return b;
    };
    const dl = mk('download', 'Download', (entry) => this.onDownload && this.onDownload(this, [entry]));
    const fav = mk('star-outline', 'Add to favourites',
      (entry) => this.onToggleFavorite && this.onToggleFavorite(this, entry), 'fav');
    mk('edit', 'Rename', (entry) => this.onRename && this.onRename(this, entry));
    mk('trash', 'Delete', (entry) => this.onDelete && this.onDelete(this, [entry]), 'danger');
    box._dl = dl;
    box._fav = fav;
    return box;
  }

  /** Point a node at `entry`, positioning it and refreshing every field. */
  fill(node, entry, i) {
    if (!entry) return;
    const tile = isTileMode();
    const row = Math.floor(i / this.cols);

    if (tile) {
      const col = i % this.cols;
      node.style.transform = `translate3d(${Math.round(col * (this.colW + this.gapY))}px, ${Math.round(row * this.rowPitch)}px, 0)`;
      node.style.width = Math.max(0, Math.round(this.colW)) + 'px';
    } else {
      // The spacer already sits inside the scroll container's padding, so rows
      // span its full width — no manual padding offset needed.
      node.style.transform = `translate3d(0, ${Math.round(row * this.rowPitch)}px, 0)`;
      node.style.left = '0';
      node.style.right = '0';
    }

    node.dataset.path = entry.path;
    node.dataset.dir = entry.type === 'dir' ? '1' : '0';
    node.id = `${this.id}-r${i}`;
    node.classList.remove('drop-target', 'dragging');
    node.classList.toggle('pending', this.pending.has(entry.path));
    const failMsg = this.failed.get(entry.path);
    node.classList.toggle('failed', !!failMsg);
    node.title = failMsg || entry.name;
    this.applySelClass(node);
    this.applyFavMark(node, entry);

    if (tile) {
      const { visual, ico, nm } = node._refs;
      nm.textContent = entry.name;
      if (isThumbnailable(entry)) {
        let img = node._refs.img;
        if (!img) {
          img = el('img', { class: 'thumb', alt: '', loading: 'lazy', draggable: 'false' });
          onThumbError(img);
          node._refs.img = img;
        }
        if (visual.firstChild !== img) visual.replaceChildren(img);
        const url = thumbUrl(this.loc.mount, entry.path);
        if (img.dataset.thumb !== url) {
          img.dataset.thumb = url;
          img.removeAttribute('src');
          img.classList.remove('thumb-failed');
        }
        this.thumbs.watch(img);
        node._thumbImg = img;
      } else {
        if (node._thumbImg) { this.thumbs.unwatch(node._thumbImg); node._thumbImg = null; }
        if (visual.firstChild !== ico) visual.replaceChildren(ico);
        setIcon(ico, iconFor(entry));
      }
      return;
    }

    const { ico, nm, sz, mt, ow, actions } = node._refs;
    setIcon(ico, iconFor(entry));
    nm.textContent = entry.name;
    nm.title = entry.name;
    // Row cells follow the same toggles as the header cells; `sz`/`mt`/`ow` are
    // inline-flex-able spans, so `hidden` alone is not reliably enough — belt
    // and braces with a class the stylesheet can target.
    sz.textContent = entry.type === 'dir' ? '—' : fmtSize(entry.size);
    mt.textContent = fmtDate(entry.mtime);
    if (ow) ow.textContent = `${entry.mode || ''} ${entry.owner || ''}`;
    const cols = state.cols;
    for (const [node2, on] of [[sz, cols.size], [mt, cols.mtime], [ow, cols.owner]]) {
      if (!node2) continue;
      node2.hidden = !on;
      node2.style.display = on ? '' : 'none';
    }
    if (actions && actions._dl) actions._dl.hidden = entry.type === 'dir';
  }

  /** Return a node to the pool. Must strip everything fill() sets. */
  releaseNode(node) {
    if (node._thumbImg) { this.thumbs.unwatch(node._thumbImg); node._thumbImg = null; }
    node.classList.remove('selected', 'drop-target', 'dragging', 'pending', 'failed');
    node.removeAttribute('data-path');
    node.removeAttribute('data-dir');
    node.removeAttribute('aria-selected');
    if (node.id) node.id = '';
    node.remove();
    if (this.pool.length < MAX_NODES) this.pool.push(node);
  }

  resetViewport() {
    for (const node of this.rendered.values()) this.releaseNode(node);
    this.rendered.clear();
    this.list.scrollTop = 0;
    this.rowMeasured = false;
  }

  /** Scroll so that index `i` is visible, then ensure it is rendered. */
  scrollToIndex(i) {
    const row = Math.floor(i / this.cols);
    const top = row * this.rowPitch;
    const vh = this.list.clientHeight;
    const st = this.list.scrollTop;
    if (top < st) this.list.scrollTop = top;
    else if (top + this.rowH > st + vh) this.list.scrollTop = top + this.rowH - vh;
    this.layout();
    this.applyActiveDescendant();
  }

  applyActiveDescendant() {
    const path = this.cursor >= 0 ? this.view()[this.cursor]?.path : null;
    if (!path) { this.list.removeAttribute('aria-activedescendant'); return; }
    const node = this.rendered.get(this.indexByPath.get(path));
    if (node && node.id) this.list.setAttribute('aria-activedescendant', node.id);
    else this.list.removeAttribute('aria-activedescendant');
  }

  /* ------------------------------------------------------------ scroll */

  captureAnchor() {
    const i = Math.floor(this.list.scrollTop / this.rowPitch);
    const entry = this.view()[i];
    return { path: entry ? entry.path : null, offset: this.list.scrollTop - i * this.rowPitch };
  }

  restoreAnchor(anchor) {
    if (!anchor || !anchor.path) return;
    const i = this.indexByPath.get(anchor.path);
    if (i === undefined) return;             // anchored row is gone; leave scroll alone
    const target = Math.max(0, Math.floor(i / this.cols) * this.rowPitch + anchor.offset);
    if (Math.abs(target - this.list.scrollTop) > 1) this.list.scrollTop = target;
  }

  bindScroll() {
    const onScroll = () => {
      if (this.scrollRaf) return;
      this.scrollRaf = requestAnimationFrame(() => {
        this.scrollRaf = 0;
        this.layout();
      });
    };
    this.list.addEventListener('scroll', onScroll, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => {
        this.rowMeasured = false;
        this.measure();
        this.layout();
      });
      this.ro.observe(this.list);
    }
  }

  /* ========================================================= rendering */

  /** Switch the address bar into its editable form. */
  editAddress() {
    if (!this.addrInput.hidden) return;
    this.crumbs.hidden = true;
    this.addrInput.hidden = false;
    this.addrInput.value = `${this.loc.mount}:${this.loc.path}`;
    this.addrInput.focus();
    // Leave the drive slug selected-ish: most edits are about the folder.
    const at = this.addrInput.value.indexOf(':') + 1;
    try { this.addrInput.setSelectionRange(at, this.addrInput.value.length); } catch (_) { /* older browsers */ }
  }

  /** Leave edit mode without navigating. */
  endAddress() {
    if (this.addrInput.hidden) return;
    this.addrInput.hidden = true;
    this.crumbs.hidden = false;
  }

  /** Navigate to whatever is typed in the address bar. */
  commitAddress() {
    const raw = this.addrInput.value.trim();
    this.endAddress();
    if (!raw) return;
    const i = raw.indexOf(':');
    let mount = this.loc.mount;
    let path = raw;
    if (i > 0) {
      const maybeMount = raw.slice(0, i);
      // Only treat the prefix as a drive when it really is one; otherwise the
      // colon belongs to a Windows-style path and we keep the current drive.
      if ((state.mounts || []).some((m) => m.name === maybeMount)) {
        mount = maybeMount;
        path = raw.slice(i + 1);
      }
    }
    if (!path.startsWith('/')) path = '/' + path;
    this.navigate(mount, path);
  }

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

    // Make the permission visible where the user is looking, not buried in a
    // dialog: a read-only drive says so, and it says WHO decided that.
    const caps = this.mountInfo?.capabilities;
    if (caps && caps.write === false) {
      const badge = el('span', {
        class: 'ro-badge',
        title: 'You have read-only access to this drive',
        text: 'Read-only',
      });
      this.crumbs.appendChild(badge);
    }
  }

  /** Shimmer placeholders for a cold load. Transient, so not virtualized. */
  renderSkeleton() {
    this.renderCrumbs();
    this.list.className = 'filelist ' + state.viewMode;
    this.showEmpty(false);
    for (const node of this.rendered.values()) this.releaseNode(node);
    this.rendered.clear();
    this.spacer.style.height = '0px';
    if (this.skeletonNode) this.skeletonNode.remove();

    const wrap = el('div', { class: 'skeleton-wrap' });
    for (let i = 0; i < SKELETON_ROWS; i++) {
      wrap.appendChild(isTileMode()
        ? el('div', { class: 'fitem skeleton' }, el('div', { class: 'sk-ico' }), el('div', { class: 'sk-line' }))
        : el('div', { class: 'frow skeleton' }, el('div', { class: 'sk-ico' }), el('div', { class: 'sk-line' })));
    }
    this.skeletonNode = wrap;
    this.list.appendChild(wrap);
  }

  render(opts = {}) {
    this.renderCrumbs();
    this.list.className = 'filelist ' + state.viewMode;
    if (this.skeletonNode) { this.skeletonNode.remove(); this.skeletonNode = null; }

    this.measure();
    this.layout();

    if (opts.anchor) { this.restoreAnchor(opts.anchor); this.layout(); }
    this.paintSelection();
  }

  showEmpty(on, filtered = false) {
    if (this.emptyNode) this.emptyNode.hidden = true;
    if (this.emptyFilterNode) this.emptyFilterNode.hidden = true;
    if (!on) return;
    if (filtered) {
      if (!this.emptyFilterNode) {
        this.emptyFilterNode = this.filteredEmptyState();
        this.list.appendChild(this.emptyFilterNode);
      }
      this.emptyFilterNode.hidden = false;
    } else {
      if (!this.emptyNode) { this.emptyNode = this.emptyState(); this.list.appendChild(this.emptyNode); }
      this.emptyNode.hidden = false;
    }
  }

  /** Shown when a filter matches nothing — offers the way out. */
  filteredEmptyState() {
    const box = el('div', { class: 'empty-state' },
      icon('search', 'empty-ico'),
      el('div', { class: 'empty-title', text: 'No files of this type' }),
      el('div', { class: 'empty-sub muted', text: 'Everything in this folder is hidden by the current filter.' }),
    );
    const clear = el('button', { class: 'btn primary', text: 'Clear filter' });
    clear.addEventListener('click', () => this.filterBar.set({ category: 'all', ext: '' }));
    box.appendChild(el('div', { class: 'empty-actions' }, clear));
    return box;
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

  /* ================================================== rubber-band select */

  /**
   * Drag-to-select, the way a desktop file manager does it.
   *
   * Press on empty space and drag: a rectangle follows the pointer and every
   * row/tile it touches becomes selected, live, as it grows. Ctrl (or Shift)
   * adds to the selection instead of replacing it; Esc puts it back. Dragging
   * past the top/bottom edge auto-scrolls, so a marquee can reach beyond the
   * visible window.
   *
   * Two details that matter:
   *   - it never starts on a row/tile, so the native drag-and-drop of files
   *     (and plain clicking) are untouched;
   *   - intersections are computed from the index, not by reading the DOM,
   *     because only the windowed rows exist — a scrolled-out row still gets
   *     selected correctly, and no layout is forced on every pointermove.
   */
  bindMarquee() {
    this.onMqMove = (e) => this.marqueeMove(e);
    this.onMqUp = (e) => this.marqueeUp(e);
    this.onMqKey = (e) => {
      if (e.key !== 'Escape' || !this.mq) return;
      // Capture-phase, so this runs before the pane's own Escape handler. Stop
      // the event here: "Escape while dragging" means cancel the marquee, and
      // letting it through would then clearSelection() the restored selection.
      e.preventDefault();
      e.stopPropagation();
      this.marqueeCancel();
    };
    this.list.addEventListener('pointerdown', (e) => this.marqueeDown(e));
  }

  marqueeDown(e) {
    if (this.destroyed || this.mq) return;
    if (e.button !== 0) return;                                  // left button only
    if (e.pointerType && e.pointerType !== 'mouse') return;      // touch has its own path
    // Never from a row/tile, the selection bar or the empty state.
    if (e.target.closest('.frow, .fitem, .selbar, .empty-state')) return;

    // A press on the scrollbar must scroll, not start a selection. Clicks on the
    // scrollbar are reported against the scrolling element with coordinates
    // beyond its client box.
    const r = this.list.getBoundingClientRect();
    if (e.clientX - r.left >= this.list.clientWidth) return;
    if (e.clientY - r.top >= this.list.clientHeight) return;

    if (!this.view().length) return;                             // nothing to select

    this.mq = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      // Ctrl/Shift keep what was already selected; a plain drag starts fresh.
      additive: !!(e.ctrlKey || e.metaKey || e.shiftKey),
      base: new Set(this.selected),
      active: false,
    };
    // Bound to window so the drag survives the pointer leaving the pane.
    window.addEventListener('pointermove', this.onMqMove, { passive: false });
    window.addEventListener('pointerup', this.onMqUp);
    window.addEventListener('pointercancel', this.onMqUp);
    window.addEventListener('keydown', this.onMqKey, true);
  }

  marqueeMove(e) {
    const m = this.mq;
    if (!m || e.pointerId !== m.pointerId) return;
    m.lastX = e.clientX;
    m.lastY = e.clientY;

    if (!m.active) {
      // A few pixels of slack so a plain click on empty space still just clears
      // the selection instead of flashing a marquee.
      if (Math.abs(e.clientX - m.startX) < MARQUEE_SLOP && Math.abs(e.clientY - m.startY) < MARQUEE_SLOP) return;
      m.active = true;
      this.marquee.hidden = false;
      this.list.classList.add('marquee-active');
      this.selected = m.additive ? new Set(m.base) : new Set();
      this.autoScrollDuringMarquee();
    }
    // Stop the browser's own text/image selection taking over.
    if (e.cancelable) e.preventDefault();
    this.paintMarquee();
  }

  marqueeUp(e) {
    const m = this.mq;
    if (!m) return;
    if (e && e.pointerId !== undefined && e.pointerId !== m.pointerId) return;
    const dragged = m.active;
    this.endMarquee();
    if (dragged) {
      this.suppressNextClick();
      // The drag painted only classes (cheap); publish the result once, here.
      this.renderSelbar();
      if (this.onSelection) this.onSelection(this);
    }
  }

  /** Esc during a drag: restore the selection as it was before the press. */
  marqueeCancel() {
    const m = this.mq;
    if (!m) return;
    const dragged = m.active;
    this.selected = new Set(m.base);
    this.endMarquee();
    this.paintSelection();
    // The mouseup that follows still produces a click on empty space, and that
    // would clear the very selection Esc just restored — so swallow it too.
    if (dragged) this.suppressNextClick();
  }

  /**
   * Ignore the click the browser fires after a drag's mouseup. It lands on empty
   * space, so without this it would immediately clear what the drag selected.
   *
   * The flag is consumed by the next click rather than expiring on a 0ms timer:
   * after Esc the mouseup (and therefore the click) can arrive much later than
   * the keydown, so a short timer would fire first and let the click through.
   * The timeout is only a safety net, for a drag that ends without any click.
   */
  suppressNextClick() {
    this.mqSuppressClick = true;
    clearTimeout(this.mqSuppressTimer);
    this.mqSuppressTimer = setTimeout(() => { this.mqSuppressClick = false; }, 400);
  }

  /** @return {boolean} true when this click was the tail of a drag. */
  consumeSuppressedClick() {
    if (!this.mqSuppressClick) return false;
    this.mqSuppressClick = false;
    clearTimeout(this.mqSuppressTimer);
    return true;
  }

  endMarquee() {
    window.removeEventListener('pointermove', this.onMqMove);
    window.removeEventListener('pointerup', this.onMqUp);
    window.removeEventListener('pointercancel', this.onMqUp);
    window.removeEventListener('keydown', this.onMqKey, true);
    if (this.mqRaf) { cancelAnimationFrame(this.mqRaf); this.mqRaf = 0; }
    this.marquee.hidden = true;
    this.marquee.style.width = '0px';
    this.marquee.style.height = '0px';
    this.list.classList.remove('marquee-active');
    this.mq = null;
  }

  /** Position the overlay and select everything it covers. */
  paintMarquee() {
    const m = this.mq;
    if (!m || !m.active) return;
    // The spacer's box already reflects the current scroll offset, so this one
    // read keeps the rectangle glued to the content while auto-scrolling.
    const r = this.spacer.getBoundingClientRect();
    const x0 = m.startX - r.left;
    const y0 = m.startY - r.top;
    const x1 = m.lastX - r.left;
    const y1 = m.lastY - r.top;

    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);

    this.marquee.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
    this.marquee.style.width = Math.round(w) + 'px';
    this.marquee.style.height = Math.round(h) + 'px';

    this.selectInRect(left, top, w, h);
  }

  /**
   * Geometry of the row/tile at index `i`, in the spacer's coordinate space.
   * Derived from the same numbers fill() positions with, so it is correct for
   * rows that are not currently rendered.
   */
  rectForIndex(i, tile) {
    const y = Math.floor(i / this.cols) * this.rowPitch;
    if (tile) {
      return { x: (i % this.cols) * (this.colW + this.gapY), y, w: this.colW, h: this.rowH };
    }
    return { x: 0, y, w: this.colW, h: this.rowH };
  }

  selectInRect(left, top, w, h) {
    const right = left + w;
    const bottom = top + h;
    const v = this.view();
    const tile = isTileMode();

    const next = new Set();
    if (this.mq.additive) for (const p of this.mq.base) next.add(p);

    for (let i = 0; i < v.length; i++) {
      const g = this.rectForIndex(i, tile);
      if (g.x < right && g.x + g.w > left && g.y < bottom && g.y + g.h > top) next.add(v[i].path);
    }

    // Repainting on every move is fine (it is only a class toggle per visible
    // node), but rebuilding the selection bar is not — hence `live`.
    if (next.size === this.selected.size) {
      let same = true;
      for (const p of next) { if (!this.selected.has(p)) { same = false; break; } }
      if (same) return;
    }
    this.selected = next;
    this.paintSelection({ live: true });
  }

  /** Scroll while the pointer is held near the top/bottom edge. */
  autoScrollDuringMarquee() {
    if (this.mqRaf) return;
    const step = () => {
      this.mqRaf = 0;
      const m = this.mq;
      if (!m || !m.active || this.destroyed) return;
      const r = this.list.getBoundingClientRect();
      const over = r.top + MARQUEE_EDGE - m.lastY;          // >0 near/above the top
      const under = m.lastY - (r.bottom - MARQUEE_EDGE);    // >0 near/below the bottom
      let dy = 0;
      if (over > 0) dy = -(Math.min(MARQUEE_EDGE, over) / MARQUEE_EDGE) * MARQUEE_MAX_SPEED;
      else if (under > 0) dy = (Math.min(MARQUEE_EDGE, under) / MARQUEE_EDGE) * MARQUEE_MAX_SPEED;

      if (dy) {
        const before = this.list.scrollTop;
        this.list.scrollTop = before + dy;
        // Only repaint if the scroll actually moved (it stops at the ends).
        if (this.list.scrollTop !== before) this.paintMarquee();
      }
      this.mqRaf = requestAnimationFrame(step);
    };
    this.mqRaf = requestAnimationFrame(step);
  }

  /* ========================================================= selection */

  selectOnly(entry) { this.selected.clear(); this.selected.add(entry.path); this.paintSelection(); }
  toggleSelect(entry) { this.selected.has(entry.path) ? this.selected.delete(entry.path) : this.selected.add(entry.path); this.paintSelection(); }
  rangeSelect(entry) {
    const names = this.view().map(x => x.path);
    const a = names.indexOf(this.lastClicked), b = names.indexOf(entry.path);
    if (a < 0 || b < 0) return;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.selected.add(names[i]);
    this.paintSelection();
  }
  selectAll() { for (const e of this.entries) this.selected.add(e.path); this.paintSelection(); }
  clearSelection() { this.selected.clear(); this.paintSelection(); }

  applySelClass(node) {
    const on = this.selected.has(node.dataset.path);
    node.classList.toggle('selected', on);
    node.setAttribute('aria-selected', on ? 'true' : 'false');
  }

  /**
   * Paint favourite state on a row: the badge next to the name and the toggle
   * button's icon/label. Driven by the shared favourite set, so it stays correct
   * across recycles and after a reload.
   */
  applyFavMark(node, entry) {
    const on = isFavorite(this.loc.mount, entry.path);
    // A class rather than [hidden] — `svg.icon` sets display:inline-block, which
    // would otherwise beat the UA [hidden] rule.
    if (node._refs.favMark) node._refs.favMark.classList.toggle('on', on);
    const fav = node._refs.actions && node._refs.actions._fav;
    if (!fav) return;
    fav.classList.toggle('active', on);
    const label = on ? 'Remove from favourites' : 'Add to favourites';
    if (fav.title !== label) {
      fav.title = label;
      fav.setAttribute('aria-label', label);
      setIcon(fav.firstChild, on ? 'star' : 'star-outline');
    }
  }

  /**
   * Repaint only the nodes that exist. Off-window rows are "painted" by fill()
   * the moment they scroll into view, so the Set stays the source of truth.
   *
   * @param {{live?:boolean}} [opts] `live` skips the selection bar and the
   *        shell notification — used by the rubber band, which repaints on every
   *        pointermove and publishes the result once when the drag ends.
   */
  paintSelection(opts = {}) {
    for (const node of this.rendered.values()) this.applySelClass(node);
    if (opts.live) return;
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

  /* =========================================================== actions */

  open(entry) {
    // Let the shell note this in Recent before we navigate away.
    if (this.onOpenEntry) this.onOpenEntry(this, entry);
    if (entry.type === 'dir') this.navigate(this.loc.mount, entry.path);
    else preview(entry, this.loc.mount);
  }

  goUp() {
    if (this.loc.path === '/') return;
    const parent = this.loc.path.replace(/\/[^/]*$/, '') || '/';
    this.navigate(this.loc.mount, parent);
  }

  /* ======================================================= node events */

  /**
   * Bound once per node. Every handler resolves its entry from the DOM at
   * event time — that is what makes node recycling safe.
   */
  bindNodeEvents(node) {
    node.addEventListener('click', (e) => {
      const entry = this.entryOf(node);
      if (!entry) return;
      if (e.ctrlKey || e.metaKey) this.toggleSelect(entry);
      else if (e.shiftKey && this.lastClicked) this.rangeSelect(entry);
      else this.selectOnly(entry);
      this.lastClicked = entry.path;
      const idx = this.indexByPath.get(entry.path);
      this.cursor = idx === undefined ? -1 : idx;
    });

    node.addEventListener('dblclick', () => {
      const entry = this.entryOf(node);
      if (entry) this.open(entry);
    });

    node.addEventListener('contextmenu', (e) => {
      const entry = this.entryOf(node);
      if (!entry) return;
      e.preventDefault();
      e.stopPropagation();
      if (!this.selected.has(entry.path)) this.selectOnly(entry);
      if (this.onContextMenu) this.onContextMenu(e, entry, this);
    });

    node.addEventListener('dragstart', (e) => {
      const entry = this.entryOf(node);
      if (!entry) { e.preventDefault(); return; }
      // Drag the whole selection when the grabbed item is part of it.
      if (!this.selected.has(entry.path)) this.selectOnly(entry);
      const paths = [...this.selected];
      e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ mount: this.loc.mount, paths }));
      e.dataTransfer.setData('text/plain', paths.join('\n'));
      e.dataTransfer.effectAllowed = 'move';
      node.classList.add('dragging');
      this.root.classList.add('is-dragging');
      this.dragging = true;
    });

    node.addEventListener('dragend', () => {
      node.classList.remove('dragging');
      this.root.classList.remove('is-dragging');
      this.dragging = false;
      if (this.dropTargetNode) { this.dropTargetNode.classList.remove('drop-target'); this.dropTargetNode = null; }
      if (this.pendingRevalidate) { this.pendingRevalidate = false; this.revalidate(); }
    });

    // Folders are drop targets for internal moves. The type is checked per
    // event, so a recycled node can stop or start being a target.
    node.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
      const entry = this.entryOf(node);
      if (!entry || entry.type !== 'dir' || this.selected.has(entry.path)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      if (this.dropTargetNode && this.dropTargetNode !== node) this.dropTargetNode.classList.remove('drop-target');
      node.classList.add('drop-target');
      this.dropTargetNode = node;
    });

    node.addEventListener('dragleave', () => {
      if (this.dropTargetNode === node) { node.classList.remove('drop-target'); this.dropTargetNode = null; }
    });

    node.addEventListener('drop', (e) => {
      if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
      const entry = this.entryOf(node);
      if (!entry || entry.type !== 'dir') return;
      e.preventDefault();
      e.stopPropagation();
      node.classList.remove('drop-target');
      this.dropTargetNode = null;
      const payload = this.readDrag(e);
      if (payload && this.onMove) this.onMove(this, payload.paths, this.loc.mount, entry.path, payload.mount);
    });
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

  /* ====================================================== drag & drop */

  bindDnd() {
    let depth = 0;
    this.list.addEventListener('dragover', (e) => {
      // External files -> upload; internal payload -> move into this folder.
      e.preventDefault();
      if (e.dataTransfer.types.includes(DRAG_MIME)) e.dataTransfer.dropEffect = 'move';
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
      if (files.length) runUploadsWithUI(files, this.loc.mount, this.loc.path, 'rename', this);
    });
  }

  /* ============================================================= touch */

  bindTouch() {
    // Long-press opens the same context menu the mouse gets from right-click.
    this.touchOff = onLongPress(this.list, (x, y) => {
      const node = document.elementFromPoint(x, y)?.closest('[data-path]');
      if (!node) return;
      const entry = this.entryOf(node);
      if (!entry) return;
      if (!this.selected.has(entry.path)) this.selectOnly(entry);
      if (this.onContextMenu) this.onContextMenu({ clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} }, entry, this);
    });
  }

  /* ========================================================== keyboard */

  bindKeys() {
    this.list.addEventListener('keydown', (e) => {
      const items = this.view();
      const mod = e.ctrlKey || e.metaKey;

      if (e.key === 'Backspace') { e.preventDefault(); this.goUp(); return; }
      if (e.key === 'Delete' && this.onDelete) { e.preventDefault(); this.onDelete(this, this.selectedEntries()); return; }
      if (e.key === 'F2' && this.onRename) { e.preventDefault(); const s = this.selectedEntries()[0]; if (s) this.onRename(this, s); return; }
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); this.selectAll(); return; }
      if (e.key === 'Enter') { const s = this.selectedEntries()[0]; if (s) this.open(s); return; }
      if (e.key === 'Escape') { this.clearSelection(); return; }

      // Arrow / Home / End / Page navigation. Pure index math — no DOM lookups,
      // which is what lets it work when the target row isn't rendered yet.
      const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1
        : e.key === 'PageDown' ? 10 : e.key === 'PageUp' ? -10
        : e.key === 'Home' ? 'first' : e.key === 'End' ? 'last' : 0;
      if (step !== 0 && items.length) {
        e.preventDefault();
        const idx = step === 'first' ? 0 : step === 'last' ? items.length - 1
          : Math.max(0, Math.min(items.length - 1, (this.cursor < 0 ? -1 : this.cursor) + step));
        this.cursor = idx;
        const entry = items[idx];
        if (e.shiftKey && this.lastClicked) this.rangeSelect(entry);
        else { this.selectOnly(entry); this.lastClicked = entry.path; }
        this.scrollToIndex(idx);
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
          const idx = this.indexByPath.get(hit.path);
          this.cursor = idx === undefined ? -1 : idx;
          this.scrollToIndex(this.cursor);
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
    // The two modes use different node shapes, so the pool must be rebuilt.
    for (const node of this.rendered.values()) this.releaseNode(node);
    this.rendered.clear();
    this.pool.length = 0;
    this.rowMeasured = false;
    this.rowH = 0;
    this.render({});
  }

  /**
   * Tear the pane down completely. main.js rebuilds panes whenever the split or
   * details layout changes, so without this every rebuild leaked the long-press
   * listeners and left orphaned in-flight requests writing into dead panes.
   */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;

    // Bumping reqSeq makes any response already in flight a no-op when it
    // resolves; aborting releases the socket sooner.
    this.reqSeq++;
    this.searchSeq++;
    if (this.listAbort) { try { this.listAbort.abort(); } catch (_) { /* settled */ } this.listAbort = null; }

    if (this.touchOff) { this.touchOff(); this.touchOff = null; }
    if (this.mq) this.endMarquee();          // also unbinds the window listeners
    if (this.mqSuppressTimer) { clearTimeout(this.mqSuppressTimer); this.mqSuppressTimer = 0; }
    if (this.ro) { this.ro.disconnect(); this.ro = null; }
    if (this.thumbs) { this.thumbs.disconnect(); }
    if (this.scrollRaf) { cancelAnimationFrame(this.scrollRaf); this.scrollRaf = 0; }
    if (this.typeTimer) { clearTimeout(this.typeTimer); this.typeTimer = null; }
    clearTimeout(this._revalidateTimer);

    state.panes.delete(this);

    // Drop every callback so nothing can re-enter a dead pane.
    this.onNavigate = this.onSelection = this.onContextMenu = null;
    this.onBackgroundMenu = this.onDelete = this.onRename = this.onMove = null;
    this.onDownload = this.onCopy = this.onCut = null;
    this.onNewFolder = this.onNewFile = this.onUpload = null;

    this.rendered.clear();
    this.pool.length = 0;
    this.entries = [];
    this.byPath = new Map();
    this.selected.clear();
  }
}

/** Swap the sprite symbol behind an existing icon element. */
function setIcon(svg, name) {
  const use = svg && svg.firstChild;
  const href = '#i-' + name;
  if (use && use.getAttribute('href') !== href) use.setAttribute('href', href);
}
