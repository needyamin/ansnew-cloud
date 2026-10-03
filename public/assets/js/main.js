'use strict';
/*
 * ANSNEW CLOUD SPA entry point.
 * Boots from /api/bootstrap, gates on auth, then builds the desktop-style shell:
 * sidebar (mounts / favorites / recent / tools / admin), topbar actions, tabs,
 * split panes, context menus and the background-job drawer.
 */

import { el, clear, fmtSize } from './util.js';
import { api, setCsrf, clearCache, invalidate } from './api.js';
import { state, saveSession, setTheme } from './state.js';
import { loadSprite, icon } from './icons.js';
import { toast, toastOk, toastErr, toastWarn, dialog, confirmDialog, promptDialog } from './ui.js';
import { FilesPane } from './filespane.js';
import { DetailsPanel } from './details.js';
import { initJobs, openJobs, closeJobs } from './jobs.js';
import * as rt from './realtime.js';
import {
  fsMkdir, fsCreateFile, fsRename, fsArchive, fsExtract,
  fsDeleteBatch, fsMoveBatch, fsCopyBatch,
  triggerDownload, downloadFolder, consumeDownloadToken,
  toggleFavorite, trashList, trashRestore, trashPurge, trashEmpty,
} from './fsops.js';
import { runUploadsWithUI } from './uploadtray.js';
import { abortAllUploads } from './upload.js';
import { runOp, joinPath, dirOf, syntheticEntry, reportBatch, resolveJob } from './mutation.js';
import { initFsWatch } from './fswatch.js';

const root = document.getElementById('app');

let pane = null;          // primary FilesPane
let pane2 = null;         // secondary pane (split view)
let details = null;       // metadata side panel
let view = 'files';       // files | trash | admin-users | admin-mounts | admin-connections | admin-audit
let menuNode = null;      // open context menu
let shellNodes = {};      // cached shell DOM refs
let uploadInput = null;
let watchTimers = new Map();
let shellListenersBound = false;

const isAdmin = () => state.user && state.user.role === 'admin';

/**
 * Admin tables are wider than a phone. Wrapping them in their own scroll box
 * keeps the page itself from scrolling sideways.
 */
function tableWrap(table) {
  return el('div', { class: 'table-wrap' }, table);
}

/* ==================================================================== boot */

(async function boot() {
  setTheme(localStorage.getItem('ansnew.theme') || 'dark', false);
  await loadSprite();
  try {
    const b = await api.get('/api/bootstrap');
    setCsrf(b.csrf);
    if (b.authenticated) {
      saveSession(b.user, b.csrf);
      startApp();
    } else {
      renderLogin();
    }
  } catch (e) {
    clear(root);
    root.appendChild(el('div', { class: 'login-wrap' }, el('div', { class: 'login-card' },
      el('div', { class: 'logo' }, icon('drive'), 'ANSNEW CLOUD'),
      el('div', { class: 'err', text: 'Cannot reach the server: ' + e.message }),
      el('button', { class: 'btn primary', text: 'Retry', onclick: () => location.reload() }),
    )));
  }
})();

/* =================================================================== login */

function renderLogin() {
  clear(root);
  const user = el('input', { type: 'text', placeholder: 'Username', autocomplete: 'username' });
  const pass = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
  const err = el('div', { class: 'err' });
  const btn = el('button', { class: 'btn primary', text: 'Sign in', style: 'justify-content:center' });

  async function submit() {
    err.textContent = '';
    if (!user.value.trim() || !pass.value) { err.textContent = 'Username and password are required.'; return; }
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const r = await api.post('/api/auth/login', { username: user.value.trim(), password: pass.value });
      setCsrf(r.csrf);
      saveSession(r.user, r.csrf);
      startApp();
    } catch (e) {
      err.textContent = e.message;
      pass.value = '';
      pass.focus();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  }

  for (const input of [user, pass]) {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }
  btn.addEventListener('click', submit);

  const card = el('div', { class: 'login-card' },
    el('div', { class: 'logo' }, icon('drive'), 'ANSNEW CLOUD'),
    el('label', { class: 'field' }, 'Username', user),
    el('label', { class: 'field' }, 'Password', pass),
    err,
    btn,
  );
  root.appendChild(el('div', { class: 'login-wrap' }, card));
  setTimeout(() => user.focus(), 40);
}

/* =================================================================== shell */

function startApp() {
  initJobs();
  rt.on('job.progress', (d) => {
    if (!d) return;
    // The push now carries the job's result, so a finished download can be
    // redeemed straight away instead of polling /api/jobs every 1.2s.
    if (d.status === 'done' && d.type === 'download-folder') {
      const token = d.result && d.result.token;
      if (token) consumeDownloadToken(token);
      else resolveDownloadToken(d.id);      // fallback for an older server
    }
    if (d.status === 'done' || d.status === 'error') {
      // Hand the job back to whoever was tracking it, so only the rows it
      // actually owns stop being dimmed.
      resolveJob(d.id, d.status, d.message);
      if (d.status === 'error' && d.message) toastErr('Background job failed: ' + d.message);
    }
  });
  initFsWatch();
  rt.connect();
  // Mounts/favorites/recent must exist before the sidebar can render, so load
  // them first and only then build the shell.
  refreshSidebarData().finally(() => {
    renderShell();
    if (state.user.mustChangePassword) changePassword(true);
  });
}

/* ------------------------------------------------------- sidebar drawer */

let scrimNode = null;

/** Only has a visual effect <=900px, where the sidebar is an overlay drawer. */
function setDrawer(open) {
  if (shellNodes.sidebar) shellNodes.sidebar.classList.toggle('open', open);
  if (scrimNode) scrimNode.classList.toggle('show', open);
}
function closeDrawer() { setDrawer(false); }
function toggleDrawer() {
  setDrawer(!(shellNodes.sidebar && shellNodes.sidebar.classList.contains('open')));
}

function renderShell() {
  clear(root);
  menuNode = null;

  const sidebar = buildSidebar();
  const topbar = buildTopbar();
  const tabsBar = el('div', { class: 'tabs' });
  const content = el('div', { class: 'content' });

  shellNodes = { sidebar, tabsBar, content };

  scrimNode = el('div', { class: 'scrim' });
  scrimNode.addEventListener('click', closeDrawer);

  root.appendChild(el('div', { class: 'shell' },
    sidebar,
    el('div', { class: 'main' }, topbar, tabsBar, content),
  ));
  root.appendChild(scrimNode);

  // Bind document/window listeners once. Signing out no longer reloads the
  // page, so without this guard each sign-in would stack another copy.
  if (!shellListenersBound) {
    shellListenersBound = true;
    window.addEventListener('resize', () => { closeMenu(); closeDrawer(); });
    document.addEventListener('keydown', globalKeys);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  }

  if (!state.tabs.length && state.mounts.length) {
    state.tabs.push({ id: 't' + Date.now(), mount: state.mounts[0].name, path: '/', history: [], histIdx: -1 });
    state.activeTab = 0;
  }
  showView('files');
}

/* ---------------------------------------------------------------- sidebar */

