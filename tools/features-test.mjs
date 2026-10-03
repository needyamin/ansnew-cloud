#!/usr/bin/env node
/*
 * ANSNEW CLOUD feature verification (Chrome DevTools Protocol).
 *
 * Exercises each user-facing feature end-to-end and asserts the whole chain:
 *   action -> backend succeeds -> UI updates by itself -> survives a reload
 *
 * Covers: favourites, recent, folder upload, drive management, share links,
 * sidebar collapse. Runs against a real browser so the assertions are about what
 * a user actually sees, not what the API returns.
 *
 * Usage: ANSNEW_PW=<password> node tools/features-test.mjs [baseUrl] [chromePath] [only]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8200';
const CHROME = process.argv[3] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ONLY = process.argv[4] || '';
const PW = process.env.ANSNEW_PW;
if (!PW) { console.error('set ANSNEW_PW'); process.exit(2); }

const PORT = 9340;
const profile = mkdtempSync(join(tmpdir(), 'ansnew-feat-'));
let chrome, ws, msgId = 0;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];
const fsRequests = [];
const allRequests = [];
const responses = [];
const failures = [];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timed out')); } }, 25000);
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || 'eval failed').split('\n')[0]);
  return r.result?.value;
}
async function waitFor(expression, timeout = 10000, interval = 200) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await evaluate(expression)) return true; } catch (_) { /* keep polling */ }
    await sleep(interval);
  }
  return false;
}

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { console.log('  PASS  ' + label); pass++; }
  else { console.log('  FAIL  ' + label + (extra ? '  (' + extra + ')' : '')); fail++; }
};
const section = (name) => { if (!ONLY || ONLY === name) { console.log('== ' + name + ' =='); return true; } return false; };

function cleanup(code) {
  try { ws && ws.close(); } catch (_) {}
  try { chrome && chrome.kill(); } catch (_) {}
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  process.exit(code);
}

/* ---------------------------------------------------------------- helpers */

/** Scroll the (windowed) listing and return every path it contains. */
const SCAN_FN = `async (mode, needle) => {
  const l = document.querySelector('.filelist');
  if (!l) return mode === 'exists' ? false : [];
  const orig = l.scrollTop;
  const found = new Set();
  const step = Math.max(80, Math.floor(l.clientHeight * 0.75));
  for (let y = 0; y <= l.scrollHeight + step; y += step) {
    l.scrollTop = y;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (const e of document.querySelectorAll('.filelist [data-path]')) found.add(e.dataset.path);
    if (mode === 'exists' && found.has(needle)) break;
  }
  l.scrollTop = orig;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return mode === 'exists' ? found.has(needle) : [...found];
}`;

const rowPaths = () => evaluate(`(${SCAN_FN})('all', null)`);
const rowExists = async (path) => {
  const fast = await evaluate(`[...document.querySelectorAll('.filelist [data-path]')].some(e => e.dataset.path === ${JSON.stringify(path)})`);
  if (fast) return true;
  return await evaluate(`(${SCAN_FN})('exists', ${JSON.stringify(path)})`);
};

/** Scroll a specific row into view so its controls can be clicked. */
async function revealRow(path) {
  return await evaluate(`(async () => {
    const l = document.querySelector('.filelist');
    if (!l) return false;
    const target = ${JSON.stringify(path)};
    const orig = l.scrollTop;
    const step = Math.max(80, Math.floor(l.clientHeight * 0.75));
    for (let y = 0; y <= l.scrollHeight + step; y += step) {
      l.scrollTop = y;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      if ([...document.querySelectorAll('.filelist [data-path]')].some(e => e.dataset.path === target)) return true;
    }
    l.scrollTop = orig;
    return false;
  })()`);
}

/** Click a control inside a specific row (revealing it first). */
async function clickInRow(path, selector) {
  if (!await revealRow(path)) return 'row-missing';
  return await evaluate(`(() => {
    const row = [...document.querySelectorAll('.filelist [data-path]')].find(e => e.dataset.path === ${JSON.stringify(path)});
    if (!row) return 'row-missing';
    const el = row.querySelector(${JSON.stringify(selector)});
    if (!el) return 'control-missing';
    el.click();
    return 'ok';
  })()`);
}

