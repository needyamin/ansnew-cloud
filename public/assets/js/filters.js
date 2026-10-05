'use strict';
/*
 * File-type filtering — the single source of truth for "what kind of file is
 * this".
 *
 * icons.js used to carry its own copy of these extension lists. Two lists mean
 * two places to update and a chip that silently disagrees with the row icon, so
 * the classification now lives here and icons.js imports it.
 *
 * Classification prefers the extension (already returned by the list API) and
 * falls back to the MIME type, which is what adapters without a reliable
 * extension give us.
 */
import { el } from './util.js';
import { state, setFilterCategory, rememberExt, recallExt } from './state.js';

/* ------------------------------------------------------------- categories */

export const CATEGORIES = [
  { id: 'all', label: 'All', icon: 'file' },
  { id: 'folders', label: 'Folders', icon: 'folder' },
  { id: 'images', label: 'Images', icon: 'image' },
  { id: 'video', label: 'Video', icon: 'video' },
  { id: 'audio', label: 'Audio', icon: 'audio' },
  { id: 'documents', label: 'Documents', icon: 'pdf' },
  { id: 'archives', label: 'Archives', icon: 'archive' },
  { id: 'code', label: 'Code', icon: 'code' },
  { id: 'other', label: 'Other', icon: 'file' },
];

const EXTS = {
  images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'heic', 'heif', 'tif', 'tiff'],
  video: ['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'mpg', 'mpeg', 'wmv', 'flv'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'wma'],
  documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'epub', 'csv', 'tsv'],
  archives: ['zip', 'gz', 'tar', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst', 'iso'],
  code: [
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'css', 'scss', 'html', 'htm', 'xml', 'yml', 'yaml',
    'sql', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'java', 'rb', 'php', 'py', 'sh', 'bash', 'md', 'txt',
    'log', 'conf', 'toml', 'ini', 'env',
  ],
};

/** extension -> category, built once from the table above. */
const EXT_MAP = (() => {
  const m = new Map();
  for (const [cat, list] of Object.entries(EXTS)) {
    for (const e of list) m.set(e, cat);
  }
  return m;
})();

/**
 * Classify one list entry.
 * @returns {string} a CATEGORIES id
 */
export function categoryOf(entry) {
  if (!entry) return 'other';
  if (entry.type === 'dir') return 'folders';
  const e = String(entry.extension || '').toLowerCase();
  const hit = EXT_MAP.get(e);
  if (hit) return hit;

  const mime = String(entry.mime || '').toLowerCase();
  if (mime.startsWith('image/')) return 'images';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf' || mime.includes('word') || mime.includes('sheet')
      || mime.includes('presentation') || mime.includes('opendocument')) return 'documents';
  if (mime.includes('zip') || mime.includes('compressed') || mime.includes('tar')
      || mime.includes('gzip') || mime === 'application/x-7z-compressed') return 'archives';
  if (mime.startsWith('text/') || mime.includes('json') || mime.includes('xml')) return 'code';
  return 'other';
}

/** Does an entry pass the current filter? */
export function matches(entry, filter) {
  if (!filter) return true;
  if (filter.ext) {
    return String(entry.extension || '').toLowerCase() === filter.ext;
  }
  if (!filter.category || filter.category === 'all') return true;
  return categoryOf(entry) === filter.category;
}

/**
 * Count entries per category, for the chip badges.
 * @returns {Map<string, number>}
 */
