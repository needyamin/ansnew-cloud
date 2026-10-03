'use strict';
/* Global app state: identity, mounts, theme, tabs, clipboard. */

export const state = {
  user: null,
  csrf: '',
  mounts: [],
  theme: 'dark',
  viewMode: localStorage.getItem('ansnew.view') || 'list',
  sort: { key: localStorage.getItem('ansnew.sortKey') || 'name', dir: localStorage.getItem('ansnew.sortDir') || 'asc' },
  showPerms: localStorage.getItem('ansnew.perms') === '1',
  detailsOpen: localStorage.getItem('ansnew.details') !== '0',
  split: false,
  tabs: [],           // { id, mount, path, history: [], histIdx }
  activeTab: 0,
  clipboard: null,    // { mode: 'copy'|'cut', items: [{mount, path, name, isDir}] }
  pane2: null,        // second pane location { mount, path }
  panes: new Set(),   // live FilesPane instances — lets WS events target open panes
};

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
