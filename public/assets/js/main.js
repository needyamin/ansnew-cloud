'use strict';
/*
 * ANSNEW CLOUD SPA entry point.
 * Boots from /api/bootstrap, gates on auth, then builds the desktop-style shell:
 * sidebar (mounts / favorites / recent / tools / admin), topbar actions, tabs,
 * split panes, context menus and the background-job drawer.
 */

import { el, clear, fmtSize, fmtDate } from './util.js';
import { api, setCsrf, clearCache, invalidate, invalidateList } from './api.js';
import {
  state, saveSession, setTheme, setFavorites, isFavorite,
  setSidebarCollapsed, setColumn,
} from './state.js';
import { loadSprite, icon } from './icons.js';
import { toast, toastOk, toastErr, toastWarn, dialog, confirmDialog, promptDialog } from './ui.js';
import { FilesPane } from './filespane.js';
import { isTextEntry } from './editor.js';
import { hasRichPreview } from './preview.js';
import { DetailsPanel } from './details.js';
import { initJobs, openJobs, closeJobs } from './jobs.js';
import {
  fsMkdir, fsCreateFile, fsRename, fsArchive, fsExtract,
  fsDeleteBatch, fsMoveBatch, fsCopyBatch,
  fsList,
  toggleFavorite, trashList, trashRestore, trashPurge, trashEmpty,
} from './fsops.js';
import { runUploadsWithUI } from './uploadtray.js';
import { abortAllUploads } from './upload.js';
import { runOp, joinPath, dirOf, syntheticEntry, reportBatch } from './mutation.js';
import {
  initDownloads, openTray, downloadSelection, downloadEntriesWithProgress,
} from './downloads.js';
import { shareDialog, renderSharesView } from './sharing.js';
import { renderSettings } from './settings.js';
import { renderFavouritesView } from './favview.js';
import { bulkRenameDialog } from './bulkrename.js';
import { clearAllFavorites } from './fsops.js';

const root = document.getElementById('app');

let pane = null;          // primary FilesPane
let pane2 = null;         // secondary pane (split view)
let details = null;       // metadata side panel
let view = 'files';       // files | trash | recent | favourites | shares | settings | admin-users | admin-mounts
let menuNode = null;      // open context menu
let shellNodes = {};      // cached shell DOM refs
let uploadInput = null;
let folderInput = null;
let shellListenersBound = false;

const isAdmin = () => state.user && state.user.role === 'admin';

/* ------------------------------------------------------- navigation tree --
 * Explorer's left pane: This PC, then each drive, then its folders on demand.
 * Child folders are fetched only when a branch is opened, and cached, so
 * re-rendering the sidebar never refetches a subtree.
 */
const navOpen = new Set();     // "mount:path" of expanded branches
const navCache = new Map();    // "mount:path" -> directories

/** Load (once) and cache the subfolders of a directory. */
async function navLoad(mount, path) {
  const key = mount + ':' + path;
  if (navCache.has(key)) return navCache.get(key);
  let dirs = [];
  try {
    const data = await fsList(mount, path, { cacheKey: 'nav:' + key, ttl: 60000 });
    dirs = (data.entries || []).filter((e) => e.type === 'dir');
  } catch (_) {
    dirs = [];
  }
  navCache.set(key, dirs);
  return dirs;
}

/**
 * One expandable branch of the tree.
 * @param {string} mount @param {string} path @param {number} depth
 */
function navBranch(mount, path, depth) {
  const key = mount + ':' + path;
  const box = el('div', { class: 'nav-branch' });

  const paint = () => {
    clear(box);
    if (!navOpen.has(key)) return;
    const dirs = navCache.get(key);
    if (dirs === undefined) {
      box.appendChild(el('div', {
        class: 'nav-loading muted', text: 'Loading…',
        style: 'padding-left:' + (12 + depth * 14) + 'px',
      }));
      return;
    }
    for (const e of dirs) {
      const childKey = mount + ':' + e.path;
      const row = el('div', { class: 'nav-row' });
      const tw = el('button', {
        class: 'nav-tw', title: 'Expand ' + e.name, 'aria-label': 'Expand ' + e.name,
        text: navOpen.has(childKey) ? '▾' : '▸',
      });
      const btn = el('button', {
        class: 'side-item nav-item', title: e.path,
        style: 'padding-left:' + (12 + depth * 14) + 'px',
      }, icon('folder', 'ico'), el('span', { class: 'lbl', text: e.name }));
      btn.addEventListener('click', () => navigateTo(mount, e.path));
      const child = navBranch(mount, e.path, depth + 1);
      tw.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (navOpen.has(childKey)) {
          navOpen.delete(childKey);
        } else {
          navOpen.add(childKey);
          await navLoad(mount, e.path);
        }
        tw.textContent = navOpen.has(childKey) ? '▾' : '▸';
        child.repaint();
      });
      row.append(tw, btn);
      box.append(row, child);
    }
  };

  box.repaint = paint;
  paint();
  return box;
}

/** Preload + remember a branch, used when jumping straight to a deep path. */
function navReveal(mount, path) {
  const parts = path.split('/').filter(Boolean);
  let acc = '';
  for (const part of parts) {
    navOpen.add(mount + ':' + (acc || '/'));
    acc += '/' + part;
  }
}

/* ------------------------------------------------------------- view modes */

const VIEW_MODES = [
  { id: 'details', label: 'Details', icon: 'list' },
  { id: 'list', label: 'List', icon: 'grid' },
  { id: 'icons', label: 'Large icons', icon: 'grid' },
];
const VIEW_ICON = { details: 'list', list: 'grid', icons: 'grid' };

function viewLabel() {
  const m = VIEW_MODES.find((x) => x.id === state.viewMode);
  return m ? m.label : 'Details';
}

function setViewMode(mode, btn) {
  state.viewMode = mode;
  try { localStorage.setItem('ansnew.view', mode); } catch (_) { /* private mode */ }
  if (pane) pane.setView(mode);
  if (pane2) pane2.setView(mode);
  if (btn) {
    btn.replaceChildren(icon(VIEW_ICON[mode] || 'list'));
    btn.title = 'View: ' + viewLabel();
  }
}

/**
 * Admin tables are wider than a phone. Wrapping them in their own scroll box
 * keeps the page itself from scrolling sideways.
 */
function tableWrap(table) {
  return el('div', { class: 'table-wrap' }, table);
}

/* ==================================================================== boot */

