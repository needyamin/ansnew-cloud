'use strict';
/*
 * Favourites view — the full page behind the sidebar's "Favorites" section.
 *
 * The sidebar only has room for a handful of pins and no way to search or
 * bulk-manage them, so everything pinned needs a real home. This is deliberately
 * a table rather than a second FilesPane: these entries live in the database,
 * not in a directory, so a file pane's windowing, sorting and drag-and-drop
 * have nothing to operate on.
 */
import { el, clear } from './util.js';
import { api, invalidate } from './api.js';
import { state, setFavorites } from './state.js';
import { icon } from './icons.js';
import { toastOk, toastErr, confirmDialog } from './ui.js';
import { withSensitive } from './sensitive.js';
import { clearAllFavorites } from './fsops.js';

function mountLabel(mount) {
  const m = state.mounts.find((x) => x.name === mount);
  return m ? m.label : mount;
}

/**
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {Function} opts.onOpen    (favourite) => void
 * @param {Function} opts.onChanged () => void — sidebar/list refresh
 */
export async function renderFavouritesView(container, { onOpen, onChanged } = {}) {
  const page = el('div', { class: 'admin-page' }, el('h2', {}, 'Favourites'));
  page.appendChild(el('p', { class: 'muted', text:
    'Everything you have pinned. Removing a favourite only unpins it — the file or folder itself is never touched.' }));

  const search = el('input', {
    type: 'search', class: 'search', placeholder: 'Filter favourites…',
    'aria-label': 'Filter favourites', style: 'width:220px',
  });

  const removeAll = el('button', { class: 'btn danger' }, icon('trash'), 'Remove all');
  const toolbar = el('div', { class: 'admin-toolbar' }, search, removeAll);
  page.appendChild(toolbar);

  let items = [];
  try {
    const r = await api.get('/api/favorites', { cacheKey: 'favs-all', ttl: 10000, force: true });
    items = r.favorites || [];
    setFavorites(items);
  } catch (e) {
    toastErr(e.message);
  }

  const body = el('div');
  page.appendChild(body);

  const paint = () => {
    clear(body);
    const q = search.value.trim().toLowerCase();
    const shown = q
      ? items.filter((f) => (f.label || f.path || '').toLowerCase().includes(q)
          || (f.path || '').toLowerCase().includes(q)
          || (f.mount || '').toLowerCase().includes(q))
      : items;

    removeAll.disabled = !items.length;
    removeAll.classList.toggle('disabled', !items.length);

    if (!items.length) {
      body.appendChild(el('div', { class: 'empty-state' },
        icon('star-outline', 'empty-ico'),
        el('div', { class: 'empty-title', text: 'Nothing pinned yet' }),
        el('div', { class: 'empty-sub muted', text: 'Use the star on any file or folder to pin it here.' }),
      ));
      return;
    }
    if (!shown.length) {
      body.appendChild(el('div', { class: 'empty-state' },
        icon('search', 'empty-ico'),
        el('div', { class: 'empty-title', text: 'No matching favourites' }),
        el('div', { class: 'empty-sub muted', text: `Nothing pinned matches "${search.value.trim()}".` }),
      ));
      return;
    }

    const table = el('table', { class: 'table' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Name'),
        el('th', {}, 'Type'),
        el('th', {}, 'Drive'),
        el('th', {}, 'Path'),
        el('th', {}, 'Actions'),
      )),
    );
    const tbody = el('tbody');

    for (const f of shown) {
      const isDir = f.type === 'dir';
      const name = el('button', {
        class: 'link-btn', text: f.label || f.path.split('/').filter(Boolean).pop() || f.path,
        title: f.path,
      });
      name.addEventListener('click', () => onOpen && onOpen(f));

      const unpin = el('button', { class: 'btn sm danger', title: 'Remove from favourites' }, icon('star'), 'Unpin');
      unpin.addEventListener('click', async () => {
        try {
          await api.delete(`/api/favorites?mount=${encodeURIComponent(f.mount)}&path=${encodeURIComponent(f.path)}`);
          invalidate('favorites');
          items = items.filter((x) => !(x.mount === f.mount && x.path === f.path));
          setFavorites(items);
          toastOk('Removed from favourites');
          paint();
          if (onChanged) onChanged();
        } catch (e) { toastErr(e.message); }
      });

      tbody.appendChild(el('tr', {},
        el('td', {}, icon(isDir ? 'folder' : 'star', 'ico'), name),
        el('td', { class: 'muted', text: isDir ? 'Folder' : 'File' }),
        el('td', { class: 'muted', text: mountLabel(f.mount) }),
        el('td', {}, el('code', { class: 'muted', text: f.path })),
        el('td', { class: 'row-actions-cell' }, unpin),
      ));
    }
    table.appendChild(tbody);
    body.appendChild(table);
  };

  search.addEventListener('input', paint);

  removeAll.addEventListener('click', async () => {
    if (!items.length) return;
    const ok = await confirmDialog(
      `Remove all ${items.length} favourite(s)? Nothing on disk is affected, but the whole list is cleared and cannot be restored.`,
      { title: 'Remove all favourites', danger: true, okLabel: 'Remove all' },
    );
    if (!ok) return;
    // Password gate: bulk and irreversible.
    const res = await withSensitive('favorites.clear', async () => {
      const r = await clearAllFavorites();
      return r;
    });
    if (!res) return;
    items = [];
    setFavorites([]);
    invalidate('favorites');
    toastOk('All favourites removed');
    paint();
    if (onChanged) onChanged();
  });

  paint();
  container.appendChild(page);
}