function buildSidebar() {
  const sb = el('div', { class: 'sidebar' });
  sb.appendChild(el('div', { class: 'side-head' }, icon('drive'), 'ANSNEW CLOUD'));

  // One delegated listener closes the overlay drawer whenever a sidebar entry
  // navigates — cheaper and less error-prone than patching every click handler.
  sb.addEventListener('click', (e) => { if (e.target.closest('.side-item')) closeDrawer(); });

  // Mount buttons are tracked so the active highlight can be updated without
  // rebuilding the whole sidebar.
  const mountButtons = new Map();

  const render = () => {
    clear(sb);
    mountButtons.clear();
    sb.appendChild(el('div', { class: 'side-head' }, icon('drive'), 'ANSNEW CLOUD'));

    sb.appendChild(el('div', { class: 'side-sec' }, 'Locations'));
    if (!state.mounts.length) {
      sb.appendChild(el('div', { class: 'side-item' }, el('span', { class: 'lbl muted', text: 'No mounts configured' })));
    }
    for (const m of state.mounts) {
      const active = view === 'files' && pane && pane.loc.mount === m.name;
      const btn = el('button', { class: 'side-item' + (active ? ' active' : ''), title: m.label },
        icon('drive', 'ico'),
        el('span', { class: 'lbl', text: m.label }),
      );
      btn.addEventListener('click', () => navigateTo(m.name, '/'));
      mountButtons.set(m.name, btn);
      sb.appendChild(btn);
    }

    const favs = state.favorites || [];
    sb.appendChild(el('div', { class: 'side-sec' }, 'Favorites'));
    if (!favs.length) {
      sb.appendChild(el('div', { class: 'side-item' }, el('span', { class: 'lbl muted', text: 'Nothing pinned yet' })));
    }
    for (const f of favs) {
      const btn = el('button', { class: 'side-item', title: f.mount + ':' + f.path },
        icon('star', 'ico'), el('span', { class: 'lbl', text: f.label || f.path }));
      btn.addEventListener('click', () => navigateTo(f.mount, f.path));
      sb.appendChild(btn);
    }

    const recent = state.recent || [];
    sb.appendChild(el('div', { class: 'side-sec' }, 'Recent'));
    if (!recent.length) {
      sb.appendChild(el('div', { class: 'side-item' }, el('span', { class: 'lbl muted', text: 'No recent files' })));
    }
    for (const r of recent.slice(0, 6)) {
      const btn = el('button', { class: 'side-item', title: r.mount + ':' + r.path },
        icon('clock', 'ico'), el('span', { class: 'lbl', text: r.name || r.path }));
      btn.addEventListener('click', () => navigateTo(r.mount, r.path.replace(/\/[^/]*$/, '') || '/'));
      sb.appendChild(btn);
    }

    sb.appendChild(el('div', { class: 'side-sec' }, 'Tools'));
    const mkTool = (ico, label, fn) => {
      const b = el('button', { class: 'side-item' }, icon(ico, 'ico'), el('span', { class: 'lbl', text: label }));
      b.addEventListener('click', fn);
      return b;
    };
    sb.appendChild(mkTool('trash', 'Trash', () => showView('trash')));
    sb.appendChild(mkTool('job', 'Background jobs', () => openJobs()));
    sb.appendChild(mkTool('info', 'Storage usage', () => usageDialog()));

    if (isAdmin()) {
      sb.appendChild(el('div', { class: 'side-sec' }, 'Administration'));
      sb.appendChild(mkTool('users', 'Users', () => showView('admin-users')));
      sb.appendChild(mkTool('plug', 'Mounts', () => showView('admin-mounts')));
      sb.appendChild(mkTool('ext', 'Connections', () => showView('admin-connections')));
      sb.appendChild(mkTool('shield', 'Audit log', () => showView('admin-audit')));
    }
  };

  sb.render = render;
  /** Highlight a mount without rebuilding the sidebar. */
  sb.setActive = (mountName) => {
    for (const [name, btn] of mountButtons) btn.classList.toggle('active', name === mountName);
  };
  render();
  return sb;
}

/**
 * Jump the active tab to a location. Every sidebar entry used to call
 * showView('files') — which built a brand-new pane and fetched the directory —
 * and then immediately navigate it again, so one click cost two listings.
 */
function navigateTo(mount, path) {
  const tab = currentTab();
  if (tab) { tab.mount = mount; tab.path = path; tab.history = []; tab.histIdx = -1; }
  if (view === 'files' && pane) { pane.navigate(mount, path); return; }
  showView('files');   // builds a pane already pointed at tab.mount/tab.path
}

/* ----------------------------------------------------------------- topbar */

function buildTopbar() {
  const tb = el('div', { class: 'topbar' });
  const mk = (ico, title, fn, cls = 'btn icon') => {
    const b = el('button', { class: cls, title }, icon(ico));
    b.addEventListener('click', fn);
    return b;
  };
  /** Mark a control as desktop-only so it can move into the overflow menu. */
  const wide = (node) => { node.classList.add('only-wide'); return node; };

  tb.appendChild(mk('list', 'Menu', () => toggleDrawer(), 'btn icon only-narrow'));
  tb.appendChild(mk('up', 'Up one level (Backspace)', () => { if (pane) pane.goUp(); }));
  tb.appendChild(mk('refresh', 'Refresh (F5)', () => { if (pane) pane.refresh(); }));

  tb.appendChild(el('span', { class: 'only-wide', style: 'width:8px' }));
  tb.appendChild(wide(mk('plus', 'New folder', () => newFolder())));
  tb.appendChild(wide(mk('edit', 'New file', () => newFile())));

  const up = el('button', { class: 'btn', title: 'Upload files (Ctrl+U)' }, icon('up'), el('span', { class: 'lbl', text: 'Upload' }));
  up.addEventListener('click', () => pickUpload());
  tb.appendChild(up);

  tb.appendChild(el('span', { class: 'spacer' }));

  const viewBtn = mk(state.viewMode === 'grid' ? 'list' : 'grid',
    state.viewMode === 'grid' ? 'List view' : 'Grid view', () => {
      const next = state.viewMode === 'grid' ? 'list' : 'grid';
      if (pane) pane.setView(next);
      if (pane2) pane2.setView(next);
      viewBtn.replaceChildren(icon(next === 'grid' ? 'list' : 'grid'));
      // Keep the tooltip in sync, otherwise it lies after the first toggle.
      viewBtn.title = next === 'grid' ? 'List view' : 'Grid view';
    });
  tb.appendChild(wide(viewBtn));

  const splitBtn = mk('split', 'Toggle split pane', () => toggleSplit());
  tb.appendChild(wide(splitBtn));

  const jobsBtn = mk('job', 'Background jobs', () => openJobs());
  tb.appendChild(wide(jobsBtn));

  const detailsBtn = mk('info', 'Toggle details panel', () => {
    state.detailsOpen = !state.detailsOpen;
    localStorage.setItem('ansnew.details', state.detailsOpen ? '1' : '0');
    // Just show/hide — rebuilding the panes here refetched both directories.
    if (details) details.root.hidden = !state.detailsOpen;
  });
  tb.appendChild(wide(detailsBtn));

  const themeBtn = mk(state.theme === 'dark' ? 'sun' : 'moon', 'Toggle theme', () => {
    setTheme(state.theme === 'dark' ? 'light' : 'dark', true);
    themeBtn.replaceChildren(icon(state.theme === 'dark' ? 'sun' : 'moon'));
  });
  tb.appendChild(wide(themeBtn));

  // Narrow screens collapse the secondary controls into one menu rather than
  // clipping them off the end of the bar.
  const more = mk('grid', 'More actions', () => {
    const r = more.getBoundingClientRect();
    openMenu(r.right - 210, r.bottom + 6, [
      { label: 'New folder', icon: 'plus', onClick: () => newFolder() },
      { label: 'New file', icon: 'edit', onClick: () => newFile() },
      { sep: true },
      { label: state.viewMode === 'grid' ? 'List view' : 'Grid view', icon: state.viewMode === 'grid' ? 'list' : 'grid', onClick: () => viewBtn.click() },
      { label: 'Toggle split pane', icon: 'split', onClick: () => splitBtn.click() },
      { label: 'Background jobs', icon: 'job', onClick: () => jobsBtn.click() },
      { label: 'Toggle details panel', icon: 'info', onClick: () => detailsBtn.click() },
      { label: 'Toggle theme', icon: state.theme === 'dark' ? 'sun' : 'moon', onClick: () => themeBtn.click() },
    ]);
  }, 'btn icon only-narrow');
  tb.appendChild(more);

  const initials = (state.user.displayName || state.user.username || '?').trim().slice(0, 1).toUpperCase();
  const avatar = el('div', { class: 'avatar', title: state.user.username, text: initials });
  avatar.addEventListener('click', () => {
    const r = avatar.getBoundingClientRect();
    openMenu(r.right - 190, r.bottom + 6, [
      { label: state.user.displayName || state.user.username, disabled: true },
      { sep: true },
      { label: 'Change password', icon: 'edit', onClick: () => changePassword(false) },
      { label: 'Reload app data', icon: 'refresh', onClick: () => refreshSidebarData() },
      { sep: true },
      { label: 'Sign out', icon: 'logout', danger: true, onClick: logout },
    ]);
  });
  tb.appendChild(avatar);

  return tb;
}