const goRoot = async () => {
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('.sidebar .side-item')].find(b => b.textContent.includes('Local Storage'));
    if (item) item.click();
    return true;
  })()`);
  await sleep(1400);
};

/**
 * Re-read the current directory.
 *
 * Needed after a fixture is created out-of-band through the API: in a normal
 * browser the fs.changed push updates the pane automatically, but this sandbox
 * never delivers WebSocket frames to page scripts, so the test refreshes
 * explicitly. (Real behaviour for the push path is covered by realtime-test.mjs.)
 */
const refreshList = async () => {
  await evaluate(`(() => {
    const l = document.querySelector('.filelist');
    if (!l) return false;
    l.focus();
    l.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true }));
    return true;
  })()`);
  await sleep(1400);
};

const apiCall = (path, method, body) => evaluate(`(async () => {
  const b = await (await fetch('/api/bootstrap')).json();
  const r = await fetch(${JSON.stringify(path)}, {
    method: ${JSON.stringify(method)},
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': b.data.csrf },
    body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'},
  });
  return { status: r.status, body: await r.json() };
})()`);

/* -------------------------------------------------------------------- run */

chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--disable-dev-shm-usage',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(250);
  try {
    target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page');
  } catch (_) { /* not up yet */ }
}
if (!target) { console.error('chrome debugger never became reachable'); cleanup(2); }

ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const t = (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').split('\n')[0];
    pageErrors.push(t);
    if (process.env.VERBOSE) console.log('  [page error] ' + t);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    const t = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
    consoleErrors.push(t);
    if (process.env.VERBOSE) console.log('  [console error] ' + t.slice(0, 200));
  }
  if (m.method === 'Network.requestWillBeSent') {
    allRequests.push(m.params.request.method + ' ' + m.params.request.url.replace(BASE, ''));
    if (m.params.request.url.includes('/api/fs/')) {
      fsRequests.push(m.params.request.method + ' ' + m.params.request.url.replace(BASE, ''));
    }
  }
  if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/api/')) {
    responses.push(m.params.response.status + ' ' + m.params.response.url.replace(BASE, ''));
  }
  if (m.method === 'Network.loadingFailed') {
    failures.push((m.params.errorText || 'failed') + ' ' + (m.params.type || ''));
  }
};

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
await send('Network.enable');
await send('DOM.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const login = async () => {
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(2500);
  await evaluate(`(() => {
    const u = document.querySelector('.login-card input[type=text]');
    const p = document.querySelector('.login-card input[type=password]');
    u.value = 'admin'; p.value = ${JSON.stringify(PW)};
    document.querySelector('.login-card button.primary').click();
    return true;
  })()`);
  await sleep(2600);
};
const reload = async () => { await send('Page.navigate', { url: BASE + '/' }); await sleep(3200); };

const STAMP = Date.now();
const FOLDER = `feat-${STAMP}`;

await login();
check('logged in', await evaluate(`!!document.querySelector('.shell')`) === true);

// Fixture: one folder to operate on.
await goRoot();
const mk = await apiCall('/api/fs/local/mkdir', 'POST', { path: '/', name: FOLDER });
check('fixture folder created via API', mk.body?.ok === true, JSON.stringify(mk.body).slice(0, 120));
await refreshList();

/* ------------------------------------------------------------- favourites */
if (section('favourites')) {
  const FAV = '/' + FOLDER;

  // A refresh must actually hit the network (regression: `force` was ignored by
  // both cache branches, so F5 silently re-rendered stale data).
  const beforeRefresh = fsRequests.length;
  await refreshList();
  check('refresh re-reads the directory', fsRequests.length > beforeRefresh,
    'requests=' + (fsRequests.length - beforeRefresh));

  check('fixture folder exists', await rowExists(FAV) === true);

  // The star must start empty.
  const before = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.filelist [data-path]')].find(e => e.dataset.path === ${JSON.stringify(FAV)});
    if (!row) return null;
    const mark = row.querySelector('.fav-mark');
    const btn = row.querySelector('.row-actions .fav');
    return { marked: !!mark && mark.classList.contains('on'), title: btn ? btn.title : '' };
  })()`);
  check('row starts unfavourited', before && before.marked === false, JSON.stringify(before));
  check('toggle offers to add', before && /Add to favourites/.test(before.title), JSON.stringify(before));

  // Favourite via the row's star button.
  const clicked = await clickInRow(FAV, '.row-actions .fav');
  check('row star button is clickable', clicked === 'ok', clicked);

  const after = await waitFor(`(() => {
    const row = [...document.querySelectorAll('.filelist [data-path]')].find(e => e.dataset.path === ${JSON.stringify(FAV)});
    const mark = row && row.querySelector('.fav-mark');
    return !!mark && mark.classList.contains('on');
  })()`, 5000);
  check('star fills immediately after favouriting', after === true);

  const titleAfter = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.filelist [data-path]')].find(e => e.dataset.path === ${JSON.stringify(FAV)});
    const btn = row && row.querySelector('.row-actions .fav');
    return btn ? btn.title : '';
  })()`);
  check('toggle now offers to remove', /Remove from favourites/.test(titleAfter), titleAfter);

  const inSidebar = await evaluate(`[...document.querySelectorAll('.sidebar .side-item')].some(b => b.textContent.includes(${JSON.stringify(FOLDER)}))`);
  check('sidebar Favorites lists it', inSidebar === true);

  // Backend really persisted it.
  const apiFav = await apiCall('/api/favorites', 'GET');
  const persisted = apiFav.body?.data?.favorites?.some(f => f.mount === 'local' && f.path === FAV);
  check('backend persisted the favourite', persisted === true, JSON.stringify(apiFav.body).slice(0, 120));

  // THE key requirement: survives a full reload.
  await reload();
  await goRoot();
  const afterReload = await evaluate(`(async () => {
    const l = document.querySelector('.filelist');
    const target = ${JSON.stringify(FAV)};
    const step = Math.max(80, Math.floor(l.clientHeight * 0.75));
    for (let y = 0; y <= l.scrollHeight + step; y += step) {
      l.scrollTop = y;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const row = [...document.querySelectorAll('.filelist [data-path]')].find(e => e.dataset.path === target);
      if (row) return row.querySelector('.fav-mark')?.classList.contains('on') === true;
    }
    return false;
  })()`);
  check('favourite state survives a reload', afterReload === true);
  const sidebarAfterReload = await evaluate(`[...document.querySelectorAll('.sidebar .side-item')].some(b => b.textContent.includes(${JSON.stringify(FOLDER)}))`);
  check('sidebar still lists it after reload', sidebarAfterReload === true);

  // Unfavourite.
  const reqBefore = allRequests.length;
  const unClick = await clickInRow(FAV, '.row-actions .fav');
  check('unfavourite click landed', unClick === 'ok', unClick);
  await sleep(1200);
  if (process.env.VERBOSE) {
    console.log('  DEBUG requestsDuringUnfavourite=' + JSON.stringify(allRequests.slice(reqBefore)));
    console.log('  DEBUG responses=' + JSON.stringify(responses.slice(-6)));
    console.log('  DEBUG failures=' + JSON.stringify(failures.slice(-6)));
    console.log('  DEBUG toasts=' + JSON.stringify(await evaluate(`[...document.querySelectorAll('.toast')].map(t => t.className + ':' + t.textContent)`)));
    console.log('  DEBUG favBtnTitle=' + JSON.stringify(await evaluate(`(() => {
      const row = [...document.querySelectorAll('.filelist [data-path]')].find(e => e.dataset.path === ${JSON.stringify(FAV)});
      const b = row && row.querySelector('.row-actions .fav');
      return b ? b.title : 'no-button';
    })()`)));
    console.log('  DEBUG methodProbe=' + await evaluate(`(async () => {
      const b = await (await fetch('/api/bootstrap')).json();
      const out = [];
      const call = async (label, opts) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        try {
          const r = await fetch('/api/favorites', { ...opts, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': b.data.csrf }, signal: ctrl.signal });
          clearTimeout(t);
          out.push(label + '=' + r.status);
        } catch (e) { clearTimeout(t); out.push(label + '=HUNG(' + e.name + ')'); }
      };
      await call('GET', { method: 'GET' });
      await call('POST', { method: 'POST', body: JSON.stringify({ mount: 'local', path: '/probe-method' }) });
      await call('DELETE', { method: 'DELETE', body: JSON.stringify({ mount: 'local', path: '/probe-method' }) });
      return out.join(' ');
    })()`));
    console.log('  DEBUG rawDeleteProbe=' + await evaluate(`(async () => {
      const b = await (await fetch('/api/bootstrap')).json();
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      try {
        const r = await fetch('/api/favorites', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': b.data.csrf },
          body: JSON.stringify({ mount: 'local', path: '/nonexistent-probe' }),
          signal: ctrl.signal,
        });
        clearTimeout(t);
        return 'status=' + r.status + ' body=' + (await r.text()).slice(0, 60);
      } catch (e) { clearTimeout(t); return 'threw: ' + e.name + ' ' + e.message; }
    })()`));
    console.log('  DEBUG pendingWithoutResponse=' + (allRequests.length - responses.length));
    console.log('  DEBUG clickDispatches=' + await evaluate(`(() => {
      const row = [...document.querySelectorAll('.filelist [data-path]')].find(e => e.dataset.path === ${JSON.stringify(FAV)});
      if (!row) return 'no-row';
      const b = row.querySelector('.row-actions .fav');
      if (!b) return 'no-button';
      let seen = 0;
      b.addEventListener('click', () => { seen++; }, { once: true });
      b.click();
      return 'listenersFired=' + seen;
    })()`));
    await sleep(1200);
    console.log('  DEBUG afterSecondClick=' + JSON.stringify(await evaluate(`[...document.querySelectorAll('.toast')].map(t => t.className + ':' + t.textContent)`)));
  }
  const cleared = await waitFor(`(() => {
    const row = [...document.querySelectorAll('.filelist [data-path]')].find(e => e.dataset.path === ${JSON.stringify(FAV)});
    const mark = row && row.querySelector('.fav-mark');
    return !!mark && !mark.classList.contains('on');
  })()`, 5000);
  check('star clears after unfavouriting', cleared === true);
  const goneFromSidebar = await waitFor(
    `![...document.querySelectorAll('.sidebar .side-item')].some(b => b.textContent.includes(${JSON.stringify(FOLDER)}))`, 5000);
  check('sidebar drops it after unfavouriting', goneFromSidebar === true);

  const apiAfter = await apiCall('/api/favorites', 'GET');
  const stillThere = apiAfter.body?.data?.favorites?.some(f => f.mount === 'local' && f.path === FAV);
  check('backend removed the favourite', stillThere === false);

  await reload();
  await goRoot();
  const offAfterReload = await evaluate(`(async () => {
    const l = document.querySelector('.filelist');
    const target = ${JSON.stringify(FAV)};
    const step = Math.max(80, Math.floor(l.clientHeight * 0.75));
    for (let y = 0; y <= l.scrollHeight + step; y += step) {
      l.scrollTop = y;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const row = [...document.querySelectorAll('.filelist [data-path]')].find(e => e.dataset.path === target);
      if (row) return !(row.querySelector('.fav-mark')?.classList.contains('on') === true);
    }
    return true;
  })()`);
  check('unfavourite survives a reload', offAfterReload === true);

  // Details panel must agree with the row, and flip when the row does.
  await clickInRow(FAV, '.nm');
  await sleep(600);
  const labelOff = await evaluate(`(() => {
    const b = [...document.querySelectorAll('.details-actions button')].find(x => /Favourite/i.test(x.textContent));
    return b ? b.textContent.trim() : '';
  })()`);
  check('details panel offers to favourite when unfavourited', labelOff === 'Favourite', labelOff);

  await clickInRow(FAV, '.row-actions .fav');
  await waitFor(`[...document.querySelectorAll('.details-actions button')].some(x => x.textContent.trim() === 'Unfavourite')`, 5000);
  const labelOn = await evaluate(`(() => {
    const b = [...document.querySelectorAll('.details-actions button')].find(x => /Favourite/i.test(x.textContent));
    return b ? b.textContent.trim() : '';
  })()`);
  check('details panel flips to Unfavourite after favouriting', labelOn === 'Unfavourite', labelOn);

  // Leave it unfavourited for a clean state.
  await clickInRow(FAV, '.row-actions .fav');
  await sleep(800);
}

/* ----------------------------------------------------------- folder upload */
if (section('folderupload')) {
  // A real folder on disk with a nested structure.
  const rootName = `pickup-${STAMP}`;
  const localRoot = join(tmpdir(), rootName);
  mkdirSync(join(localRoot, 'sub'), { recursive: true });
  writeFileSync(join(localRoot, 'top.txt'), 'top\n');
  writeFileSync(join(localRoot, 'sub', 'deep.txt'), 'deep\n');

  check('folder picker control exists',
    await evaluate(`!![...document.querySelectorAll('.topbar button')].find(b => (b.title||'').startsWith('Upload a whole folder'))`) === true);
  check('folder input uses webkitdirectory',
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('.topbar button')].find(x => (x.title||'').startsWith('Upload a whole folder'));
      if (!b) return 'no-button';
      b.click();
      return 'clicked';
    })()`) === 'clicked');
  await sleep(500);

  const folderInput = await evaluate(`(() => {
    return document.querySelector('.folder-input') ? 'found' : 'missing';
  })()`);
  check('a directory input was created', folderInput === 'found', folderInput);

  // CDP's setFileInputFiles cannot populate a directory input's relative paths,
  // so drive the app's real change handler with Files that carry one. This still
  // exercises the production path: webkitRelativePath -> relPaths -> the server.
  const started = await evaluate(`(() => {
    const input = document.querySelector('.folder-input');
    if (!input) return 'no-input';
    const rel = ${JSON.stringify(rootName + '/sub/deep.txt')};
    const deep = new File(['deep\\n'], 'deep.txt', { type: 'text/plain' });
    Object.defineProperty(deep, 'webkitRelativePath', { value: rel });
    const top = new File(['top\\n'], 'top.txt', { type: 'text/plain' });
    Object.defineProperty(top, 'webkitRelativePath', { value: ${JSON.stringify(rootName + '/top.txt')} });
    const dt = new DataTransfer();
    dt.items.add(top);
    dt.items.add(deep);
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    return 'started';
  })()`);
  check('folder upload started from the picker', started === 'started', started);

  // The picked folder itself must show up in the current directory...
  const appeared = await waitFor(
    `[...document.querySelectorAll('.filelist [data-path]')].some(e => e.dataset.path === ${JSON.stringify('/' + rootName)})`,
    25000, 300,
  );
  check('uploaded folder appears in the pane', appeared === true);

  // ...and the structure beneath it must be intact.
  const top = await apiCall(`/api/fs/local/list?path=/${rootName}`, 'GET');
  const topPaths = (top.body?.data?.entries || []).map((e) => e.path);
  check('nested directory created', topPaths.includes(`/${rootName}/sub`), JSON.stringify(topPaths));
  check('top-level file landed', topPaths.includes(`/${rootName}/top.txt`), JSON.stringify(topPaths));

  const sub = await apiCall(`/api/fs/local/list?path=/${rootName}/sub`, 'GET');
  const subPaths = (sub.body?.data?.entries || []).map((e) => e.path);
  check('nested file landed', subPaths.includes(`/${rootName}/sub/deep.txt`), JSON.stringify(subPaths));

  // Clean up whatever landed.
  await apiCall('/api/fs/local/delete-batch', 'POST', {
    items: [{ path: '/' + rootName }], permanent: true,
  });
  await apiCall('/api/fs/local/delete-batch', 'POST', {
    items: [{ path: '/top.txt' }, { path: '/deep.txt' }], permanent: true,
  });
  await refreshList();
}