(async function boot() {
  setTheme(localStorage.getItem('ansnew.theme') || 'light', false);
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
  // Downloads and the usage figures need to be live from the first frame: a
  // user can open the downloads tray before any navigation happens.
  initDownloads();
  // Usage feeds the sidebar's per-drive size line; repaint once it lands,
  // since the shell is built from the mounts alone. Filesystem capacity
  // (total/used/free) is fetched alongside it.
  Promise.allSettled([loadUsage(), loadDriveInfo()]).finally(repaintSidebar);
  // Mounts/favorites/recent must exist before the sidebar can render, so load
  // them first and only then build the shell.
  refreshSidebarData().finally(() => {
    renderShell();
    // Drive capacity / usage may have landed before the shell existed.
    repaintSidebar();
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
    // A shared/deep link in the URL wins over the default, as long as that
    // mount is actually visible to this user.
    const wanted = locationFromUrl();
    const target = wanted && state.mounts.some(m => m.name === wanted.mount)
      ? wanted
      : { mount: state.mounts[0].name, path: '/' };
    state.tabs.push({ id: 't' + Date.now(), mount: target.mount, path: target.path, history: [], histIdx: -1 });
    state.activeTab = 0;
  }
  showView('files');
}

/* ---------------------------------------------------------------- sidebar */

/** Load per-drive usage (bytes/files/dirs) for the sidebar. */
async function loadUsage() {
  try {
    const r = await api.get('/api/usage');
    state.usageInfo = r.mounts || [];
  } catch (_) {
    /* the sidebar simply shows nothing until a later attempt succeeds */
  }
  return state.usageInfo || [];
}

/** Load per-drive filesystem capacity (total/used/free) for the sidebar. */
async function loadDriveInfo() {
  try {
    const r = await api.get('/api/drives/info');
    state.drivesInfo = r.drives || [];
  } catch (_) {
    /* capacity stays unknown; scan-based figures still show */
  }
  return state.drivesInfo || [];
}

/** Repaint the sidebar if the shell exists yet (no-op during boot). */
function repaintSidebar() {
  if (shellNodes.sidebar && typeof shellNodes.sidebar.render === 'function') {
    shellNodes.sidebar.render();
  }
}

function usageFor(mountName) {
  return (state.usageInfo || []).find((u) => u.mount === mountName) || null;
}

function driveInfoFor(mountName) {
  return (state.drivesInfo || []).find((d) => d.mount === mountName) || null;
}

/**
 * Used / total figures for one drive, for the sidebar.
 *
 * A local drive sits on a real filesystem, so its honest "storage" figure is the
 * filesystem's used/total. A remote drive has no filesystem to measure, so the
 * number comes from the cached usage scan of its own contents (null until one
 * has run).
 *
 * @returns {?{used:number,total:?number,pct:?number,kind:string}}
 */
function driveUsageParts(mountName) {
  const cap = (driveInfoFor(mountName) || {}).capacity || {};
  if (cap.available && typeof cap.used === 'number') {
    return { used: cap.used, total: cap.total, free: cap.free, pct: cap.percent, kind: 'filesystem' };
  }
  // /api/usage returns the raw scan result ({used,files,dirs,scannedAt}) with no
  // `available` flag — unlike /api/drives/info, which wraps it. Treat a numeric
  // `used` as "we have a figure".
  const u = usageFor(mountName);
  const data = u && u.usage;
  if (data && typeof data.used === 'number') {
    const total = u.quotaBytes > 0 ? u.quotaBytes : null;
    return {
      used: data.used, total, kind: 'drive',
      pct: total ? Math.min(100, (data.used / total) * 100) : null,
      // The server flags a snapshot stale as soon as the mount changes; the
      // figure is still shown (no flash to "Not scanned") but is being redone.
      stale: !!data.stale,
    };
  }
  return null;
}

function usageLabel(parts) {
  if (!parts) {
    // Distinguish "still loading" from "this drive has never been scanned".
    return (state.drivesInfo === null && state.usageInfo === null) ? '…' : 'Not scanned';
  }
  const used = fmtSize(parts.used);
  const base = parts.total ? `${used} / ${fmtSize(parts.total)}` : `${used} used`;
  return parts.stale ? `${base} · updating` : base;
}

/** Is the cached figure for this mount flagged stale (contents changed)? */
function usageIsStale(mountName) {
  const u = usageFor(mountName);
  return !!(u && u.usage && u.usage.stale);
}

/**
 * Make sure a drive's usage figure exists and is current.
 *
 * A local drive's figure comes from the filesystem, so it is always live. A
 * remote drive's figure is a cached scan, so it needs one scan to exist at all
 * and a fresh one whenever the server flags it stale after a mutation. The scan
 * runs in the worker, so poll briefly for the result.
 *
 * @param {boolean} force re-scan even if the cached figure looks current
 */
const usageScanPending = new Set();
async function ensureDriveUsage(mountName, force = false) {
  const parts = driveUsageParts(mountName);
  if (parts && parts.kind === 'filesystem') return;   // live figure, nothing to do
  const stale = usageIsStale(mountName);
  if (!force && !stale && parts) return;              // cached figure is current
  if (usageScanPending.has(mountName)) return;
  usageScanPending.add(mountName);
  try {
    await api.post(`/api/usage/${encodeURIComponent(mountName)}/scan`, {});
    // Poll for the worker to write the fresh figure. Stop as soon as the server
    // stops flagging it stale (or we run out of patience).
    for (let i = 0; i < 8; i++) {
      await new Promise((res) => setTimeout(res, 1500));
      await loadUsage();
      repaintSidebar();
      if (driveUsageParts(mountName) && !usageIsStale(mountName)) break;
    }
  } catch (_) {
    /* leave the row as-is; the user can retry from This PC */
  } finally {
    usageScanPending.delete(mountName);
  }
}

/**
 * A mutation just changed one or more mounts. The server flags their cached
 * usage stale and queues a re-scan, so refresh our copy and pull in the new
 * figure. Debounced: one batch operation emits a burst of fs.changed events.
 */
let usageRefreshTimer = null;
const usageRefreshQueue = new Set();


function buildSidebar() {
  const sb = el('div', { class: 'sidebar' });

  /** Icon-only rail. The class is a no-op under the drawer breakpoint. */
  const collapseBtn = el('button', {
    class: 'btn icon sm only-wide sidebar-toggle',
    title: 'Collapse sidebar (Ctrl+B)',
    'aria-label': 'Collapse sidebar',
    'aria-expanded': 'true',
  }, icon('panel'));

  const applyCollapsed = () => {
    sb.classList.toggle('collapsed', state.sidebarCollapsed);
    const label = state.sidebarCollapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)';
    collapseBtn.title = label;
    collapseBtn.setAttribute('aria-label', label);
    collapseBtn.setAttribute('aria-expanded', state.sidebarCollapsed ? 'false' : 'true');
  };
  const toggleCollapse = () => {
    setSidebarCollapsed(!state.sidebarCollapsed);
    applyCollapsed();
  };
  collapseBtn.addEventListener('click', toggleCollapse);
  sb.toggleCollapse = toggleCollapse;

  const head = el('div', { class: 'side-head' },
    icon('drive'),
    el('span', { class: 'brand', text: 'ANSNEW CLOUD' }),
    collapseBtn,
  );
  sb.appendChild(head);

  // One delegated listener closes the overlay drawer whenever a sidebar entry
  // navigates — cheaper and less error-prone than patching every click handler.
  sb.addEventListener('click', (e) => { if (e.target.closest('.side-item')) closeDrawer(); });

  // Mount buttons are tracked so the active highlight can be updated without
  // rebuilding the whole sidebar.
  const mountButtons = new Map();

  const render = () => {
    clear(sb);
    mountButtons.clear();
    sb.appendChild(head);
    applyCollapsed();

    sb.appendChild(el('div', { class: 'side-sec' }, 'This PC'));
    const pcBtn = el('button', {
      class: 'side-item' + (view === 'thispc' ? ' active' : ''),
      title: 'Drives and capacity',
    }, icon('pc', 'ico'), el('span', { class: 'lbl', text: 'This PC' }));
    pcBtn.addEventListener('click', () => showView('thispc'));
    sb.appendChild(pcBtn);

    if (!state.mounts.length) {
      sb.appendChild(el('div', { class: 'side-item' }, el('span', { class: 'lbl muted', text: 'No drives configured' })));
    }
    for (const m of state.mounts) {
      const active = view === 'files' && pane && pane.loc.mount === m.name;
      const parts = driveUsageParts(m.name);
      const pct = parts && parts.pct !== null && parts.pct !== undefined
        ? Math.max(0, Math.min(100, Math.round(parts.pct)))
        : null;
      const usage = el('span', { class: 'usage' + (parts && parts.stale ? ' stale' : '') },
        el('span', { class: 'usage-txt', text: usageLabel(parts) }),
        pct !== null ? el('span', { class: 'usage-bar' }, el('i', { style: 'width:' + pct + '%' })) : null,
      );
      const btn = el('button', {
        class: 'side-item' + (active ? ' active' : ''),
        title: parts
          ? `${m.label}\n${usageLabel(parts)}${parts.kind === 'filesystem' && typeof parts.free === 'number' ? ' · ' + fmtSize(parts.free) + ' free' : ''}${parts.kind === 'filesystem' ? ' (whole filesystem)' : ''}`
          : `${m.label}\nUsage not scanned yet`,
      },
        icon('drive', 'ico'),
        el('span', { class: 'side-meta' },
          el('span', { class: 'lbl', text: m.label }),
          usage,
        ),
      );
      btn.addEventListener('click', () => navigateTo(m.name, '/'));
      mountButtons.set(m.name, btn);
      sb.appendChild(btn);
      // Expandable folder tree below each drive, loaded on demand.
      sb.appendChild(navBranch(m.name, '/', 0));
    }

    const favs = state.favorites || [];
    // "All" opens the full page (the sidebar truncates at six); "Clear" empties
    // the whole list behind a password. Both only make sense when there is
    // something pinned, so they disappear with the list.
    const favHead = el('div', { class: 'side-sec side-sec-row' }, 'Favorites');
    if (favs.length) {
      const all = el('button', { class: 'link-btn', title: 'Show all favourites', text: 'All' });
      all.addEventListener('click', (e) => { e.stopPropagation(); showView('favourites'); });
      const clear = el('button', { class: 'link-btn', title: 'Remove every favourite', text: 'Clear' });
      clear.addEventListener('click', (e) => { e.stopPropagation(); clearAllFavourites(); });
      favHead.append(all, clear);
    }
    sb.appendChild(favHead);
    if (!favs.length) {
      sb.appendChild(el('div', { class: 'side-item' }, el('span', { class: 'lbl muted', text: 'Nothing pinned yet' })));
    }
    for (const f of favs) {
      const isDir = f.type === 'dir';
      const btn = el('button', {
        class: 'side-item',
        title: `${f.label || f.path}\n${f.mount}:${f.path}\n${isDir ? 'Folder' : 'File'} — right-click for options`,
      },
        icon(isDir ? 'folder' : 'star', 'ico'),
        el('span', { class: 'lbl', text: f.label || f.path }));
      // A pinned FILE must not be opened as a folder: that produced
      // "Operation failed: Not a directory". Instead open its folder and
      // highlight the file, exactly like a search result.
      btn.addEventListener('click', () => openFavourite(f));
      // Right-click gives a way out without having to find the item again.
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, [
          { label: 'Open', icon: isDir ? 'folder' : 'file', onClick: () => openFavourite(f) },
          {
            label: 'Remove from favourites', icon: 'star', danger: true,
            onClick: async () => {
              try {
                await toggleFavorite(f.mount, f.path, f.label);
                invalidate('favorites');
                await refreshSidebarData();
              } catch (err) { toastErr(err.message); }
            },
          },
        ]);
      });
      sb.appendChild(btn);
    }

    const recent = state.recent || [];
    const recentHead = el('div', { class: 'side-sec side-sec-row' }, 'Recent');
    if (recent.length) {
      const more = el('button', { class: 'link-btn', title: 'Show all recent items', text: 'All' });
      more.addEventListener('click', (e) => { e.stopPropagation(); showView('recent'); });
      recentHead.appendChild(more);
    }
    sb.appendChild(recentHead);
    if (!recent.length) {
      sb.appendChild(el('div', { class: 'side-item' }, el('span', { class: 'lbl muted', text: 'No recent files' })));
    }
    for (const r of recent.slice(0, 6)) {
      const btn = el('button', {
        class: 'side-item',
        title: `${r.name || r.path}\n${r.mount}:${r.path}\n${recentActionLabel(r.action)} · ${fmtDate(sqlDateToUnix(r.at))}`,
      },
        icon(recentIcon(r), 'ico'),
        el('span', { class: 'lbl', text: r.name || r.path }));
      btn.addEventListener('click', () => openRecent(r));
      sb.appendChild(btn);
    }

    sb.appendChild(el('div', { class: 'side-sec' }, 'Tools'));
    // `title` matters when the sidebar is collapsed to an icon rail.
    const mkTool = (ico, label, fn) => {
      const b = el('button', { class: 'side-item', title: label },
        icon(ico, 'ico'), el('span', { class: 'lbl', text: label }));
      b.addEventListener('click', fn);
      return b;
    };
    sb.appendChild(mkTool('share', 'Shared links', () => showView('shares')));
    sb.appendChild(mkTool('settings', 'Settings', () => showView('settings')));
    sb.appendChild(mkTool('clock', 'Recent', () => showView('recent')));
    sb.appendChild(mkTool('trash', 'Trash', () => showView('trash')));
    sb.appendChild(mkTool('job', 'Background jobs', () => openJobs()));
    sb.appendChild(mkTool('info', 'Storage usage', () => usageDialog()));

    if (isAdmin()) {
      sb.appendChild(el('div', { class: 'side-sec' }, 'Administration'));
      sb.appendChild(mkTool('users', 'Users', () => showView('admin-users')));
      sb.appendChild(mkTool('plug', 'Mounts', () => showView('admin-mounts')));
      sb.appendChild(mkTool('ext', 'Connections', () => showView('admin-connections')));
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
 * Open a pinned favourite.
 *
 * Folders navigate straight there. Files open the folder that contains them and
 * then select the file — navigating to the file path itself fails with
 * "Not a directory", which is what this used to do.
 */
/**
 * Remove every favourite.
 */
async function clearAllFavourites() {
  const favs = state.favorites || [];
  if (!favs.length) return;
  const ok = await confirmDialog(
    `Remove all ${favs.length} favourite(s)? Your files are not affected, but the whole list is cleared and cannot be restored.`,
    { title: 'Remove all favourites', danger: true, okLabel: 'Remove all' },
  );
  if (!ok) return;
  await clearAllFavorites();
  setFavorites([]);
  invalidate('favorites');
  toastOk('All favourites removed');
  await refreshSidebarData();
  if (view === 'favourites') showView('favourites');
}

function openFavourite(f) {
  if (!f) return;
  if (f.type === 'dir') { navigateTo(f.mount, f.path); return; }
  navigateTo(f.mount, dirOf(f.path));
  revealEntryWhenReady(f.mount, f.path, 14);
}

/**
 * Jump the active tab to a location. Every sidebar entry used to call
 * showView('files') — which built a brand-new pane and fetched the directory —
 * and then immediately navigate it again, so one click cost two listings.
 */
function navigateTo(mount, path) {
  const tab = currentTab();
  if (tab) { tab.mount = mount; tab.path = path; tab.history = []; tab.histIdx = -1; }
  // First visit to a drive that has never been measured: kick off a usage scan
  // so its size can show up in the sidebar (no-op once a figure exists).
  ensureDriveUsage(mount);
  if (view === 'files' && pane) { pane.navigate(mount, path); return; }
  showView('files');   // builds a pane already pointed at tab.mount/tab.path
}

/* ------------------------------------------------------- shareable URLs */

/**
 * Keep the address bar in step with the open folder, so reloading (or sending
 * the URL to someone) lands back on the same place.
 *
 * Uses the query string rather than a path prefix: it works with any server
 * configuration, including one that only routes `/` to the app.
 */
function syncUrl(loc, mode = 'push') {
  if (!loc || !loc.mount) return;
  const url = new URL(window.location.href);
  url.searchParams.set('mount', loc.mount);
  url.searchParams.set('path', loc.path);
  // A stale view parameter would put the reload somewhere unexpected.
  url.searchParams.delete('view');
  const next = url.pathname + url.search;
  if (next === window.location.pathname + window.location.search) return;
  try {
    if (mode === 'replace') window.history.replaceState(state.historyState ?? null, '', next);
    else window.history.pushState(state.historyState ?? null, '', next);
    state.historyState = { mount: loc.mount, path: loc.path };
  } catch (_) { /* history can be unavailable in odd embedding contexts */ }
}

/** Where should the app open? The URL wins over the saved session. */
function locationFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const mount = params.get('mount');
    const path = params.get('path');
    if (mount && typeof path === 'string' && path.startsWith('/')) {
      return { mount, path };
    }
  } catch (_) { /* malformed URL — fall through to the default */ }
  return null;
}