/* ------------------------------------------------------------------- tabs */

function currentTab() { return state.tabs[state.activeTab] || null; }

function renderTabs() {
  const bar = shellNodes.tabsBar;
  if (!bar) return;
  clear(bar);
  if (view !== 'files') { bar.style.display = 'none'; return; }
  bar.style.display = '';

  state.tabs.forEach((t, i) => {
    const tab = el('div', { class: 'tab' + (i === state.activeTab ? ' active' : '') },
      icon('folder', 'ico'),
      el('span', { class: 't', text: tabLabel(t) }),
      el('span', { class: 'x', text: '×', title: 'Close tab' }),
    );
    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('x')) { closeTab(i); return; }
      if (i === state.activeTab) return;
      state.activeTab = i;
      const cur = currentTab();
      pane.navigate(cur.mount, cur.path, false);
      renderTabs();
    });
    bar.appendChild(tab);
  });

  const add = el('button', { class: 'tab', title: 'New tab' }, icon('plus', 'ico'));
  add.addEventListener('click', () => {
    const src = currentTab();
    state.tabs.push({ id: 't' + Date.now(), mount: src ? src.mount : (state.mounts[0] || {}).name, path: '/', history: [], histIdx: -1 });
    state.activeTab = state.tabs.length - 1;
    const cur = currentTab();
    pane.navigate(cur.mount, cur.path, false);
    renderTabs();
  });
  bar.appendChild(add);
}

function tabLabel(t) {
  const m = state.mounts.find(x => x.name === t.mount);
  const base = m ? m.label : t.mount;
  return t.path === '/' ? base : base + t.path;
}

function closeTab(i) {
  if (state.tabs.length === 1) return;
  state.tabs.splice(i, 1);
  if (state.activeTab >= state.tabs.length) state.activeTab = state.tabs.length - 1;
  const cur = currentTab();
  pane.navigate(cur.mount, cur.path, false);
  renderTabs();
}

/* ------------------------------------------------------------------ views */

function showView(name) {
  view = name;
  if (shellNodes.sidebar && shellNodes.sidebar.render) shellNodes.sidebar.render();
  if (name !== 'files' && shellNodes.tabsBar) shellNodes.tabsBar.style.display = 'none';
  if (name === 'files') { renderFiles(); return; }
  const c = shellNodes.content;
  destroyPanes();
  clear(c);
  if (name === 'trash') renderTrash(c);
  else if (name === 'admin-users') renderAdminUsers(c);
  else if (name === 'admin-mounts') renderAdminMounts(c);
  else if (name === 'admin-connections') renderAdminConnections(c);
  else if (name === 'admin-audit') renderAdminAudit(c);
}

/** Release both panes before the DOM they live in is thrown away. */
function destroyPanes() {
  if (pane) { pane.destroy(); pane = null; }
  if (pane2) { pane2.destroy(); pane2 = null; }
}

function renderFiles() {
  const c = shellNodes.content;
  destroyPanes();
  clear(c);
  renderTabs();

  const tab = currentTab();
  if (!state.mounts.length) {
    c.appendChild(el('div', { class: 'admin-page' },
      el('h2', {}, 'No storage mounts'),
      el('p', { class: 'muted', text: 'An administrator must add a mount before files can be browsed.' }),
      isAdmin() ? el('button', { class: 'btn primary', text: 'Add a mount', onclick: () => showView('admin-mounts') }) : null,
    ));
    return;
  }
  if (!tab) return;

  const split = el('div', { class: 'fm-split' });
  c.appendChild(split);
  shellNodes.split = split;

  pane = new FilesPane({ mount: tab.mount, path: tab.path }, { compact: state.split });
  wirePane(pane, false);
  split.appendChild(pane.root);

  if (state.split) addSecondPane();

  // Metadata panel (hidden by CSS below 900px).
  details = new DetailsPanel({
    onOpen: (entry, p) => p && p.open(entry),
    onDownload: (p, entries) => p && downloadEntries(p, entries),
    onRename: (p, entry) => p && renameEntry(p, entry),
    onDelete: (p, entries) => p && deleteEntries(p, entries),
    onToggleFavorite: async (entry, p) => {
      if (!p) return;
      await toggleFavorite(p.loc.mount, entry.path, entry.name);
      await refreshSidebarData();
    },
  });
  split.appendChild(details.root);
  details.root.hidden = !state.detailsOpen;
  details.update(pane);
}

function wirePane(p, secondary) {
  p.onNavigate = (loc) => {
    if (secondary) { state.pane2 = loc; return; }
    closeDrawer();
    const tab = currentTab();
    if (!tab) return;
    tab.mount = loc.mount;
    tab.path = loc.path;
    tab.history = tab.history.slice(0, tab.histIdx + 1);
    tab.history.push({ mount: loc.mount, path: loc.path });
    tab.histIdx = tab.history.length - 1;
    renderTabs();
    recordRecent(loc.mount, loc.path);
  };
  p.onSelection = () => {
    if (secondary) return;
    updateSidebarActive();
    if (details) details.update(p);
  };
  p.onContextMenu = (e, entry, inst) => entryMenu(e, entry, inst);
  p.onBackgroundMenu = (e, inst) => backgroundMenu(e, inst);
  p.onDelete = (inst, entries) => deleteEntries(inst, entries && entries.length ? entries : inst.selectedEntries());
  p.onRename = (inst, entry) => { const e = entry || inst.selectedEntries()[0]; if (e) renameEntry(inst, e); };
  p.onDownload = (inst, entries) => downloadEntries(inst, entries);
  p.onCopy = (inst, entries) => stageClipboard(inst, entries, 'copy');
  p.onCut = (inst, entries) => stageClipboard(inst, entries, 'cut');
  p.onMove = (inst, paths, destMount, destDir, srcMount) => movePaths(inst, paths, destMount, destDir, srcMount);
  p.onNewFolder = (inst) => newFolder(inst);
  p.onNewFile = (inst) => newFile(inst);
  p.onUpload = (inst) => pickUpload(inst);
}

/** Create the secondary pane in place, keeping the details panel last. */
function addSecondPane() {
  const tab = currentTab();
  const loc = state.pane2 || { mount: tab ? tab.mount : '', path: tab ? tab.path : '/' };
  pane2 = new FilesPane(loc, { compact: true });
  wirePane(pane2, true);
  shellNodes.split.insertBefore(pane2.root, details ? details.root : null);
}

/**
 * Toggle split view without tearing down the primary pane. The old version
 * called renderFiles(), which destroyed BOTH panes and refetched both
 * directories just to show or hide a second pane.
 */
function toggleSplit() {
  state.split = !state.split;
  if (!state.split) {
    if (pane2) { pane2.destroy(); pane2.root.remove(); pane2 = null; }
    state.pane2 = null;
  } else if (!pane2 && shellNodes.split) {
    addSecondPane();
  }
}

function updateSidebarActive() {
  if (!shellNodes.sidebar) return;
  // Only the highlighted location changes on selection — rebuilding the whole
  // sidebar (mounts + favorites + recent + tools + admin) on every click was
  // pure DOM churn.
  if (shellNodes.sidebar.setActive) shellNodes.sidebar.setActive(view === 'files' && pane ? pane.loc.mount : null);
  else if (shellNodes.sidebar.render) shellNodes.sidebar.render();
}

