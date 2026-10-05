'use strict';
/* Global app state: identity, mounts, theme, tabs, clipboard. */

export const state = {
  user: null,
  csrf: '',
  mounts: [],
  theme: 'dark',
  viewMode: localStorage.getItem('ansnew.view') || 'list',
  sort: { key: localStorage.getItem('ansnew.sortKey') || 'name', dir: localStorage.getItem('ansnew.sortDir') || 'asc' },
  detailsOpen: localStorage.getItem('ansnew.details') !== '0',
  split: false,
  tabs: [],           // { id, mount, path, history: [], histIdx }
  activeTab: 0,
  clipboard: null,    // { mode: 'copy'|'cut', items: [{mount, path, name, isDir}] }
  pane2: null,        // second pane location { mount, path }
  panes: new Set(),   // live FilesPane instances — lets WS events target open panes

  favorites: [],      // [{ mount, path, label, created_at }]
  favoriteKeys: new Set(), // "mount:path" — O(1) lookup while rendering rows
  recent: [],         // [{ mount, path, name, action, type, at, ... }]

  sidebarCollapsed: localStorage.getItem('ansnew.sidebar') === '1',

  // Which columns the list view shows. Persisted so the choice survives a
  // reload — a native file manager remembers it, so this one should too.
  cols: {
    size: localStorage.getItem('ansnew.col.size') !== '0',
    mtime: localStorage.getItem('ansnew.col.mtime') !== '0',
    owner: localStorage.getItem('ansnew.col.owner') === '1',
  },

  // File-type filter. The category is global; the extension is per-folder and
  // lives in its own capped map so a big drive can't grow localStorage forever.
  filter: {
    category: localStorage.getItem('ansnew.filter.category') || 'all',
    ext: '',
  },

  // Server-published posture for the destructive-action password gate.
  // Until /api/bootstrap answers we assume the strictest setting, so a slow
  // bootstrap can never let an ungated action through.
  sensitive: { ttl: 60, gateDeleteTrash: true },
};

/* --------------------------------------------------- per-folder extensions */

const EXT_KEY = 'ansnew.filter.ext';
const EXT_MAX = 60; // folders remembered

function readExtMap() {
  try { return JSON.parse(localStorage.getItem(EXT_KEY) || '{}') || {}; }
  catch (_) { return {}; }
}

export function rememberExt(mount, path, ext) {
  const map = readExtMap();
  const key = mount + ':' + path;
  if (ext) map[key] = ext;
  else delete map[key];
  // Bound the map: drop the oldest keys (insertion order) beyond the cap.
  const keys = Object.keys(map);
  if (keys.length > EXT_MAX) {
    for (const k of keys.slice(0, keys.length - EXT_MAX)) delete map[k];
  }
  try { localStorage.setItem(EXT_KEY, JSON.stringify(map)); } catch (_) { /* quota */ }
}

export function recallExt(mount, path) {
  return readExtMap()[mount + ':' + path] || '';
}

/** Persist the category choice globally. */
export function setFilterCategory(cat) {
  state.filter.category = cat || 'all';
  try { localStorage.setItem('ansnew.filter.category', state.filter.category); } catch (_) { /* quota */ }
}

/** Toggle a list column and remember it. */
export function setColumn(name, on) {
  state.cols[name] = !!on;
  try { localStorage.setItem('ansnew.col.' + name, state.cols[name] ? '1' : '0'); } catch (_) { /* quota */ }
}

/** Apply the gate posture published by /api/bootstrap. */
export function setSensitivePolicy(p) {
  if (!p || typeof p !== 'object') return;
  state.sensitive = {
    ttl: Number(p.ttl) || 60,
    gateDeleteTrash: p.gateDeleteTrash !== false,
  };
}

/* ------------------------------------------------------------- favourites */

export function favoriteKey(mount, path) { return mount + ':' + path; }

/** Is this exact item favourited? Used by row rendering and menus. */
export function isFavorite(mount, path) {
  return state.favoriteKeys.has(favoriteKey(mount, path));
}

/** Replace the favourite list and rebuild the lookup set in one step. */
export function setFavorites(list) {
  state.favorites = Array.isArray(list) ? list : [];
  state.favoriteKeys = new Set(state.favorites.map((f) => favoriteKey(f.mount, f.path)));
}

export function setSidebarCollapsed(collapsed) {
  state.sidebarCollapsed = !!collapsed;
  localStorage.setItem('ansnew.sidebar', state.sidebarCollapsed ? '1' : '0');
}

export function saveSession(user, csrf) {
  state.user = user;
  state.csrf = csrf;
  if (user && user.theme) setTheme(user.theme, false);
}

export function setTheme(t, persist = true) {
  state.theme = t === 'light' ? 'light' : 'dark';
  document.body.dataset.theme = state.theme;
  if (persist) localStorage.setItem('ansnew.theme', state.theme);
}

export function currentTab() {
  return state.tabs[state.activeTab] || null;
}