export function countByCategory(entries) {
  const counts = new Map([['all', entries.length]]);
  for (const e of entries) {
    const c = categoryOf(e);
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  return counts;
}

/**
 * Extensions present in the folder, most common first.
 * @returns {Array<{ext:string, count:number, label:string}>}
 */
export function extensionFacets(entries) {
  const counts = new Map();
  for (const e of entries) {
    if (e.type === 'dir') continue;
    const x = String(e.extension || '').toLowerCase();
    if (!x) continue;
    counts.set(x, (counts.get(x) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([ext, count]) => ({ ext, count, label: `.${ext} (${count})` }));
}

/* --------------------------------------------------------------- UI bar */

/**
 * The filter bar: category chips + a "specific type" dropdown built from what
 * is actually in the folder.
 *
 * Filtering is entirely client-side over the listing the pane already holds,
 * which is why changing a chip is instant and costs no request.
 */
export class FilterBar {
  /**
   * @param {object} opts
   * @param {Function} opts.onChange (filter) => void
   */
  constructor({ onChange } = {}) {
    this.onChange = onChange || (() => {});
    this.chips = new Map();

    this.chipRow = el('div', { class: 'filter-chips', role: 'tablist', 'aria-label': 'Filter by file type' });
    this.extSelect = el('select', { class: 'ext-select', 'aria-label': 'Filter by extension' },
      el('option', { value: '', text: 'Any type' }));
    this.extSelect.addEventListener('change', () => {
      this.filter.ext = this.extSelect.value;
      rememberExt(this.mount, this.path, this.filter.ext);
      this.onChange(this.filter);
    });

    this.clearBtn = el('button', {
      class: 'btn sm', hidden: true, title: 'Clear the file-type filter',
      onclick: () => this.set({ category: 'all', ext: '' }),
    }, 'Clear filter');

    this.root = el('div', { class: 'filterbar' }, this.chipRow, this.extSelect, this.clearBtn);
    this.filter = { category: state.filter.category || 'all', ext: '' };
    this.mount = '';
    this.path = '/';
    this.buildChips();
  }

  buildChips() {
    for (const c of CATEGORIES) {
      const badge = el('span', { class: 'chip-count' });
      const chip = el('button', {
        class: 'chip',
        role: 'tab',
        dataset: { cat: c.id },
        title: 'Show only ' + c.label.toLowerCase(),
        onclick: () => this.setCategory(c.id),
      }, el('span', { class: 'chip-label', text: c.label }), badge);
      this.chips.set(c.id, { chip, badge });
      this.chipRow.appendChild(chip);
    }
  }

  setCategory(cat) {
    this.set({ category: cat, ext: '' });
  }

  /** Replace the filter wholesale and notify. */
  set(filter) {
    this.filter = { category: filter.category || 'all', ext: filter.ext || '' };
    setFilterCategory(this.filter.category);
    rememberExt(this.mount, this.path, this.filter.ext);
    this.sync();
    this.onChange(this.filter);
  }

  /** Remember which folder we are showing, so `recallExt` can be folder-scoped. */
  setLocation(mount, path) {
    this.mount = mount;
    this.path = path;
  }

  /**
   * Restore the extension remembered for this folder.
   *
   * Must run AFTER update(): the option list has to exist before we can tell
   * whether the remembered extension still occurs in this folder.
   */
  applyRemembered() {
    const remembered = recallExt(this.mount, this.path);
    if (remembered && this.hasExt(remembered)) {
      this.filter.ext = remembered;
      this.sync();
      return true;
    }
    return false;
  }

  hasExt(ext) {
    return [...this.extSelect.options].some((o) => o.value === ext);
  }

  /**
   * Refresh counts + the extension list for a new set of entries.
   * @param {Array} entries full, unfiltered listing
   */
  update(entries) {
    const counts = countByCategory(entries);

    for (const c of CATEGORIES) {
      const { chip, badge } = this.chips.get(c.id);
      const n = counts.get(c.id) || 0;
      badge.textContent = n ? String(n) : '';
      // A category with nothing in it is hidden rather than shown as "0":
      // nine chips where six are dead is noise, and the set changes per folder.
      chip.hidden = c.id !== 'all' && n === 0;
      chip.classList.toggle('active', this.filter.category === c.id);
      chip.setAttribute('aria-selected', this.filter.category === c.id ? 'true' : 'false');
    }

    const facets = extensionFacets(entries);
    const prev = this.filter.ext;
    clear(this.extSelect);
    this.extSelect.appendChild(el('option', { value: '', text: facets.length ? 'Any type' : 'No files' }));
    for (const f of facets) {
      this.extSelect.appendChild(el('option', { value: f.ext, text: f.label }));
    }
    // Keep the remembered choice if that extension still exists here.
    this.filter.ext = this.hasExt(prev) ? prev : '';

    this.sync();
  }

  /** Push the current filter into the widgets (used after set()/update()). */
  sync() {
    this.extSelect.value = this.filter.ext || '';
    const active = this.filter.category !== 'all' || !!this.filter.ext;
    this.clearBtn.hidden = !active;
    for (const [id, { chip }] of this.chips) {
      const on = this.filter.category === id && !this.filter.ext;
      chip.classList.toggle('active', on);
      chip.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    this.root.classList.toggle('filtering', active);
  }

  get isActive() {
    return this.filter.category !== 'all' || !!this.filter.ext;
  }
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