/**
 * Record a location in the Recent list.
 *
 * Debounced and de-duplicated: this used to fire a POST on every single
 * navigation, including the ones caused by breadcrumb clicks and tab switches.
 */
let recentTimer = null;
let lastRecent = { key: '', at: 0 };

function recordRecent(mount, path) {
  if (path === '/') return;
  const key = mount + ':' + path;
  const now = Date.now();
  if (key === lastRecent.key && now - lastRecent.at < 60000) return;
  lastRecent = { key, at: now };
  clearTimeout(recentTimer);
  recentTimer = setTimeout(() => {
    api.post('/api/recent', {
      mount, path, name: path.split('/').filter(Boolean).pop(), action: 'open',
    }).then(() => invalidate('recent')).catch(() => { /* non-critical */ });
  }, 1500);
}

/* ------------------------------------------------------------ context menu */

function openMenu(x, y, items) {
  closeMenu();
  const m = el('div', { class: 'ctxmenu' });
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { m.appendChild(el('div', { class: 'sep' })); continue; }
    const b = el('button', { class: it.danger ? 'danger' : '' });
    if (it.icon) b.appendChild(icon(it.icon));
    b.appendChild(el('span', { text: it.label }));
    if (it.disabled) b.disabled = true;
    else b.addEventListener('click', () => { closeMenu(); it.onClick && it.onClick(); });
    m.appendChild(b);
  }
  m.style.left = Math.max(6, Math.min(x, window.innerWidth - 200)) + 'px';
  m.style.top = Math.max(6, Math.min(y, window.innerHeight - m.childElementCount * 32 - 20)) + 'px';
  document.body.appendChild(m);
  menuNode = m;
  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, true);
    window.addEventListener('scroll', closeMenu, true);
  }, 0);
}

function onDocDown(e) { if (menuNode && !menuNode.contains(e.target)) closeMenu(); }

function closeMenu() {
  if (!menuNode) return;
  menuNode.remove();
  menuNode = null;
  document.removeEventListener('mousedown', onDocDown, true);
  window.removeEventListener('scroll', closeMenu, true);
}

function entryMenu(e, entry, inst) {
  const sel = inst.selectedEntries();
  const many = sel.length > 1;
  const target = many ? sel : [entry];
  const anyDir = target.some(t => t.type === 'dir');
  const onlyFiles = target.every(t => t.type !== 'dir');
  const writable = inst.mountInfo ? inst.mountInfo.canWrite : true;

  const items = [];
  if (!many) {
    items.push({ label: entry.type === 'dir' ? 'Open' : 'Preview', icon: 'folder', onClick: () => inst.open(entry) });
    if (entry.type !== 'dir') {
      items.push({ label: 'Download', icon: 'download', onClick: () => { triggerDownload(inst.loc.mount, entry.path); recordRecent(inst.loc.mount, entry.path); } });
    } else {
      items.push({ label: 'Download as ZIP', icon: 'download', onClick: () => { downloadFolder(inst.loc.mount, entry.path); openJobs(); } });
    }
    items.push({ sep: true });
  }
  items.push(
    { label: many ? `Download ${target.length} items` : 'Download', icon: 'download', disabled: anyDir, onClick: () => target.forEach(t => triggerDownload(inst.loc.mount, t.path)) },
    { label: 'Copy', icon: 'copy', onClick: () => stageClipboard(inst, target, 'copy') },
    { label: 'Cut', icon: 'cut', disabled: !writable, onClick: () => stageClipboard(inst, target, 'cut') },
    { sep: true },
    { label: 'Rename', icon: 'edit', disabled: many || !writable, onClick: () => renameEntry(inst, entry) },
    { label: 'Compress to ZIP', icon: 'archive', onClick: () => compress(inst, target) },
    { label: 'Extract here', icon: 'archive', disabled: many || entry.type === 'dir', onClick: () => extract(inst, entry) },
    { label: 'Add to favorites', icon: 'star', disabled: many, onClick: async () => { await toggleFavorite(inst.loc.mount, entry.path, entry.name); await refreshSidebarData(); } },
    { sep: true },
    { label: 'Delete', icon: 'trash', danger: true, disabled: !writable, onClick: () => deleteEntries(inst, target) },
  );
  openMenu(e.clientX, e.clientY, items);
}

function backgroundMenu(e, inst) {
  const items = [
    { label: 'New folder', icon: 'plus', onClick: () => newFolder(inst) },
    { label: 'New file', icon: 'edit', onClick: () => newFile(inst) },
    { label: 'Upload files…', icon: 'up', onClick: () => pickUpload(inst) },
    { sep: true },
    { label: 'Paste', icon: 'paste', disabled: !state.clipboard, onClick: () => pasteInto(inst) },
    { sep: true },
    { label: 'Refresh', icon: 'refresh', onClick: () => inst.refresh() },
    { label: 'Select all', icon: 'check', onClick: () => inst.selectAll() },
  ];
  openMenu(e.clientX, e.clientY, items);
}

/* ------------------------------------------------------------- file actions */

async function newFolder(inst = pane) {
  if (!inst) return;
  const name = await promptDialog('Folder name', '', { title: 'New folder', okLabel: 'Create' });
  if (!name) return;
  const mount = inst.loc.mount;
  const dir = inst.loc.path;
  await runOp({
    pane: inst,
    // The row appears before the request is even sent.
    patch: () => ({ add: [syntheticEntry(joinPath(dir, name), name, 'dir')] }),
    call: () => fsMkdir(mount, dir, name),
    invalidate: [[mount, dir]],
    okMsg: 'Folder created',
  });
}

async function newFile(inst = pane) {
  if (!inst) return;
  const name = await promptDialog('File name', '', { title: 'New file', okLabel: 'Create' });
  if (!name) return;
  const mount = inst.loc.mount;
  const dir = inst.loc.path;
  await runOp({
    pane: inst,
    patch: () => ({ add: [syntheticEntry(joinPath(dir, name), name, 'file')] }),
    call: () => fsCreateFile(mount, dir, name),
    invalidate: [[mount, dir]],
    okMsg: 'File created',
  });
}

async function renameEntry(inst, entry) {
  const name = await promptDialog('New name', entry.name, { title: 'Rename', okLabel: 'Rename' });
  if (!name || name === entry.name) return;
  const mount = inst.loc.mount;
  const target = joinPath(dirOf(entry.path), name);
  await runOp({
    pane: inst,
    patch: () => {
      // Keep the selection on the row as it moves to its new name.
      if (inst.selected.delete(entry.path)) inst.selected.add(target);
      return {
        remove: [entry.path],
        add: [syntheticEntry(target, name, entry.type, entry.size)],
      };
    },
    call: () => fsRename(mount, entry.path, name),
    invalidate: [[mount, dirOf(entry.path)], [mount, inst.loc.path]],
    okMsg: 'Renamed',
  });
}

function renameSelection(inst) {
  const sel = inst.selectedEntries();
  if (sel.length === 1) renameEntry(inst, sel[0]);
  else if (sel.length > 1) toastWarn('Select a single item to rename');
}

function deleteSelection(inst) { deleteEntries(inst, inst.selectedEntries()); }

async function deleteEntries(inst, entries) {
  if (!entries || !entries.length) return;
  const label = entries.length === 1 ? `"${entries[0].name}"` : `${entries.length} items`;
  const permanent = !inst.mountInfo || inst.mountInfo.trashEnabled === false;
  const ok = await confirmDialog(
    permanent ? `Permanently delete ${label}? This cannot be undone.` : `Move ${label} to trash?`,
    { title: 'Delete', danger: permanent, okLabel: permanent ? 'Delete permanently' : 'Move to trash' },
  );
  if (!ok) return;

  const mount = inst.loc.mount;
  // Files vanish instantly. Folders are handled by a background job, so they
  // stay visible (dimmed) until the worker confirms.
  const files = entries.filter(e => e.type !== 'dir');
  const res = await runOp({
    pane: inst,
    patch: () => ({ remove: files.map(e => e.path) }),
    pending: entries.map(e => e.path),
    call: () => fsDeleteBatch(mount, entries.map(e => ({ path: e.path })), permanent),
    invalidate: [[mount, inst.loc.path]],
  });
  if (res) reportBatch(res, { verb: 'Deleted', openJobs });
  if (res) inst.scheduleRevalidate(700);
}