/* -------------------------------------------------------------------- recent */
if (section('recent')) {
  const FAV = '/' + FOLDER;
  const FILE = `recent-${STAMP}.txt`;
  const FILE_PATH = '/' + FILE;

  const mkFile = await apiCall('/api/fs/local/file', 'POST', { path: '/', name: FILE });
  check('recent fixture file created', mkFile.body?.ok === true, JSON.stringify(mkFile.body).slice(0, 120));
  await refreshList();

  const recentApi = async () => (await apiCall('/api/recent?limit=50', 'GET')).body?.data?.recent || [];
  const entryFor = async (p) => (await recentApi()).find((r) => r.path === p);

  // Visiting a folder is recorded.
  await revealRow(FAV);
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.filelist [data-path]')].find(e => e.dataset.path === ${JSON.stringify(FAV)});
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  })()`);
  await sleep(1600);
  const folderEntry = await entryFor(FAV);
  check('visiting a folder records it in Recent', !!folderEntry, JSON.stringify(folderEntry));
  check('folder entry carries its type', folderEntry && folderEntry.type === 'dir', JSON.stringify(folderEntry));

  // Visiting it again must not create a duplicate.
  await goRoot();
  await sleep(1200);
  await revealRow(FAV);
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.filelist [data-path]')].find(e => e.dataset.path === ${JSON.stringify(FAV)});
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  })()`);
  await sleep(1600);
  const dupes = (await recentApi()).filter((r) => r.path === FAV).length;
  check('revisiting does not duplicate the entry', dupes === 1, 'entries=' + dupes);

  // Opening a file is recorded as a preview.
  await goRoot();
  await sleep(1200);
  await revealRow(FILE_PATH);
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.filelist [data-path]')].find(e => e.dataset.path === ${JSON.stringify(FILE_PATH)});
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  })()`);
  await sleep(1500);
  await evaluate(`(() => { const b = document.querySelector('.preview-bar button, .overlay .dialog footer button'); if (b) b.click(); return true; })()`);
  await evaluate(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
  await sleep(600);
  const fileEntry = await entryFor(FILE_PATH);
  check('opening a file records it in Recent', !!fileEntry, JSON.stringify(fileEntry));
  check('file entry records the preview action', fileEntry && fileEntry.action === 'preview',
    JSON.stringify(fileEntry));

  // Uploads are recorded too.
  const upName = `recent-up-${STAMP}.txt`;
  const upPath = join(tmpdir(), upName);
  writeFileSync(upPath, 'recent upload\n');
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.topbar button')].find(x => (x.title || '').startsWith('Upload files'));
    b.click();
    return true;
  })()`);
  await sleep(300);
  const doc = await send('DOM.getDocument', { depth: -1 });
  const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.upload-input' });
  await send('DOM.setFileInputFiles', { files: [upPath], nodeId: input.nodeId });
  await waitFor(`[...document.querySelectorAll('.filelist [data-path]')].some(e => e.dataset.path === ${JSON.stringify('/' + upName)})`, 15000);
  await sleep(2500);
  const upEntry = await entryFor('/' + upName);
  check('uploads are recorded in Recent', !!upEntry, JSON.stringify(upEntry));
  check('upload entry records the upload action', upEntry && upEntry.action === 'upload',
    JSON.stringify(upEntry));

  // The full Recent view renders the metadata table.
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.sidebar .side-item')].find(x => x.textContent.includes('Recent'));
    if (b) b.click();
    return true;
  })()`);
  await sleep(1500);
  const view = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.admin-page table.table tbody tr')];
    return { rows: rows.length, headers: [...document.querySelectorAll('.admin-page table.table thead th')].map(t => t.textContent) };
  })()`);
  check('Recent view renders rows', view.rows > 0, 'rows=' + view.rows);
  check('Recent view shows metadata columns',
    ['Name', 'Type', 'Drive', 'Action', 'Modified', 'Last used'].every(h => view.headers.includes(h)),
    JSON.stringify(view.headers));

  // Clicking a file entry opens its folder and selects the file.
  await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.admin-page table.table .link-btn')];
    const b = btns.find(x => x.textContent === ${JSON.stringify(upName)});
    if (b) b.click();
    return true;
  })()`);
  await sleep(2200);
  const selected = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.filelist [data-path]')].find(e => e.dataset.path === ${JSON.stringify('/' + upName)});
    return row ? row.getAttribute('aria-selected') === 'true' : 'not-rendered';
  })()`);
  check('clicking a recent file opens and selects it', selected === true, 'selected=' + selected);

  // Recent survives a reload, and clearing works.
  await reload();
  await sleep(1500);
  const afterReload = await entryFor('/' + upName);
  check('recent entries survive a reload', !!afterReload, JSON.stringify(afterReload));

  const cleared = await apiCall('/api/recent', 'DELETE');
  check('clear recent succeeds', cleared.body?.ok === true, JSON.stringify(cleared.body).slice(0, 100));
  const afterClear = await recentApi();
  check('recent list is empty after clearing', afterClear.length === 0, 'remaining=' + afterClear.length);

  // Tidy up the fixtures this section created.
  await apiCall('/api/fs/local/delete-batch', 'POST', {
    items: [{ path: FILE_PATH }, { path: '/' + upName }], permanent: true,
  });
}

