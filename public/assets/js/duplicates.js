'use strict';
/*
 * Duplicate finder — "same bytes, probably the same file".
 *
 * Grouping is deliberately two-stage and cheap:
 *   1. group by exact size (a different size is a different file, always)
 *   2. within a size group, group by a *normalised* basename, so "report.pdf",
 *      "report (1).pdf" and "report - copy.pdf" land together
 *
 * No hashing, no recursion: one folder's listing is already in memory, and
 * hashing every file would mean re-downloading megabytes over the API. A size
 * collision with a matching normalised name is a strong enough signal to act
 * on, and the user still confirms every deletion.
 */
import { el, clear, fmtSize, fmtDate } from './util.js';
import { icon } from './icons.js';
import { dialog, toastWarn, toastErr } from './ui.js';

/** Strip the suffixes every OS and browser appends when copying a file. */
export function normaliseBase(name) {
  let s = String(name || '');
  // Drop the extension first — the suffix sits between base and extension.
  const dot = s.lastIndexOf('.');
  const base = dot > 0 ? s.slice(0, dot) : s;
  return base
    .replace(/[\s_-]*\(\d+\)$/g, '')     // " (1)", "(2)"
    .replace(/[\s_-]*copy(?:\s*\(\d+\))?$/gi, '') // " copy", " - copy (2)"
    .replace(/[\s_-]*\d+$/g, '')         // trailing " 2" / "-1"
    .trim()
    .toLowerCase();
}

/**
 * @param {Array} entries listing entries for one folder
 * @returns {Array<{key:string, size:number, items:Array}>} groups with >1 member
 */
export function findDuplicateGroups(entries) {
  const files = (entries || []).filter((e) => e.type !== 'dir' && (e.size || 0) > 0);
  const bySize = new Map();
  for (const f of files) {
    const k = String(f.size);
    if (!bySize.has(k)) bySize.set(k, []);
    bySize.get(k).push(f);
  }

  const groups = [];
  for (const [, bucket] of bySize) {
    if (bucket.length < 2) continue;
    const byName = new Map();
    for (const f of bucket) {
      const k = normaliseBase(f.name);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(f);
    }
    for (const [key, items] of byName) {
      if (items.length < 2) continue;
      // Newest first, so the group reads as "keep this one, maybe lose these".
      items.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      groups.push({ key, size: items[0].size, items });
    }
  }
  // Biggest groups first: they are where the space actually is.
  groups.sort((a, b) => (b.size * (b.items.length - 1)) - (a.size * (a.items.length - 1)));
  return groups;
}

/**
 * Open the duplicates dialog.
 *
 * @param {object} opts
 * @param {Array}  opts.entries    current folder listing
 * @param {string} opts.folderLabel shown in the header
 * @param {Function} opts.onSelect  (paths[]) => void — select in the pane
 * @param {Function} opts.onDelete  (entries[]) => void — delete (already gated)
 */
export function duplicatesDialog({ entries, folderLabel = 'this folder', onSelect, onDelete }) {
  const groups = findDuplicateGroups(entries);

  if (!groups.length) {
    toastWarn('No duplicate files found in ' + folderLabel);
    return null;
  }

  const wasted = groups.reduce((sum, g) => sum + g.size * (g.items.length - 1), 0);
  const total = groups.reduce((sum, g) => sum + g.items.length, 0);

  // The newest copy of each group starts unchecked: deleting the file you just
  // saved is never what someone means by "remove duplicates".
  const chosen = new Set();
  const list = el('div', { class: 'dup-list' });

  const counter = el('span', { class: 'muted', style: 'font-size:12.5px' });

  // Assigned once dialog() has built the footer.
  let selBtn = null;
  let delBtn = null;

  const sync = () => {
    counter.textContent = `${chosen.size} file(s) selected`;
    if (selBtn) selBtn.disabled = chosen.size === 0;
    if (delBtn) {
      delBtn.disabled = chosen.size === 0;
      delBtn.textContent = chosen.size ? `Delete ${chosen.size} selected` : 'Delete selected';
    }
  };

  for (const g of groups) {
    const box = el('div', { class: 'dup-group' },
      el('div', { class: 'dup-head' },
        icon('copy', 'ico'),
        el('strong', { text: g.items[0].name }),
        el('span', { class: 'muted', text: `${g.items.length} copies · ${fmtSize(g.size)} each` }),
      ),
    );
    g.items.forEach((item, idx) => {
      const cb = el('input', { type: 'checkbox' });
      cb.addEventListener('change', () => {
        if (cb.checked) chosen.add(item.path); else chosen.delete(item.path);
        sync();
      });
      box.appendChild(el('label', { class: 'dup-item' },
        cb,
        el('span', { class: 'dup-name', text: item.name }),
        idx === 0 ? el('span', { class: 'dup-keep muted', text: 'newest' }) : null,
        el('span', { class: 'dup-meta muted', text: fmtDate(item.mtime) }),
      ));
    });
    list.appendChild(box);
  }

  const { dlg, close } = dialog({
    title: 'Duplicate files',
    body: [
      el('p', { class: 'muted', text:
        `${groups.length} group(s), ${total} files, about ${fmtSize(wasted)} recoverable in ${folderLabel}. Uncheck anything you want to keep.` }),
      list,
      counter,
    ],
    buttons: [
      { label: 'Close' },
      {
        label: 'Select in folder',
        onClick: () => {
          close();
          if (onSelect) onSelect([...chosen]);
        },
      },
      {
        label: 'Delete selected', kind: 'danger',
        onClick: () => {
          close();
          const picked = [];
          for (const g of groups) {
            for (const it of g.items) if (chosen.has(it.path)) picked.push(it);
          }
          if (!picked.length) return;
          try {
            if (onDelete) onDelete(picked);
          } catch (e) { toastErr(e.message); }
        },
      },
    ],
  });

  // The footer buttons already carry the handlers above; grab them so sync()
  // can enable/disable them as the selection changes.
  const btns = dlg.querySelectorAll('footer .btn');
  selBtn = btns[1] || null;
  delBtn = btns[2] || null;

  sync();
  return { close };
}