/* ------------------------------------------- selection-bar / drag-drop actions */

/** Download each entry; folders are zipped server-side by a background job. */
function downloadEntries(inst, entries) {
  if (!entries || !entries.length) return;
  let anyFolder = false;
  for (const e of entries) {
    if (e.type === 'dir') { downloadFolder(inst.loc.mount, e.path); anyFolder = true; }
    else triggerDownload(inst.loc.mount, e.path);
  }
  if (anyFolder) { toast('Preparing ZIP download…', 'info'); openJobs(); }
}

/** Put entries on the internal clipboard for a later Paste. */
function stageClipboard(inst, entries, mode) {
  if (!entries || !entries.length) return;
  state.clipboard = {
    mode,
    items: entries.map(t => ({ mount: inst.loc.mount, path: t.path, name: t.name, isDir: t.type === 'dir' })),
  };
  toastOk(`${mode === 'copy' ? 'Copied' : 'Cut'} ${entries.length} item(s)`);
}

/** Internal / cross-pane / cross-mount move — used by drag & drop. */
async function movePaths(inst, paths, destMount, destDir, srcMount) {
  if (!paths || !paths.length) return;
  const mount = srcMount || inst.loc.mount;

  // Refuse dropping a folder into itself or its own descendant (the server
  // enforces this too, but catching it here avoids a pointless request).
  const movable = paths.filter(p => !(p === destDir || destDir.startsWith(p + '/')));
  const skipped = paths.length - movable.length;
  if (!movable.length) { if (skipped) toastWarn('Cannot move a folder into itself'); return; }

  // Same-mount moves into the directory on screen can be shown instantly;
  // cross-mount or off-screen destinations are reconciled by the revalidate.
  const sameDir = destMount === mount && destDir === inst.loc.path;
  const entries = sameDir ? movable.map(p => inst.entryByPath(p)).filter(Boolean) : [];

  const res = await runOp({
    pane: inst,
    patch: () => ({ remove: entries.map(e => e.path) }),
    pending: movable,
    call: () => fsMoveBatch(mount, movable.map(p => ({ path: p })), destDir, destMount),
    invalidate: [[mount, inst.loc.path], [destMount, destDir]],
  });
  if (res) reportBatch(res, { verb: 'Moved', openJobs });
  if (res && skipped) toastWarn(`${skipped} item(s) skipped`);
  if (res) inst.scheduleRevalidate(700);
}

async function compress(inst, entries) {
  const base = entries.length === 1 ? entries[0].name.replace(/\.[^.]+$/, '') : 'archive';
  const name = await promptDialog('Archive name', base + '.zip', { title: 'Compress', okLabel: 'Compress' });
  if (!name) return;
  try {
    await fsArchive(inst.loc.mount, entries.map(x => x.path), inst.loc.path, name, 'zip');
    toast('Compressing in the background…', 'info');
    openJobs();
  } catch (e) { toastErr(e.message); }
}

async function extract(inst, entry) {
  try {
    await fsExtract(inst.loc.mount, entry.path, inst.loc.path);
    toast('Extracting in the background…', 'info');
    openJobs();
  } catch (e) { toastErr(e.message); }
}

async function pasteInto(inst) {
  const cb = state.clipboard;
  if (!cb || !cb.items.length) return;
  const mount = inst.loc.mount;
  const dir = inst.loc.path;
  const isCut = cb.mode === 'cut';

  // A cut from the directory on screen can be reflected immediately; a copy
  // (or a cut from elsewhere) is reconciled by the revalidate, because the
  // destination name may be rewritten by conflict handling.
  const localCut = isCut ? cb.items.filter(it => it.mount === mount && dirOf(it.path) === dir) : [];
  const fromHere = localCut.map(it => it.path);

  const res = await runOp({
    pane: inst,
    patch: () => ({ remove: fromHere }),
    pending: cb.items.map(it => it.path),
    call: () => (isCut
      ? fsMoveBatch(mount, cb.items.map(it => ({ path: it.path, mount: it.mount })), dir, mount)
      : fsCopyBatch(mount, cb.items.map(it => ({ path: it.path, mount: it.mount })), dir, mount)),
    invalidate: [[mount, dir]],
  });

  if (!res) return;
  reportBatch(res, { verb: isCut ? 'Moved' : 'Copied', openJobs });
  if (isCut && (res.done || []).length) state.clipboard = null;
  inst.scheduleRevalidate(700);
}

function pickUpload(inst = pane) {
  if (!inst) return;
  if (!uploadInput) {
    uploadInput = el('input', { type: 'file', multiple: true, style: 'display:none' });
    document.body.appendChild(uploadInput);
  }
  uploadInput.onchange = () => {
    const files = [...uploadInput.files];
    uploadInput.value = '';
    if (!files.length) return;
    // Hand over the pane so the incoming files show up immediately.
    runUploadsWithUI(files, inst.loc.mount, inst.loc.path, 'rename', inst);
  };
  uploadInput.click();
}

/* ----------------------------------------------------------- trash browser */

async function renderTrash(c) {
  const page = el('div', { class: 'admin-page' }, el('h2', {}, 'Trash'));
  const toolbar = el('div', { class: 'admin-toolbar' });
  const emptyBtn = el('button', { class: 'btn danger' }, icon('trash'), 'Empty all trash');
  emptyBtn.addEventListener('click', async () => {
    if (!state.mounts.length) return;
    const ok = await confirmDialog('Permanently delete everything in the trash? This cannot be undone.',
      { title: 'Empty trash', danger: true, okLabel: 'Empty trash' });
    if (!ok) return;
    for (const m of state.mounts) { try { await trashEmpty(m.name); } catch (_) {} }
    toastOk('Trash emptied');
    showView('trash');
  });
  toolbar.appendChild(emptyBtn);
  page.appendChild(toolbar);

  const wrap = el('div');
  page.appendChild(wrap);
  c.appendChild(page);

  const rows = [];
  for (const m of state.mounts) {
    try {
      const items = await trashList(m.name);
      for (const it of items) rows.push({ ...it, mountName: m.name, mountLabel: m.label });
    } catch (_) { /* skip mount */ }
  }

  if (!rows.length) {
    wrap.appendChild(el('div', { class: 'empty-hint', text: 'Trash is empty.' }));
    return;
  }

  const table = el('table', { class: 'table' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Name'), el('th', {}, 'Mount'), el('th', {}, 'Original path'),
      el('th', {}, 'Size'), el('th', {}, 'Deleted'), el('th', { class: 'actions' }, 'Actions'))),
  );
  const tbody = el('tbody');
  for (const it of rows) {
    const tr = el('tr', {},
      el('td', {}, icon(it.is_dir ? 'folder' : 'file', 'ico'), ' ', it.name),
      el('td', { class: 'muted', text: it.mountLabel || it.mount }),
      el('td', { class: 'muted', text: it.original_path }),
      el('td', { class: 'muted', text: it.is_dir ? '—' : fmtSize(it.size) }),
      el('td', { class: 'muted', text: it.deleted_at || '' }),
    );
    const actions = el('td', { class: 'actions' });
    const restore = el('button', { class: 'btn' }, 'Restore');
    restore.addEventListener('click', async () => {
      try { await trashRestore(it.mountName, it.id); toastOk('Restored'); showView('trash'); }
      catch (e) { toastErr(e.message); }
    });
    const purge = el('button', { class: 'btn danger' }, 'Delete');
    purge.addEventListener('click', async () => {
      const ok = await confirmDialog(`Permanently delete "${it.name}"?`, { title: 'Delete', danger: true, okLabel: 'Delete' });
      if (!ok) return;
      try { await trashPurge(it.mountName, it.id); toastOk('Deleted'); showView('trash'); }
      catch (e) { toastErr(e.message); }
    });
    actions.append(restore, purge);
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(tableWrap(table));
}