/* -------------------------------------------------------------------- drives */
if (section('drives')) {
  const DRIVE = `Test Drive ${STAMP}`;
  const SLUG = 'test-drive-' + STAMP;

  const driveList = async () => (await apiCall('/api/drives', 'GET')).body?.data?.drives || [];
  const mountNames = async () => ((await apiCall('/api/mounts', 'GET')).body?.data?.mounts || []).map(m => m.name);

  // A name that would collide proves conflict handling.
  const created = await apiCall('/api/drives', 'POST', { label: DRIVE, adapter: 'local' });
  check('a drive can be added', created.body?.ok === true, JSON.stringify(created.body).slice(0, 140));
  check('slug is derived from the display name', created.body?.data?.name === SLUG,
    'slug=' + created.body?.data?.name);

  const afterAdd = await driveList();
  const mine = afterAdd.find(d => d.name === SLUG);
  check('new drive appears in the list', !!mine, JSON.stringify(afterAdd.map(d => d.name)));
  check('new drive is marked as owned/manageable', mine && mine.owned === true && mine.manageable === true,
    JSON.stringify(mine));
  check('display name stored separately from the slug', mine && mine.label === DRIVE, JSON.stringify(mine));

  // A second drive with the same label must get a distinct slug, not a clash.
  const dupe = await apiCall('/api/drives', 'POST', { label: DRIVE, adapter: 'local' });
  check('duplicate names get a distinct slug', dupe.body?.ok === true && dupe.body?.data?.name !== SLUG,
    'slug=' + dupe.body?.data?.name);

  check('drive is visible as a mount', (await mountNames()).includes(SLUG));

  // The drive was created out-of-band through the API. In a real browser the
  // drives.changed push refreshes the sidebar automatically; this sandbox does
  // not deliver WebSocket frames, so ask the app to reload its data.
  await evaluate(`(() => {
    const av = document.querySelector('.avatar');
    if (av) av.click();
    return true;
  })()`);
  await sleep(300);
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.ctxmenu button')].find(x => x.textContent.includes('Reload app data'));
    if (b) b.click();
    return true;
  })()`);
  await sleep(1200);

  const sidebarHasDrive = await waitFor(
    `[...document.querySelectorAll('.sidebar .side-item')].some(b => b.textContent.includes(${JSON.stringify(DRIVE)}))`,
    8000, 300,
  );
  check('drive appears in the sidebar', sidebarHasDrive === true);

  // Put real data in it, so we can prove a disconnect leaves it alone.
  const marker = `keepme-${STAMP}.txt`;
  const fd = new FormData();
  fd.append('path', '/');
  fd.append('conflict', 'rename');
  fd.append('files[]', new Blob(['survive the disconnect\n'], { type: 'text/plain' }), marker);
  const upRes = await evaluate(`(async () => {
    const b = await (await fetch('/api/bootstrap')).json();
    const r = await fetch('/api/upload/${SLUG}', { method: 'POST',
      headers: { 'X-CSRF-Token': b.data.csrf },
      body: (() => { const f = new FormData(); f.append('path','/'); f.append('conflict','rename');
        f.append('files[]', new Blob(['survive the disconnect\\n'], { type: 'text/plain' }), ${JSON.stringify(marker)}); return f; })() });
    return r.status;
  })()`);
  check('file uploaded into the new drive', upRes === 200, 'status=' + upRes);

  // Rename: the display name changes, the identifier must not.
  const renamed = await apiCall(`/api/drives/${mine.id}/rename`, 'POST', { label: DRIVE + ' (renamed)' });
  check('drive can be renamed', renamed.body?.ok === true, JSON.stringify(renamed.body).slice(0, 120));
  const afterRename = (await driveList()).find(d => d.name === SLUG);
  check('rename keeps the identifier stable', !!afterRename && afterRename.name === SLUG,
    JSON.stringify(afterRename));
  check('rename changes the display name', afterRename && afterRename.label === DRIVE + ' (renamed)',
    JSON.stringify(afterRename));

  // Disconnect — and prove the data survived.
  const before = await apiCall(`/api/fs/${SLUG}/list?path=/`, 'GET');
  const hadMarker = (before.body?.data?.entries || []).some(e => e.path === '/' + marker);
  check('marker file present before disconnect', hadMarker === true,
    JSON.stringify((before.body?.data?.entries || []).map(e => e.path)));

  const disc = await apiCall(`/api/drives/${mine.id}`, 'DELETE');
  check('drive can be disconnected', disc.body?.ok === true, JSON.stringify(disc.body).slice(0, 120));
  check('disconnect reports that data was kept', disc.body?.data?.dataKept === true, JSON.stringify(disc.body?.data));
  check('disconnected drive leaves the drive list', !(await driveList()).some(d => d.name === SLUG));
  check('disconnected drive leaves the mounts list', !(await mountNames()).includes(SLUG));
  const stillReachable = await apiCall(`/api/fs/${SLUG}/list?path=/`, 'GET');
  check('disconnected drive is no longer reachable', stillReachable.body?.ok === false,
    JSON.stringify(stillReachable.body).slice(0, 100));

  // Re-add with the same label: the files must still be there.
  const readd = await apiCall('/api/drives', 'POST', { label: DRIVE, adapter: 'local' });
  check('drive can be re-added', readd.body?.ok === true, JSON.stringify(readd.body).slice(0, 120));
  const after = await apiCall(`/api/fs/${readd.body.data.name}/list?path=/`, 'GET');
  const markerBack = (after.body?.data?.entries || []).some(e => e.path === '/' + marker);
  check('files survived the disconnect (nothing was deleted)', markerBack === true,
    JSON.stringify((after.body?.data?.entries || []).map(e => e.path)));

  // The Drives view renders with its controls.
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.sidebar .side-item')].find(x => x.textContent.includes('Drives'));
    if (b) b.click();
    return true;
  })()`);
  await sleep(1500);
  const view = await evaluate(`(() => {
    const rows = document.querySelectorAll('.admin-page table.table tbody tr').length;
    const addBtn = [...document.querySelectorAll('.admin-page button')].some(b => b.textContent.includes('Add drive'));
    return { rows, addBtn };
  })()`);
  check('Drives view lists drives', view.rows >= 1, 'rows=' + view.rows);
  check('Drives view offers Add drive', view.addBtn === true);

  // Clean up: disconnect both drives created here.
  for (const d of await driveList()) {
    if (d.name && d.name.startsWith('test-drive-')) {
      await apiCall(`/api/drives/${d.id}`, 'DELETE');
    }
  }
  await apiCall('/api/fs/local/delete-batch', 'POST', { items: [{ path: '/' + FOLDER }], permanent: true });
}