// Back/forward moves the folder, without pushing another entry.
window.addEventListener('popstate', () => {
  const loc = locationFromUrl();
  if (loc && state.user && view === 'files') navigateTo(loc.mount, loc.path);
});

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
  tb.appendChild(wide(mk('download', 'Downloads', () => openTray())));

  const writableDrive = canDo('create', currentMountInfo());
  if (writableDrive) {
    tb.appendChild(el('span', { class: 'only-wide', style: 'width:8px' }));
    tb.appendChild(wide(mk('plus', 'New folder', () => newFolder())));
    tb.appendChild(wide(mk('edit', 'New file', () => newFile())));

    const up = el('button', { class: 'btn', title: 'Upload files (Ctrl+U)' }, icon('up'), el('span', { class: 'lbl', text: 'Upload' }));
    up.addEventListener('click', () => pickUpload());
    tb.appendChild(up);

    const upFolder = mk('folder-plus', 'Upload a whole folder (keeps its structure)', () => pickUploadFolder());
    tb.appendChild(wide(upFolder));
  }

  tb.appendChild(el('span', { class: 'spacer' }));

  const viewBtn = mk(VIEW_ICON[state.viewMode] || 'list', 'View: ' + viewLabel(), () => {
    const r = viewBtn.getBoundingClientRect();
    openMenu(r.right - 220, r.bottom + 6, VIEW_MODES.map((m) => ({
      label: m.label + (state.viewMode === m.id ? '  ✓' : ''),
      icon: m.icon,
      onClick: () => setViewMode(m.id, viewBtn),
    })));
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

  // Narrow screens collapse the secondary controls into one menu rather than
  // clipping them off the end of the bar.
  const more = mk('grid', 'More actions', () => {
    const r = more.getBoundingClientRect();
    openMenu(r.right - 210, r.bottom + 6, [
      { label: 'New folder', icon: 'plus', onClick: () => newFolder() },
      { label: 'New file', icon: 'edit', onClick: () => newFile() },
      { sep: true },
      { label: 'View: ' + viewLabel(), icon: VIEW_ICON[state.viewMode] || 'list', onClick: () => viewBtn.click() },
      { label: 'Toggle split pane', icon: 'split', onClick: () => splitBtn.click() },
      { label: 'Background jobs', icon: 'job', onClick: () => jobsBtn.click() },
      { label: 'Downloads', icon: 'download', onClick: () => openTray() },
      { label: 'Toggle details panel', icon: 'info', onClick: () => detailsBtn.click() },
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
      {
        label: 'Reload app data', icon: 'refresh',
        onClick: () => {
          // A reload that served cached values would not be a reload.
          invalidate('mounts');
          invalidate('favorites');
          invalidate('recent');
          invalidate('list:');
          refreshSidebarData();
          repaintPanes();
        },
      },
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
  else if (name === 'recent') renderRecent(c);
  else if (name === 'favourites') renderFavouritesView(c, {
    onOpen: (f) => openFavourite(f),
    onChanged: async () => { await refreshSidebarData(); },
  });
  else if (name === 'shares') renderSharesView(c, { onChanged: () => {} });
  else if (name === 'settings') renderSettings(c, { onChangePassword: changePassword, onOpenView: (v) => showView(v) });
  else if (name === 'admin-users') renderAdminUsers(c);
  else if (name === 'admin-mounts') renderAdminMounts(c);
  else if (name === 'admin-connections') renderAdminConnections(c);
  else if (name === 'thispc') renderThisPc(c);
}

/* ------------------------------------------------------- This PC / drives */

/** Drives overview (the "This PC" sidebar entry). Lists every mount the user
 * can see with its type and usage, and opens a drive into a tab. */
async function renderThisPc(c) {
  const page = el('div', { class: 'admin-page' }, el('h2', {}, 'This PC'));
  page.appendChild(el('p', { class: 'muted', text:
    'Every drive available to your account. Local drives report the host filesystem\u2019s ' +
    'total / used / available; remote drives (S3 / R2, added later from Connections) show ' +
    'their own scanned usage.' }));

  await Promise.allSettled([loadDriveInfo(), loadUsage()]);
  const table = el('table', { class: 'table' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Drive'), el('th', {}, 'Type'),
      el('th', {}, 'Used'), el('th', {}, 'Available'), el('th', {}, 'Total'),
      el('th', { class: 'actions' }, 'Actions'))),
  );
  const tbody = el('tbody');
  for (const m of state.mounts) {
    const parts = driveUsageParts(m.name);
    const isFs = !!parts && parts.kind === 'filesystem';
    const tr = el('tr', {},
      el('td', {}, icon('drive', 'ico'), el('span', { class: 'drive-name', text: m.label || m.name })),
      el('td', {}, el('span', { class: 'badge', text: m.adapter === 's3' ? 'S3 / R2' : 'Local' })),
      el('td', { class: 'muted', text: parts ? fmtSize(parts.used) : '\u2014' }),
      el('td', { class: 'muted', text: isFs && typeof parts.free === 'number' ? fmtSize(parts.free) : '\u2014' }),
      el('td', { class: 'muted', text: parts && parts.total ? fmtSize(parts.total) : '\u2014' }),
    );
    const actions = el('td', { class: 'actions' });
    const open = el('button', { class: 'btn' }, 'Open');
    open.addEventListener('click', () => navigateTo(m.name, '/'));
    actions.appendChild(open);
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  page.appendChild(tableWrap(table));
  if (!state.mounts.length) {
    page.appendChild(el('div', { class: 'empty-hint', text: 'No drives configured yet.' }));
  }
  c.appendChild(page);
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
    onToggleFavorite: (entry, p) => { if (p) toggleFavouriteFor(p, entry); },
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
    // Navigating always lands on a directory, so the type is known here even
    // though there is no listing entry to hand over.
    recordRecent(loc.mount, loc.path,
      { name: loc.path.split('/').filter(Boolean).pop() || loc.mount, type: 'dir' }, 'open');
    // Keep the address bar useful: reload lands on the same folder.
    syncUrl(loc, 'push');
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
  p.onToggleFavorite = (inst, entry) => toggleFavouriteFor(inst, entry);
  p.onColumnsMenu = (e) => columnsMenu(e, p);
  p.onBulkRename = (inst, entries) => runBulkRename(inst, entries);
  p.onOpenEntry = (inst, entry) => {
    // Navigating into a folder is already recorded by onNavigate.
    if (entry.type !== 'dir') recordRecent(inst.loc.mount, entry.path, entry, 'preview');
  };
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
const recentSeen = new Map();   // key -> timestamp

/**
 * Record something in the Recent list.
 *
 * @param {string} mount
 * @param {string} path
 * @param {object|null} entry   listing entry, when we have one (for metadata)
 * @param {string} action       open | preview | download | upload | create
 */
export function recordRecent(mount, path, entry = null, action = 'open') {
  if (!mount || !path || path === '/') return;
  const key = `${mount}:${path}:${action}`;
  const now = Date.now();
  // Collapse repeats of the same action within a minute; the server also
  // upserts per path, so the list stays a list of places, not of events.
  const seen = recentSeen.get(key);
  if (seen && now - seen < 60000) return;
  recentSeen.set(key, now);
  if (recentSeen.size > 200) {
    for (const [k, t] of recentSeen) if (now - t > 600000) recentSeen.delete(k);
  }

  const name = (entry && entry.name) || path.split('/').filter(Boolean).pop() || path;
  clearTimeout(recentTimer);
  recentTimer = setTimeout(() => {
    api.post('/api/recent', {
      mount,
      path,
      name,
      action,
      type: entry && entry.type === 'dir' ? 'dir' : 'file',
      modifiedAt: (entry && entry.mtime) || 0,
      size: (entry && entry.size) || 0,
    }).then(() => invalidate('recent')).catch(() => { /* non-critical */ });
  }, 1200);
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

/**
 * Can the current user do `cap` on this drive? Reads the capability map the
 * server publishes with every mount, so the UI never has to guess.
 *
 * Module scope on purpose: the context menu and the toolbar both need it, and a
 * helper declared inside renderFiles() is invisible to the menu builder.
 */
function canDo(cap, mountInfo) {
  const caps = mountInfo?.capabilities;
  if (!caps) return true;          // unknown mount: let the server decide
  return caps[cap] !== false;
}

/** The mount info for the drive the toolbar currently acts on. */
function currentMountInfo() {
  const tab = currentTab();
  return (state.mounts || []).find(m => m.name === (tab ? tab.mount : '')) || null;
}

/**
 * Drop menu items the account is not allowed to perform, so a read-only drive
 * shows a menu that only offers what will actually work.
 * `cap` on an item names the capability it needs; separators are always kept.
 */
function withCaps(items, mountInfo) {
  const caps = mountInfo?.capabilities;
  if (!caps) return items;
  return items.filter((it) => it.sep || !it.cap || caps[it.cap] !== false);
}

function entryMenu(e, entry, inst) {
  const sel = inst.selectedEntries();
  const many = sel.length > 1;
  const target = many ? sel : [entry];
  const anyDir = target.some(t => t.type === 'dir');
  const onlyFiles = target.every(t => t.type !== 'dir');
  const writable = canDo('write', inst.mountInfo);

  const items = [];
  if (!many) {
    // Text/code files open in the built-in editor, so the label says so — but
    // Markdown/office files get a rendered preview instead, so those say
    // "Preview".
    const editHere = isTextEntry(entry) && !hasRichPreview(entry);
    const openLabel = entry.type === 'dir' ? 'Open' : (editHere ? 'Edit' : 'Preview');
    items.push({ label: openLabel, icon: entry.type === 'dir' ? 'folder' : (editHere ? 'edit' : 'file'), onClick: () => inst.open(entry) });
    if (entry.type !== 'dir') {
      items.push({
        label: 'Download', icon: 'download',
        onClick: () => {
          downloadEntriesWithProgress(inst.loc.mount, [entry]);
          recordRecent(inst.loc.mount, entry.path, entry, 'download');
        },
      });
    } else {
      items.push({
        label: 'Download as ZIP', icon: 'download',
        onClick: () => { downloadSelection(inst.loc.mount, [entry.path], entry.name + '.zip'); openTray(); },
      });
    }
    items.push({ sep: true });
  }
  items.push(
    { label: many ? `Download ${target.length} items` : 'Download', icon: 'download', onClick: () => downloadEntriesWithProgress(inst.loc.mount, target) },
    { label: 'Copy', icon: 'copy', onClick: () => stageClipboard(inst, target, 'copy') },
    { label: 'Cut', icon: 'cut', cap: 'write', disabled: !writable, onClick: () => stageClipboard(inst, target, 'cut') },
    { sep: true },
    { label: 'Rename', icon: 'edit', cap: 'rename', disabled: many || !writable, onClick: () => renameEntry(inst, entry) },
    { label: `Rename ${target.length} items…`, icon: 'edit', cap: 'rename', disabled: !many || !writable, onClick: () => runBulkRename(inst, target) },
    { label: 'Compress to ZIP', icon: 'archive', cap: 'create', onClick: () => compress(inst, target) },
    { label: 'Extract here', icon: 'archive', cap: 'create', disabled: many || entry.type === 'dir', onClick: () => extract(inst, entry) },
    {
      // Reflect the actual state — this used to always read "Add to favorites",
      // so clicking it on a favourited item silently removed it.
      label: isFavorite(inst.loc.mount, entry.path) ? 'Remove from favourites' : 'Add to favourites',
      icon: isFavorite(inst.loc.mount, entry.path) ? 'star' : 'star-outline',
      disabled: many,
      onClick: () => toggleFavouriteFor(inst, entry),
    },
    { sep: true },
    { label: 'Properties', icon: 'info', disabled: many, onClick: () => entryProperties(inst, entry) },
    { label: 'Share…', icon: 'share', disabled: many, onClick: () => shareDialog({ mount: inst.loc.mount, path: entry.path, name: entry.name, type: entry.type }) },
    { label: 'Delete', icon: 'trash', cap: 'delete', danger: true, disabled: !writable, onClick: () => deleteEntries(inst, target) },
  );
  openMenu(e.clientX, e.clientY, withCaps(items, inst.mountInfo));
}

function backgroundMenu(e, inst) {
  const items = [
    { label: 'New folder', icon: 'plus', cap: 'create', onClick: () => newFolder(inst) },
    { label: 'New file', icon: 'edit', cap: 'create', onClick: () => newFile(inst) },
    { label: 'Upload files…', icon: 'up', cap: 'create', onClick: () => pickUpload(inst) },
    { label: 'Upload folder…', icon: 'folder-plus', cap: 'create', onClick: () => pickUploadFolder(inst) },
    { sep: true },
    { label: 'Paste', icon: 'paste', cap: 'create', disabled: !state.clipboard, onClick: () => pasteInto(inst) },
    { sep: true },
    { label: 'Refresh', icon: 'refresh', onClick: () => inst.refresh() },
    { label: 'Select all', icon: 'check', onClick: () => inst.selectAll() },
  ];
  openMenu(e.clientX, e.clientY, withCaps(items, inst.mountInfo));
}

/* ------------------------------------------------------------- file actions */

async function newFolder(inst = pane) {
  if (!inst) return;
  const name = await promptDialog('Folder name', '', { title: 'New folder', okLabel: 'Create' });
  if (!name) return;
  const mount = inst.loc.mount;
  const dir = inst.loc.path;
  const created = joinPath(dir, name);
  await runOp({
    pane: inst,
    // The row appears before the request is even sent.
    patch: () => ({ add: [syntheticEntry(created, name, 'dir')] }),
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
  const created = joinPath(dir, name);
  await runOp({
    pane: inst,
    patch: () => ({ add: [syntheticEntry(created, name, 'file')] }),
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
  const res = await runOp({
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

/** Right-click the list header to choose which columns are visible. */
function columnsMenu(e, inst) {
  const cols = [
    ['size', 'Size'],
    ['mtime', 'Modified'],
    ['owner', 'Owner'],
  ];
  openMenu(e.clientX, e.clientY, [
    ...cols.map(([key, label]) => ({
      label: `${state.cols[key] ? 'Hide' : 'Show'} ${label}`,
      icon: state.cols[key] ? 'check' : 'info',
      onClick: () => {
        setColumn(key, !state.cols[key]);
        if (inst) inst.syncColumns();
        // Force a repaint so every visible row picks up the new visibility.
        if (inst) { inst.viewDirty = true; inst.render(); }
      },
    })),
  ]);
}

/** Bulk-rename the current selection. */
function runBulkRename(inst, entries) {
  if (!inst) return;
  const sel = entries && entries.length ? entries : inst.selectedEntries();
  if (sel.length < 2) { toastWarn('Select at least two items to rename'); return; }
  const siblings = inst.entries
    .filter((e) => !sel.some((s) => s.path === e.path))
    .map((e) => e.name);
  bulkRenameDialog({
    mount: inst.loc.mount,
    entries: sel,
    siblingNames: siblings,
    onDone: () => inst.refresh(),
  });
}

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
  if (!res) return;

  reportBatch(res, { verb: 'Deleted', openJobs });
  inst.scheduleRevalidate(700);
}

/* ------------------------------------------- selection-bar / drag-drop actions */

/**
 * Download a selection.
 *
 * Files stream straight out with progress; folders and mixed selections are
 * packed into one zip on the server first, and the tray follows that job.
 */
function downloadEntries(inst, entries) {
  if (!entries || !entries.length) return;
  downloadEntriesWithProgress(inst.loc.mount, entries);
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
  if (res) {
    inst.scheduleRevalidate(700);
  }
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
    uploadInput = el('input', { type: 'file', multiple: true, class: 'upload-input', style: 'display:none' });
    document.body.appendChild(uploadInput);
  }
  uploadInput.onchange = () => {
    const files = [...uploadInput.files];
    uploadInput.value = '';
    if (!files.length) return;
    startUpload(files, inst, null);
  };
  uploadInput.click();
}

/**
 * Pick a whole folder. `webkitdirectory` makes the browser hand over every file
 * beneath it together with a relative path, which is what lets the server
 * recreate the nested structure.
 */
function pickUploadFolder(inst = pane) {
  if (!inst) return;
  if (!folderInput) {
    folderInput = el('input', {
      type: 'file', multiple: true, webkitdirectory: 'true', directory: 'true',
      class: 'folder-input', style: 'display:none',
    });
    document.body.appendChild(folderInput);
  }
  folderInput.onchange = () => {
    const files = [...folderInput.files];
    folderInput.value = '';
    if (!files.length) return;
    startUpload(files, inst, (f) => f.webkitRelativePath || f.name);
  };
  folderInput.click();
}

/**
 * Upload a batch into the pane's current folder.
 *
 * @param {File[]} files
 * @param {FilesPane} inst
 * @param {?Function} relPathFor  returns the path relative to the chosen folder
 */
function startUpload(files, inst, relPathFor) {
  const mount = inst.loc.mount;
  const dir = inst.loc.path;
  const folderCount = relPathFor
    ? new Set(files.map((f) => String(relPathFor(f)).split('/').slice(0, -1).join('/')).filter(Boolean)).size
    : 0;
  if (folderCount) toast(`Uploading ${files.length} file(s) in ${folderCount} folder(s)…`, 'info');

  // Hand over the pane so the incoming files show up immediately; the promise
  // resolves with the files the server actually created.
  return runUploadsWithUI(files, mount, dir, 'rename', inst, relPathFor ? { relPathFor } : {})
    .then((results) => {
      for (const r of results || []) recordRecent(mount, r.path, { name: r.name, size: r.size }, 'upload');
      return results;
    });
}

/* ---------------------------------------------------------- recent browser */

/** Icon that reflects what the user did with the item. */
function recentIcon(r) {
  switch (r.action) {
    case 'download': return 'download';
    case 'upload': return 'up';
    case 'create': return 'plus';
    case 'preview': return r.type === 'dir' ? 'folder' : 'file';
    default: return r.type === 'dir' ? 'folder' : 'clock';
  }
}

function recentActionLabel(action) {
  switch (action) {
    case 'download': return 'Downloaded';
    case 'upload': return 'Uploaded';
    case 'create': return 'Created';
    case 'preview': return 'Opened';
    default: return 'Visited';
  }
}

/** SQLite stores `datetime('now')` as "YYYY-MM-DD HH:MM:SS" in UTC. */
function sqlDateToUnix(value) {
  if (!value) return 0;
  const ms = Date.parse(String(value).replace(' ', 'T') + 'Z');
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/**
 * Open a recent item. Folders navigate straight there; files open their
 * containing folder, then select and scroll to the file so the user can see
 * where it lives.
 */
function openRecent(r) {
  if (!r) return;
  if (r.type === 'dir') { navigateTo(r.mount, r.path); return; }
  navigateTo(r.mount, dirOf(r.path));
  revealEntryWhenReady(r.mount, r.path, 14);
}

function revealEntryWhenReady(mount, path, tries) {
  const p = pane;
  if (!p || p.destroyed || p.loc.mount !== mount) return;
  const entry = p.entryByPath(path);
  if (entry) {
    p.selectOnly(entry);
    const idx = p.indexByPath.get(path);
    if (idx !== undefined) p.scrollToIndex(idx);
    return;
  }
  if (tries > 0) setTimeout(() => revealEntryWhenReady(mount, path, tries - 1), 250);
}

async function renderRecent(c) {
  const page = el('div', { class: 'admin-page' }, el('h2', {}, 'Recent'));
  const toolbar = el('div', { class: 'admin-toolbar' });
  const clearBtn = el('button', { class: 'btn danger' }, icon('trash'), 'Clear recent list');
  clearBtn.addEventListener('click', async () => {
    const ok = await confirmDialog('Clear your entire recent list? This only affects this list, not your files.',
      { title: 'Clear recent', danger: true, okLabel: 'Clear list' });
    if (!ok) return;
    try {
      await api.delete('/api/recent');
      invalidate('recent');
      state.recent = [];
      toastOk('Recent list cleared');
      if (shellNodes.sidebar && shellNodes.sidebar.render) shellNodes.sidebar.render();
      showView('recent');
    } catch (e) { toastErr(e.message); }
  });
  toolbar.appendChild(clearBtn);
  page.appendChild(toolbar);

  let items = [];
  try {
    const r = await api.get('/api/recent?limit=100', { cacheKey: 'recent-all', ttl: 10000 });
    items = r.recent || [];
  } catch (e) { toastErr(e.message); }

  if (!items.length) {
    page.appendChild(el('div', { class: 'empty-state' },
      icon('clock', 'empty-ico'),
      el('div', { class: 'empty-title', text: 'Nothing recent yet' }),
      el('div', { class: 'empty-sub muted', text: 'Files and folders you open, upload or download will show up here.' }),
    ));
    c.appendChild(page);
    return;
  }

  const table = el('table', { class: 'table' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Name'),
      el('th', {}, 'Type'),
      el('th', {}, 'Drive'),
      el('th', {}, 'Action'),
      el('th', {}, 'Modified'),
      el('th', {}, 'Last used'),
    )),
  );
  const tbody = el('tbody');
  for (const r of items) {
    const open = el('button', { class: 'link-btn', text: r.name || r.path, title: r.path });
    open.addEventListener('click', () => openRecent(r));
    const row = el('tr', {},
      el('td', {}, icon(recentIcon(r), 'ico'), open),
      el('td', { class: 'muted', text: r.type === 'dir' ? 'Folder' : 'File' }),
      el('td', { class: 'muted', text: mountLabel(r.mount) }),
      el('td', { class: 'muted', text: recentActionLabel(r.action) }),
      el('td', { class: 'muted', text: r.modified_at ? fmtDate(Number(r.modified_at)) : '—' }),
      el('td', { class: 'muted', text: fmtDate(sqlDateToUnix(r.at)) }),
    );
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  page.appendChild(tableWrap(table));
  c.appendChild(page);
}

/** Friendly name for a mount slug. */
function mountLabel(name) {
  const m = (state.mounts || []).find((x) => x.name === name);
  return m ? (m.label || m.name) : name;
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
    let emptied = 0;
    for (const m of state.mounts) {
      try { await trashEmpty(m.name); emptied++; } catch (_) { /* mount may not have trash */ }
    }
    if (emptied) toastOk('Trash emptied');
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

/* ---------------------------------------------------- admin: connections */

async function renderAdminConnections(c) {
  const page = el('div', { class: 'admin-page' }, el('h2', {}, 'S3 / R2 connections'));
  const bar = el('div', { class: 'admin-toolbar' });
  const add = el('button', { class: 'btn primary' }, icon('plus'), 'New connection');
  add.addEventListener('click', () => connectionDialog(() => showView('admin-connections')));
  bar.appendChild(add);
  page.appendChild(bar);
  page.appendChild(el('p', { class: 'muted', text:
    'Any S3-compatible store: AWS S3, Cloudflare R2, MinIO, Wasabi, Backblaze B2. ' +
    'Credentials are encrypted at rest and never sent back to the browser.' }));

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
      el('th', {}, 'Name'), el('th', {}, 'Endpoint'), el('th', {}, 'Bucket'),
      el('th', {}, 'Region'), el('th', {}, 'Access key'), el('th', { class: 'actions' }, 'Actions'))),
  );
  const tbody = el('tbody');
  for (const cn of data.connections) {
    const tr = el('tr', {},
      el('td', {}, cn.name),
      el('td', { class: 'muted', text: `${cn.host}:${cn.port}` }),
      el('td', {}, cn.bucket || '—'),
      el('td', { class: 'muted', text: cn.region || '—' }),
      el('td', { class: 'muted', text: cn.username || '—' }),
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
      const ok = await confirmDialog(`Delete connection "${cn.name}"? Any drive using it will stop working.`, { title: 'Delete connection', danger: true, okLabel: 'Delete' });
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
  const name = el('input', { type: 'text', placeholder: 'r2-main' });
  const endpoint = el('input', { type: 'text', placeholder: 'https://<account>.r2.cloudflarestorage.com' });
  const bucket = el('input', { type: 'text', placeholder: 'my-bucket' });
  const region = el('input', { type: 'text', value: 'auto', placeholder: 'auto / us-east-1' });
  const accessKeyId = el('input', { type: 'text', placeholder: 'Access key id', autocomplete: 'off' });
  const secretAccessKey = el('input', { type: 'password', placeholder: 'Secret access key', autocomplete: 'off' });
  const pathStyle = el('input', { type: 'checkbox' });
  pathStyle.checked = true;
  const remoteBase = el('input', { type: 'text', value: '/' });

  dialog({
    title: 'New S3 / R2 connection',
    body: [
      el('label', { class: 'field' }, 'Name', name),
      el('label', { class: 'field' }, 'Endpoint URL (scheme + host, port optional)', endpoint),
      el('label', { class: 'field' }, 'Bucket', bucket),
      el('label', { class: 'field' }, 'Region (R2 uses "auto")', region),
      el('label', { class: 'field' }, 'Access key id', accessKeyId),
      el('label', { class: 'field' }, 'Secret access key (stored encrypted)', secretAccessKey),
      el('label', { class: 'checkbox' }, pathStyle, 'Path-style URLs (on for R2 / MinIO, off for AWS)'),
      el('label', { class: 'field' }, 'Base path inside the bucket', remoteBase),
    ],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Create', kind: 'primary', primary: true,
        onClick: async () => {
          try {
            // The scheme on the endpoint decides TLS verification: https ->
            // verify (AWS/R2), http -> plain (LAN MinIO, test endpoints).
            const ep = endpoint.value.trim();
            const verifyTls = !/^http:\/\//i.test(ep);
            await api.post('/api/admin/connections', {
              name: name.value.trim(), protocol: 's3',
              endpoint: ep, bucket: bucket.value.trim(),
              region: region.value.trim() || 'auto',
              accessKeyId: accessKeyId.value.trim(), secretAccessKey: secretAccessKey.value,
              pathStyle: pathStyle.checked, remoteBase: remoteBase.value.trim() || '/',
              verifyTls,
            });
            toastOk('Connection created');
            onDone ? onDone() : showView('admin-connections');
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
    ...['local', 's3'].map(a => el('option', { value: a, text: a === 's3' ? 'S3 / R2 (remote)' : 'local (encrypted)' })));
  adapter.value = m ? m.adapter : 'local';
  const localRoot = el('input', { type: 'text', value: m && m.local_root ? m.local_root : '', placeholder: '/srv/storage/local' });
  const connectionId = el('input', { type: 'number', min: '1', placeholder: 'Connection id (see Connections)' });
  if (m && m.connection_id) connectionId.value = String(m.connection_id);
  const remotePath = el('input', { type: 'text', value: m ? (m.remote_path || '/') : '/', placeholder: '/' });

  const body = [
    el('label', { class: 'field' }, 'Name (slug used by the API)', name),
    el('label', { class: 'field' }, 'Label', label),
    el('label', { class: 'field' }, 'Adapter', adapter),
    el('label', { class: 'field' }, 'Local root (local adapter only)', localRoot),
    el('label', { class: 'field' }, 'Connection id (S3/R2 only)', connectionId),
    el('label', { class: 'field' }, 'Remote path (S3/R2 only)', remotePath),
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
                connectionId: Number(connectionId.value) || 0,
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

/* ------------------------------------------------------- misc / utilities */

async function refreshSidebarData() {
  try {
    const [m, f, r] = await Promise.all([
      api.get('/api/mounts', { cacheKey: 'mounts', ttl: 30000 }),
      api.get('/api/favorites', { cacheKey: 'favorites', ttl: 30000 }),
      api.get('/api/recent?limit=8', { cacheKey: 'recent', ttl: 30000 }),
    ]);
    state.mounts = m.mounts || [];
    setFavorites(f.favorites || []);     // also rebuilds the favouriteKeys lookup
    state.recent = r.recent || [];
    if (shellNodes.sidebar && shellNodes.sidebar.render) shellNodes.sidebar.render();
    // Favourite state is drawn on the rows, so they need repainting too.
    repaintPanes();
  } catch (_) { /* ignore */ }
}

/** Re-apply row decorations (favourite stars, pending/failed) to every pane. */
function repaintPanes() {
  for (const p of state.panes) p.refreshDecorations();
}

/** A drive was added, renamed or disconnected — rebuild the sidebar + tabs. */
async function onDrivesChanged() {
  // Drop the cached sidebar data first: without this the refresh below would be
  // served from the 30s mount cache and the new drive would not appear.
  invalidate('mounts');
  await refreshSidebarData();
  // If the active tab pointed at a drive that just disappeared, fall back.
  const tab = currentTab();
  if (tab && !state.mounts.some(m => m.name === tab.mount)) {
    if (state.mounts.length) {
      tab.mount = state.mounts[0].name;
      tab.path = '/';
      tab.history = [];
      tab.histIdx = -1;
      if (view === 'files') renderFiles();
    }
  }
  renderTabs();
}

/**
 * Toggle a favourite and make every surface agree: the row star, the details
 * panel, and the sidebar list. Previously only the sidebar was refreshed, so
 * the button the user just clicked kept its old appearance.
 */
async function toggleFavouriteFor(inst, entry) {
  const mount = inst ? inst.loc.mount : '';
  if (!mount || !entry) return;
  try {
    await toggleFavorite(mount, entry.path, entry.name, entry.type);
  } catch (e) {
    toastErr(e.message);
    return;
  }
  repaintPanes();
  if (details) details.update(inst);
  if (shellNodes.sidebar && shellNodes.sidebar.render) shellNodes.sidebar.render();
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

/* ------------------------------------------------------- This PC / drives */

/** Back / forward through the active tab's history (Alt+Left, Alt+Right). */
function goHistory(delta) {
  const tab = currentTab();
  if (!tab || !tab.history || !tab.history.length) return;
  const i = tab.histIdx + delta;
  if (i < 0 || i > tab.history.length - 1) return;
  const loc = tab.history[i];
  tab.histIdx = i;
  if (pane) pane.navigate(loc.mount, loc.path, false);
  renderTabs();
}

/** Properties for one file or folder. Folders measure their total contents
 * size via /du (recursive) and fill the Size row when the walk finishes. */
async function entryProperties(inst, entry) {
  let stat = entry;
  try {
    stat = await api.get(
      `/api/fs/${encodeURIComponent(inst.loc.mount)}/stat?path=${encodeURIComponent(entry.path)}`,
    ) || entry;
  } catch (_) { /* the listing row is good enough */ }

  const row = (k, v) => el('div', { class: 'prop-row' },
    el('span', { class: 'prop-k muted', text: k }),
    el('span', { class: 'prop-v', text: v === null || v === undefined || v === '' ? '—' : String(v) }));

  const isDir = entry.type === 'dir';
  const sizeVal = el('span', {
    class: 'prop-v' + (isDir ? ' muted' : ''),
    text: isDir ? 'Calculating…' : fmtSize(stat.size ?? entry.size),
  });
  const sizeRow = el('div', { class: 'prop-row' },
    el('span', { class: 'prop-k muted', text: 'Size' }), sizeVal);

  dialog({
    title: entry.name + ' Properties',
    body: [
      row('Name', entry.name),
      row('Type', isDir ? 'Folder' : (stat.mime || (entry.extension ? entry.extension.toUpperCase() + ' file' : 'File'))),
      sizeRow,
      row('Modified', fmtDate(stat.mtime ?? entry.mtime)),
      row('Location', `${inst.mountInfo?.label || inst.loc.mount}:${dirOf(entry.path)}`),
      row('Permissions', stat.mode || stat.perms || '—'),
      row('Owner', stat.owner || '—'),
    ],
    buttons: [{ label: 'Close' }],
  });

  if (isDir) {
    try {
      const d = await api.get(
        `/api/fs/${encodeURIComponent(inst.loc.mount)}/du?path=${encodeURIComponent(entry.path)}`,
      );
      const parts = [fmtSize(d?.used ?? 0)];
      if (typeof d?.files === 'number') parts.push(`${d.files} file${d.files === 1 ? '' : 's'}`);
      if (typeof d?.dirs === 'number') parts.push(`${d.dirs} folder${d.dirs === 1 ? '' : 's'}`);
      sizeVal.textContent = parts.join(' · ');
      sizeVal.classList.remove('muted');
    } catch (e) {
      sizeVal.textContent = 'Could not measure (' + (e && e.message ? e.message : 'error') + ')';
    }
  }
}

function globalKeys(e) {
  if (!state.user) return;   // signed out: the shell is gone
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '')) || e.target.isContentEditable;
  if (typing) return;
  if (e.key === 'Escape') { closeMenu(); return; }
  if (view !== 'files' || !pane) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'F5') { e.preventDefault(); pane.refresh(); return; }
  // Ctrl+L / Alt+D: type a path, like Explorer's address bar.
  if ((mod && e.key.toLowerCase() === 'l') || (e.altKey && e.key.toLowerCase() === 'd')) {
    e.preventDefault();
    if (pane) pane.editAddress();
    return;
  }
  // Alt+Left / Alt+Right: back and forward through this tab's history.
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goHistory(-1); return; }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goHistory(1); return; }
  if (mod && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    if (shellNodes.sidebar && shellNodes.sidebar.toggleCollapse) shellNodes.sidebar.toggleCollapse();
    return;
  }
  if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); const s = pane.selectedEntries(); if (s.length) { state.clipboard = { mode: 'copy', items: s.map(t => ({ mount: pane.loc.mount, path: t.path, name: t.name, isDir: t.type === 'dir' })) }; toastOk(`Copied ${s.length}`); } return; }
  if (mod && e.key.toLowerCase() === 'x') { e.preventDefault(); const s = pane.selectedEntries(); if (s.length) { state.clipboard = { mode: 'cut', items: s.map(t => ({ mount: pane.loc.mount, path: t.path, name: t.name, isDir: t.type === 'dir' })) }; toastOk(`Cut ${s.length}`); } return; }
  if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteInto(pane); return; }
  if (e.key === 'F2') { e.preventDefault(); renameSelection(pane); return; }
  if (e.key === 'Delete') { e.preventDefault(); deleteSelection(pane); return; }
  if (mod && e.key.toLowerCase() === 'u') { e.preventDefault(); pickUpload(pane); return; }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newFolder(pane); return; }
}