/* ---------------------------------------------------------- admin: users */

async function renderAdminUsers(c) {
  const page = el('div', { class: 'admin-page' }, el('h2', {}, 'Users'));
  const bar = el('div', { class: 'admin-toolbar' });
  const add = el('button', { class: 'btn primary' }, icon('plus'), 'New user');
  add.addEventListener('click', () => userDialog(null));
  bar.appendChild(add);
  page.appendChild(bar);

  let data;
  try { data = await api.get('/api/admin/users'); }
  catch (e) { page.appendChild(el('div', { class: 'muted', text: e.message })); c.appendChild(page); return; }

  const table = el('table', { class: 'table' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Username'), el('th', {}, 'Display name'), el('th', {}, 'Email'),
      el('th', {}, 'Role'), el('th', {}, 'Status'), el('th', {}, 'Last login'),
      el('th', { class: 'actions' }, 'Actions'))),
  );
  const tbody = el('tbody');
  for (const u of data.users) {
    const role = el('td', {}, el('span', { class: 'badge' + (u.role === 'admin' ? ' ok' : ''), text: u.role }));
    const status = el('td', {}, el('span', { class: 'badge' + (Number(u.is_active) ? ' ok' : ' off'), text: Number(u.is_active) ? 'active' : 'disabled' }));
    const tr = el('tr', {},
      el('td', {}, u.username),
      el('td', { class: 'muted', text: u.display_name || '' }),
      el('td', { class: 'muted', text: u.email || '' }),
      role, status,
      el('td', { class: 'muted', text: u.last_login_at || '—' }),
    );
    const actions = el('td', { class: 'actions' });
    const edit = el('button', { class: 'btn' }, 'Edit');
    edit.addEventListener('click', () => userDialog(u, () => showView('admin-users')));
    const pw = el('button', { class: 'btn' }, 'Password');
    pw.addEventListener('click', async () => {
      const v = await promptDialog(`New password for "${u.username}"`, '', { title: 'Reset password', okLabel: 'Set password' });
      if (!v) return;
      try { await api.post(`/api/admin/users/${u.id}`, { action: 'set-password', password: v }); toastOk('Password updated'); }
      catch (e) { toastErr(e.message); }
    });
    const del = el('button', { class: 'btn danger' }, 'Delete');
    del.addEventListener('click', async () => {
      const ok = await confirmDialog(`Delete user "${u.username}"?`, { title: 'Delete user', danger: true, okLabel: 'Delete' });
      if (!ok) return;
      try { await api.delete(`/api/admin/users/${u.id}`); toastOk('User deleted'); showView('admin-users'); }
      catch (e) { toastErr(e.message); }
    });
    actions.append(edit, pw, del);
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  page.appendChild(tableWrap(table));
  c.appendChild(page);
}

function userDialog(u, onDone) {
  const username = el('input', { type: 'text', value: u ? u.username : '' });
  const display = el('input', { type: 'text', value: u ? (u.display_name || '') : '' });
  const email = el('input', { type: 'text', value: u ? (u.email || '') : '' });
  const role = el('select', {},
    el('option', { value: 'user', text: 'user' }),
    el('option', { value: 'admin', text: 'admin' }),
  );
  role.value = u ? u.role : 'user';
  const password = el('input', { type: 'password', placeholder: u ? '(unchanged)' : 'required' });
  const active = el('input', { type: 'checkbox' });
  active.checked = u ? Number(u.is_active) === 1 : true;

  const body = [
    el('label', { class: 'field' }, 'Username', username),
    el('label', { class: 'field' }, 'Display name', display),
    el('label', { class: 'field' }, 'Email', email),
    el('label', { class: 'field' }, 'Role', role),
    el('label', { class: 'field' }, u ? 'New password (leave blank to keep)' : 'Password', password),
  ];
  if (u) body.push(el('label', { class: 'checkbox' }, active, 'Active'));

  dialog({
    title: u ? 'Edit user' : 'New user',
    body,
    buttons: [
      { label: 'Cancel' },
      {
        label: u ? 'Save' : 'Create', kind: 'primary', primary: true,
        onClick: async () => {
          try {
            if (!u) {
              if (!username.value.trim() || !password.value) { toastErr('Username and password are required'); return false; }
              await api.post('/api/admin/users', {
                username: username.value.trim(), password: password.value,
                role: role.value, displayName: display.value.trim(), email: email.value.trim(),
              });
              toastOk('User created');
            } else {
              await api.post(`/api/admin/users/${u.id}`, { action: 'update-profile', displayName: display.value.trim(), email: email.value.trim() });
              if (role.value !== u.role) await api.post(`/api/admin/users/${u.id}`, { action: 'set-role', role: role.value });
              if (active.checked !== (Number(u.is_active) === 1)) await api.post(`/api/admin/users/${u.id}`, { action: 'set-active', active: active.checked });
              if (password.value) await api.post(`/api/admin/users/${u.id}`, { action: 'set-password', password: password.value });
              toastOk('User updated');
            }
            onDone ? onDone() : showView('admin-users');
          } catch (e) { toastErr(e.message); return false; }
        },
      },
    ],
  });
}

/* --------------------------------------------------------- admin: mounts */

async function renderAdminMounts(c) {
  const page = el('div', { class: 'admin-page' }, el('h2', {}, 'Mounts'));
  const bar = el('div', { class: 'admin-toolbar' });
  const add = el('button', { class: 'btn primary' }, icon('plus'), 'New mount');
  add.addEventListener('click', () => mountDialog(null));
  bar.appendChild(add);
  page.appendChild(bar);

  let data, conns;
  try {
    data = await api.get('/api/admin/mounts');
    conns = (await api.get('/api/admin/connections')).connections || [];
  } catch (e) { page.appendChild(el('div', { class: 'muted', text: e.message })); c.appendChild(page); return; }

  const table = el('table', { class: 'table' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Name'), el('th', {}, 'Label'), el('th', {}, 'Adapter'),
      el('th', {}, 'Target'), el('th', {}, 'Flags'), el('th', { class: 'actions' }, 'Actions'))),
  );
  const tbody = el('tbody');
  for (const m of data.mounts) {
    const flags = [];
    if (Number(m.is_readonly)) flags.push('read-only');
    if (Number(m.is_visible_all)) flags.push('all users');
    if (Number(m.trash_enabled)) flags.push('trash');
    const tr = el('tr', {},
      el('td', {}, m.name),
      el('td', { class: 'muted', text: m.label }),
      el('td', {}, el('span', { class: 'badge', text: m.adapter })),
      el('td', { class: 'muted', text: m.adapter === 'local' ? (m.local_root || '—') : ('connection #' + (m.connection_id || '?')) }),
      el('td', { class: 'muted', text: flags.join(', ') || '—' }),
    );
    const actions = el('td', { class: 'actions' });
    const edit = el('button', { class: 'btn' }, 'Edit');
    edit.addEventListener('click', () => mountDialog(m, () => showView('admin-mounts')));
    const del = el('button', { class: 'btn danger' }, 'Delete');
    del.addEventListener('click', async () => {
      const ok = await confirmDialog(`Delete mount "${m.name}"? Files are not removed, but the mount disappears from the UI.`,
        { title: 'Delete mount', danger: true, okLabel: 'Delete' });
      if (!ok) return;
      try { await api.delete(`/api/admin/mounts/${m.id}`); toastOk('Mount deleted'); showView('admin-mounts'); }
      catch (e) { toastErr(e.message); }
    });
    actions.append(edit, del);
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  page.appendChild(tableWrap(table));
  c.appendChild(page);
}