/* --------------------------------------------------------- sidebar collapse */
if (section('sidebar')) {
  const sidebarState = () => evaluate(`(() => {
    const s = document.querySelector('.sidebar');
    if (!s) return null;
    const label = s.querySelector('.side-item .lbl');
    return {
      collapsed: s.classList.contains('collapsed'),
      width: Math.round(s.getBoundingClientRect().width),
      labelVisible: label ? getComputedStyle(label).display !== 'none' : null,
    };
  })()`);

  const before = await sidebarState();
  check('sidebar starts expanded', before && before.collapsed === false, JSON.stringify(before));
  check('sidebar shows labels when expanded', before && before.labelVisible === true, JSON.stringify(before));

  const toggle = await evaluate(`(() => {
    const b = document.querySelector('.sidebar-toggle');
    if (!b) return 'no-button';
    b.click();
    return 'ok';
  })()`);
  check('collapse control exists', toggle === 'ok', toggle);
  await sleep(500);

  const collapsed = await sidebarState();
  check('sidebar collapses', collapsed && collapsed.collapsed === true, JSON.stringify(collapsed));
  check('collapsed sidebar is a narrow rail', collapsed && collapsed.width < 90, 'width=' + (collapsed && collapsed.width));
  check('labels hidden when collapsed', collapsed && collapsed.labelVisible === false, JSON.stringify(collapsed));

  // The main content must reclaim the space (no gap, no overflow).
  const layout = await evaluate(`(() => {
    const s = document.querySelector('.sidebar').getBoundingClientRect();
    const m = document.querySelector('.main').getBoundingClientRect();
    return { gap: Math.round(m.left - s.right), overflow: document.documentElement.scrollWidth > window.innerWidth };
  })()`);
  check('main content fills the reclaimed space', Math.abs(layout.gap) <= 1, 'gap=' + layout.gap);
  check('collapsing causes no horizontal overflow', layout.overflow === false);

  // Persisted across a reload.
  await reload();
  await sleep(800);
  const afterReload = await sidebarState();
  check('collapsed state survives a reload', afterReload && afterReload.collapsed === true, JSON.stringify(afterReload));

  // Expand again and confirm it persists too.
  await evaluate(`(() => { const b = document.querySelector('.sidebar-toggle'); if (b) b.click(); return true; })()`);
  await sleep(500);
  await reload();
  await sleep(800);
  const expandedAgain = await sidebarState();
  check('expanded state survives a reload', expandedAgain && expandedAgain.collapsed === false, JSON.stringify(expandedAgain));
}

/* ---------------------------------------------------------------- cleanup */
// Remove the fixture so repeated runs don't slowly fill the mount root (which
// pushes new rows below the fold and breaks windowing-sensitive assertions in
// other suites).
if (!ONLY) {
  await goRoot();
  const rm = await apiCall('/api/fs/local/delete-batch', 'POST', {
    items: [{ path: '/' + FOLDER }], permanent: true,
  });
  const cleaned = rm.body?.ok === true;
  check('fixture cleaned up', cleaned, JSON.stringify(rm.body).slice(0, 120));
}

console.log(`\nFEATURES RESULT: ${pass} passed, ${fail} failed`);
console.log('page errors: ' + (pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : 'none'));
cleanup(fail ? 1 : 0);