function mountDialog(m, onDone) {
  const name = el('input', { type: 'text', value: m ? m.name : '', placeholder: 'local' });
  const label = el('input', { type: 'text', value: m ? m.label : '', placeholder: 'Local Storage' });
  const adapter = el('select', {},
    ...['local', 'ftp', 'ftps', 'sftp', 'smb', 'http'].map(a => el('option', { value: a, text: a })));
  adapter.value = m ? m.adapter : 'local';
  const localRoot = el('input', { type: 'text', value: m && m.local_root ? m.local_root : '', placeholder: '/srv/storage/local' });
  const remotePath = el('input', { type: 'text', value: m ? (m.remote_path || '/') : '/', placeholder: '/' });

  const body = [
    el('label', { class: 'field' }, 'Name (slug used by the API)', name),
    el('label', { class: 'field' }, 'Label', label),
    el('label', { class: 'field' }, 'Adapter', adapter),
    el('label', { class: 'field' }, 'Local root (local adapter only)', localRoot),
    el('label', { class: 'field' }, 'Remote path', remotePath),
  ];

  if (!m) {
    dialog({
      title: 'New mount',
      body,
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Create', kind: 'primary', primary: true,
          onClick: async () => {
            try {
              await api.post('/api/admin/mounts', {
                name: name.value.trim(), label: label.value.trim(), adapter: adapter.value,
                localRoot: localRoot.value.trim().replace(/^\/srv\/storage\/local\/?/, ''),
                remotePath: remotePath.value.trim() || '/', visibleAll: true, trashEnabled: true,
              });
              toastOk('Mount created');
              await refreshSidebarData();
              onDone ? onDone() : showView('admin-mounts');
            } catch (e) { toastErr(e.message); return false; }
          },
        },
      ],
    });
    return;
  }

  const readOnly = el('input', { type: 'checkbox' }); readOnly.checked = Number(m.is_readonly) === 1;
  const visibleAll = el('input', { type: 'checkbox' }); visibleAll.checked = Number(m.is_visible_all) === 1;
  const trashEnabled = el('input', { type: 'checkbox' }); trashEnabled.checked = Number(m.trash_enabled) === 1;
  body.push(
    el('label', { class: 'checkbox' }, readOnly, 'Read-only'),
    el('label', { class: 'checkbox' }, visibleAll, 'Visible to all users'),
    el('label', { class: 'checkbox' }, trashEnabled, 'Trash enabled'),
  );

  dialog({
    title: 'Edit mount: ' + m.name,
    body,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Save', kind: 'primary', primary: true,
        onClick: async () => {
          try {
            await api.post(`/api/admin/mounts/${m.id}`, {
              action: 'set-flags',
              readOnly: readOnly.checked, visibleAll: visibleAll.checked, trashEnabled: trashEnabled.checked,
            });
            toastOk('Mount updated');
            await refreshSidebarData();
            onDone ? onDone() : showView('admin-mounts');
          } catch (e) { toastErr(e.message); return false; }
        },
      },
    ],
  });
}

/* ---------------------------------------------------- admin: connections */

async function renderAdminConnections(c) {
  const page = el('div', { class: 'admin-page' }, el('h2', {}, 'Remote connections'));
  const bar = el('div', { class: 'admin-toolbar' });
  const add = el('button', { class: 'btn primary' }, icon('plus'), 'New connection');
  add.addEventListener('click', () => connectionDialog(() => showView('admin-connections')));
  bar.appendChild(add);
  page.appendChild(bar);
  page.appendChild(el('p', { class: 'muted', text: 'Credentials are encrypted at rest and never sent to the browser.' }));

  let data;
  try { data = await api.get('/api/admin/connections'); }
  catch (e) { page.appendChild(el('div', { class: 'muted', text: e.message })); c.appendChild(page); return; }

  if (!data.connections.length) {
    page.appendChild(el('div', { class: 'empty-hint', text: 'No saved connections yet.' }));
    c.appendChild(page);
    return;
  }

  const table = el('table', { class: 'table' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Name'), el('th', {}, 'Protocol'), el('th', {}, 'Host'),
      el('th', {}, 'Port'), el('th', {}, 'Username'), el('th', {}, 'Auth'),
      el('th', { class: 'actions' }, 'Actions'))),
  );
  const tbody = el('tbody');
  for (const cn of data.connections) {
    const tr = el('tr', {},
      el('td', {}, cn.name),
      el('td', {}, el('span', { class: 'badge', text: cn.protocol })),
      el('td', { class: 'muted', text: cn.host }),
      el('td', { class: 'muted', text: String(cn.port) }),
      el('td', { class: 'muted', text: cn.username || '—' }),
      el('td', { class: 'muted', text: cn.auth_type }),
    );
    const actions = el('td', { class: 'actions' });
    const test = el('button', { class: 'btn' }, 'Test');
    test.addEventListener('click', async () => {
      test.disabled = true; test.textContent = 'Testing…';
      try {
        const r = await api.post(`/api/admin/connections/${cn.id}/test`, {});
        if (r.reachable) toastOk(`${cn.name}: reachable`);
        else toastErr(`${cn.name}: ${r.error || 'unreachable'}`);
      } catch (e) { toastErr(e.message); }
      finally { test.disabled = false; test.textContent = 'Test'; }
    });
    const del = el('button', { class: 'btn danger' }, 'Delete');
    del.addEventListener('click', async () => {
      const ok = await confirmDialog(`Delete connection "${cn.name}"?`, { title: 'Delete connection', danger: true, okLabel: 'Delete' });
      if (!ok) return;
      try { await api.delete(`/api/admin/connections/${cn.id}`); toastOk('Connection deleted'); showView('admin-connections'); }
      catch (e) { toastErr(e.message); }
    });
    actions.append(test, del);
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  page.appendChild(tableWrap(table));
  c.appendChild(page);
}

function connectionDialog(onDone) {
  const name = el('input', { type: 'text', placeholder: 'office-nas' });
  const protocol = el('select', {}, ...['ftp', 'ftps', 'sftp', 'smb', 'http'].map(p => el('option', { value: p, text: p })));
  const host = el('input', { type: 'text', placeholder: '10.0.0.5' });
  const port = el('input', { type: 'number', value: '21' });
  const username = el('input', { type: 'text' });
  const authType = el('select', {}, ...['password', 'key', 'none'].map(a => el('option', { value: a, text: a })));
  const secret = el('textarea', { rows: '3', placeholder: 'Password or private key (stored encrypted)' });
  const remoteBase = el('input', { type: 'text', value: '/' });
  const verifyTls = el('input', { type: 'checkbox' }); verifyTls.checked = true;

  const defaultPorts = { ftp: '21', ftps: '21', sftp: '22', smb: '445', http: '80' };
  protocol.addEventListener('change', () => { port.value = defaultPorts[protocol.value] || '21'; });

  dialog({
    title: 'New connection',
    body: [
      el('label', { class: 'field' }, 'Name', name),
      el('label', { class: 'field' }, 'Protocol', protocol),
      el('label', { class: 'field' }, 'Host', host),
      el('label', { class: 'field' }, 'Port', port),
      el('label', { class: 'field' }, 'Username', username),
      el('label', { class: 'field' }, 'Auth type', authType),
      el('label', { class: 'field' }, 'Secret', secret),
      el('label', { class: 'field' }, 'Remote base path', remoteBase),
      el('label', { class: 'checkbox' }, verifyTls, 'Verify TLS certificate'),
    ],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Create', kind: 'primary', primary: true,
        onClick: async () => {
          try {
            await api.post('/api/admin/connections', {
              name: name.value.trim(), protocol: protocol.value, host: host.value.trim(),
              port: Number(port.value), username: username.value.trim(), authType: authType.value,
              secret: secret.value, remoteBase: remoteBase.value.trim() || '/', verifyTls: verifyTls.checked,
            });
            toastOk('Connection created');
            onDone ? onDone() : showView('admin-connections');
          } catch (e) { toastErr(e.message); return false; }
        },
      },
    ],
  });
}

/* --------------------------------------------------------- admin: audit */

async function renderAdminAudit(c) {
  const page = el('div', { class: 'admin-page' }, el('h2', {}, 'Audit log'));
  let data;
  try { data = await api.get('/api/admin/audit?limit=200'); }
  catch (e) { page.appendChild(el('div', { class: 'muted', text: e.message })); c.appendChild(page); return; }

  if (!data.entries.length) {
    page.appendChild(el('div', { class: 'empty-hint', text: 'No audit entries yet.' }));
    c.appendChild(page);
    return;
  }
  const table = el('table', { class: 'table' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'When'), el('th', {}, 'User'), el('th', {}, 'Action'),
      el('th', {}, 'Target'), el('th', {}, 'Result'), el('th', {}, 'IP'))),
  );
  const tbody = el('tbody');
  for (const e of data.entries) {
    tbody.appendChild(el('tr', {},
      el('td', { class: 'muted', text: e.created_at || '' }),
      el('td', { class: 'muted', text: e.username || e.user_id || '—' }),
      el('td', {}, e.action || ''),
      el('td', { class: 'muted', text: [e.mount, e.path, e.target].filter(Boolean).join(' ') || '—' }),
      el('td', {}, el('span', { class: 'badge' + (e.result === 'ok' ? ' ok' : ''), text: e.result || '' })),
      el('td', { class: 'muted', text: e.ip || '' }),
    ));
  }
  table.appendChild(tbody);
  page.appendChild(tableWrap(table));
  c.appendChild(page);
}

/* ------------------------------------------------------- misc / utilities */

async function refreshSidebarData() {
  try {
    const [m, f, r] = await Promise.all([
      api.get('/api/mounts', { cacheKey: 'mounts', ttl: 30000 }),
      api.get('/api/favorites', { cacheKey: 'favorites', ttl: 30000 }),
      api.get('/api/recent?limit=8', { cacheKey: 'recent', ttl: 30000 }),
    ]);
    state.mounts = m.mounts || [];
    state.favorites = f.favorites || [];
    state.recent = r.recent || [];
    if (shellNodes.sidebar && shellNodes.sidebar.render) shellNodes.sidebar.render();
  } catch (_) { /* ignore */ }
}

async function usageDialog() {
  let data;
  try { data = await api.get('/api/usage'); }
  catch (e) { toastErr(e.message); return; }
  const rows = (data.mounts || []).map(u => el('div', { style: 'display:flex;gap:10px;align-items:center' },
    icon('drive', 'ico'),
    el('span', { style: 'flex:1', text: u.label || u.mount || u.name || '' }),
    el('span', { class: 'muted', text: fmtSize(u.bytes || u.size || 0) }),
    el('span', { class: 'muted', text: (u.files != null ? u.files + ' files' : '') }),
  ));
  dialog({
    title: 'Storage usage',
    body: [
      ...(rows.length ? rows : [el('p', { class: 'muted', text: 'No usage data yet — run a scan.' })]),
      el('p', { class: 'muted', text: 'Application data directory: ' + fmtSize(data.dataDirBytes || 0) }),
    ],
    buttons: [
      { label: 'Close' },
      {
        label: 'Rescan', kind: 'primary', primary: true,
        onClick: async () => {
          for (const m of state.mounts) { try { await api.post(`/api/usage/${encodeURIComponent(m.name)}/scan`, {}); } catch (_) {} }
          toast('Scanning storage in the background…', 'info');
          openJobs();
        },
      },
    ],
  });
}

function changePassword(forced) {
  const cur = el('input', { type: 'password', placeholder: forced ? 'Current password' : 'Current password' });
  const next = el('input', { type: 'password', placeholder: 'New password (min 8 chars)' });
  dialog({
    title: forced ? 'Password change required' : 'Change password',
    body: [
      forced ? el('p', { class: 'muted', text: 'Your administrator requires you to set a new password.' }) : null,
      el('label', { class: 'field' }, 'Current password', cur),
      el('label', { class: 'field' }, 'New password', next),
    ],
    buttons: [
      forced ? null : { label: 'Cancel' },
      {
        label: 'Update password', kind: 'primary', primary: true,
        onClick: async () => {
          if (next.value.length < 8) { toastErr('New password must be at least 8 characters'); return false; }
          try {
            // Field names must match AuthController::changePassword — this used
            // to send {current, password}, so every change failed with 403.
            await api.post('/api/auth/password', {
              currentPassword: cur.value,
              newPassword: next.value,
            });
            toastOk('Password updated');
          } catch (e) { toastErr(e.message); return false; }
        },
      },
    ].filter(Boolean),
  });
}

/**
 * Sign out without reloading the page.
 *
 * The old implementation called location.reload(), which threw away the whole
 * SPA (and its warm module graph) just to show a login form again.
 */
async function logout() {
  try { await api.post('/api/auth/logout', {}); } catch (_) { /* ignore */ }
  rt.disconnect();
  abortAllUploads();
  closeJobs();
  closeMenu();
  closeDrawer();

  // Drop everything belonging to the previous session.
  clearCache();
  destroyPanes();
  details = null;
  view = 'files';
  menuNode = null;
  shellNodes = {};
  state.user = null;
  state.csrf = '';
  state.tabs = [];
  state.activeTab = 0;
  state.clipboard = null;
  state.pane2 = null;
  state.split = false;
  state.mounts = [];
  state.favorites = [];
  state.recent = [];
  setCsrf('');

  renderLogin();
}

/**
 * Fallback path for when a push arrives without the job's result.
 *
 * Previously this polled /api/jobs forever at 1.2 s intervals; now it is capped
 * and stops as soon as the job reaches a terminal state. The normal path is the
 * WebSocket push, which already carries the token.
 */
function resolveDownloadToken(jobId) {
  if (watchTimers.has(jobId)) return;
  const MAX_ATTEMPTS = 12;
  let attempts = 0;
  const t = setInterval(async () => {
    if (++attempts > MAX_ATTEMPTS) {
      clearInterval(t); watchTimers.delete(jobId);
      toastErr('Download is taking longer than expected — check Background jobs.');
      return;
    }
    try {
      const { jobs } = await api.get('/api/jobs?limit=50');
      const j = jobs.find(x => x.id === jobId);
      if (!j || (j.status !== 'done' && j.status !== 'error')) return;
      clearInterval(t); watchTimers.delete(jobId);
      if (j.status === 'done' && j.result && j.result.token) consumeDownloadToken(j.result.token);
      else if (j.status === 'error') toastErr('Download failed: ' + (j.message || 'unknown error'));
    } catch (_) { clearInterval(t); watchTimers.delete(jobId); }
  }, 1500);
  watchTimers.set(jobId, t);
}

function globalKeys(e) {
  if (!state.user) return;   // signed out: the shell is gone
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '')) || e.target.isContentEditable;
  if (typing) return;
  if (e.key === 'Escape') { closeMenu(); return; }
  if (view !== 'files' || !pane) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'F5') { e.preventDefault(); pane.refresh(); return; }
  if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); const s = pane.selectedEntries(); if (s.length) { state.clipboard = { mode: 'copy', items: s.map(t => ({ mount: pane.loc.mount, path: t.path, name: t.name, isDir: t.type === 'dir' })) }; toastOk(`Copied ${s.length}`); } return; }
  if (mod && e.key.toLowerCase() === 'x') { e.preventDefault(); const s = pane.selectedEntries(); if (s.length) { state.clipboard = { mode: 'cut', items: s.map(t => ({ mount: pane.loc.mount, path: t.path, name: t.name, isDir: t.type === 'dir' })) }; toastOk(`Cut ${s.length}`); } return; }
  if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteInto(pane); return; }
  if (e.key === 'F2') { e.preventDefault(); renameSelection(pane); return; }
  if (e.key === 'Delete') { e.preventDefault(); deleteSelection(pane); return; }
  if (mod && e.key.toLowerCase() === 'u') { e.preventDefault(); pickUpload(pane); return; }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newFolder(pane); return; }
}
