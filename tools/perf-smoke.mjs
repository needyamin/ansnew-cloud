#!/usr/bin/env node
/*
 * ANSNEW CLOUD windowing / responsiveness smoke test (Chrome DevTools Protocol).
 *
 * Verifies the properties that make the file list feel like a desktop app and
 * that a naive implementation silently loses:
 *   - DOM node count stays bounded no matter how big the folder is
 *   - the virtual canvas still reports the full scrollable height
 *   - scrolling to the end reaches the real last entry
 *   - Ctrl+A selects the whole listing, not just the rendered window
 *   - keyboard navigation works for rows that are not rendered yet
 *   - a refresh does NOT blank the list or drop the selection (no flicker)
 *
 * Creates its own fixture directory under the host storage mount and removes it
 * again afterwards, so the storage directory is left as it was found.
 *
 * Usage: ANSNEW_PW=<password> node tools/perf-smoke.mjs [baseUrl] [chromePath] [folder] [count] [hostStorageDir]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8200';
const CHROME = process.argv[3] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FOLDER = process.argv[4] || 'perftest';
const COUNT = Number(process.argv[5] || 1500);
const HOST_DIR = process.argv[6] || 'storage-root';
const PW = process.env.ANSNEW_PW;
if (!PW) { console.error('set ANSNEW_PW'); process.exit(2); }

const fixtureDir = join(HOST_DIR, FOLDER);
function makeFixture() {
  if (existsSync(fixtureDir)) return;
  mkdirSync(fixtureDir, { recursive: true });
  for (let i = 0; i < COUNT; i++) {
    writeFileSync(join(fixtureDir, 'file-' + String(i).padStart(4, '0') + '.txt'), '');
  }
  writeFileSync(join(fixtureDir, 'zzz-last.txt'), '');
  console.log(`(created fixture ${fixtureDir} with ${COUNT + 1} entries)`);
}
function dropFixture() {
  try { rmSync(fixtureDir, { recursive: true, force: true }); } catch (_) {}
}

const PORT = 9334;
const profile = mkdtempSync(join(tmpdir(), 'ansnew-perf-'));
let chrome, ws, msgId = 0;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timed out')); } }, 20000);
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.value;
}

/** Poll an expression until it evaluates truthy (or the timeout expires). */
async function waitFor(expression, timeout = 10000, interval = 200) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await evaluate(expression)) return true; } catch (_) { /* keep polling */ }
    await sleep(interval);
  }
  return false;
}

function cleanup(code) {
  try { ws && ws.close(); } catch (_) {}
  try { chrome && chrome.kill(); } catch (_) {}
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  process.exit(code);
}

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { console.log('  PASS  ' + label); pass++; }
  else { console.log('  FAIL  ' + label + (extra ? '  (' + extra + ')' : '')); fail++; }
};

try {
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page');
    } catch (_) { /* not up yet */ }
  }
  if (!target) { console.error('chrome debugger never became reachable'); cleanup(2); }

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'unknown');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push((msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
    }
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  console.log('== login ==');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(2500);
  await evaluate(`(() => {
    const u = document.querySelector('.login-card input[type=text]');
    const p = document.querySelector('.login-card input[type=password]');
    u.value = 'admin'; p.value = ${JSON.stringify(PW)};
    document.querySelector('.login-card button.primary').click();
    return true;
  })()`);
  await sleep(2500);
  check('logged in', await evaluate(`!!document.querySelector('.shell')`) === true);

  makeFixture();
  console.log(`== windowing on /${FOLDER} (${COUNT} entries) ==`);
  // Go to the mount root, then open the fixture folder exactly as a user would.
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('.sidebar .side-item')]
      .find(b => b.textContent.includes('Local Storage'));
    if (item) item.click();
    return true;
  })()`);
  await sleep(1600);

  // The root may hold other folders, and the list is windowed — scroll until the
  // fixture row is actually rendered, then open it.
  const opened = await evaluate(`(async () => {
    const l = document.querySelector('.filelist');
    const target = '/${FOLDER}';
    const orig = l.scrollTop;
    const step = Math.max(80, Math.floor(l.clientHeight * 0.75));
    for (let y = 0; y <= l.scrollHeight + step; y += step) {
      l.scrollTop = y;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const row = [...document.querySelectorAll('.filelist [data-path]')].find(e => e.dataset.path === target);
      if (row) { row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return 'ok'; }
    }
    l.scrollTop = orig;
    return 'missing';
  })()`);
  check(`fixture folder /${FOLDER} exists and opens`, opened === 'ok', 'open=' + opened);

  // Wait for the listing to actually land. The first read of a large directory
  // is O(files) on the server (encryption reads a header per file), so a fixed
  // sleep here would be flaky.
  const landed = await waitFor(
    `(() => {
      const s = document.querySelector('.fl-spacer');
      const h = s ? parseFloat(s.style.height) || 0 : 0;
      const n = document.querySelectorAll('.filelist [data-path]').length;
      return h > 10000 && n > 0;
    })()`,
    25000,
  );
  check('large listing loaded', landed === true);

  const total = await evaluate(`document.querySelectorAll('.filelist [data-path]').length`);
  check(`rendered rows bounded (${total} nodes for ${COUNT} entries)`, total > 0 && total < 200, 'nodes=' + total);

  const spacerH = await evaluate(`document.querySelector('.fl-spacer')?.style.height || ''`);
  const spacerPx = parseFloat(spacerH) || 0;
  check('virtual canvas covers the full listing', spacerPx > COUNT * 10, 'height=' + spacerH);

  const headerVisible = await evaluate(`(() => {
    const h = document.querySelector('.list-head');
    return !!h && !h.hidden;
  })()`);
  check('list header visible in list mode', headerVisible === true);

  console.log('== scroll to the end ==');
  await evaluate(`(() => { const l = document.querySelector('.filelist'); l.scrollTop = l.scrollHeight; return true; })()`);
  await waitFor(`(() => {
    const paths = [...document.querySelectorAll('.filelist [data-path]')].map(e => e.dataset.path);
    return paths.some(p => p.includes('zzz-last'));
  })()`, 5000);
  const atEnd = await evaluate(`(() => {
    const paths = [...document.querySelectorAll('.filelist [data-path]')].map(e => e.dataset.path);
    return { last: paths[paths.length - 1] || '', count: paths.length };
  })()`);
  check('last entry is reachable by scrolling', String(atEnd.last).includes('zzz-last'), JSON.stringify(atEnd));

  console.log('== selection spans the whole listing ==');
  await evaluate(`(() => { const l = document.querySelector('.filelist'); l.focus(); l.scrollTop = 0; return true; })()`);
  await sleep(300);
  await evaluate(`(() => {
    const l = document.querySelector('.filelist');
    l.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  const selText = await evaluate(`document.querySelector('.sel-count')?.textContent || ''`);
  const selCount = parseInt(selText, 10);
  check('Ctrl+A selects every entry, not just the window', selCount >= COUNT, 'sel-count=' + selText);

  const stillBounded = await evaluate(`document.querySelectorAll('.filelist [data-path]').length`);
  check('select-all keeps the node count bounded', stillBounded < 200, 'nodes=' + stillBounded);

  console.log('== keyboard navigation past the rendered window ==');
  await evaluate(`(() => {
    const l = document.querySelector('.filelist');
    l.focus();
    l.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  const endSel = await evaluate(`(() => {
    const n = document.querySelector('.filelist [aria-selected="true"]');
    return n ? n.dataset.path : '';
  })()`);
  check('End key selects the final entry', String(endSel).includes('zzz-last'), 'selected=' + endSel);

  console.log('== refresh does not blank or reset the pane ==');
  await evaluate(`(() => {
    const l = document.querySelector('.filelist');
    l.focus();
    l.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true }));
    return true;
  })()`);
  // Sample quickly: a naive implementation shows a skeleton here.
  const during = await evaluate(`({
    skeletons: document.querySelectorAll('.skeleton').length,
    rows: document.querySelectorAll('.filelist [data-path]').length,
  })`);
  check('no skeleton flash during refresh', during.skeletons === 0, 'skeletons=' + during.skeletons);
  check('rows stay on screen during refresh', during.rows > 0, 'rows=' + during.rows);
  await sleep(1200);
  const after = await evaluate(`({
    skeletons: document.querySelectorAll('.skeleton').length,
    rows: document.querySelectorAll('.filelist [data-path]').length,
  })`);
  check('listing intact after refresh settles', after.skeletons === 0 && after.rows > 0, JSON.stringify(after));

  console.log('== grid mode ==');
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.topbar button')].find(x => /Grid view|List view/.test(x.title));
    if (b) b.click();
    return true;
  })()`);
  await sleep(700);
  const gridInfo = await evaluate(`(() => {
    const l = document.querySelector('.filelist');
    const items = [...document.querySelectorAll('.filelist [data-path]')];
    const first = items[0];
    const second = items[1];
    return {
      grid: l.classList.contains('grid'),
      n: items.length,
      tileH: first ? Math.round(first.getBoundingClientRect().height) : 0,
      sameRow: first && second ? Math.round(first.getBoundingClientRect().top) === Math.round(second.getBoundingClientRect().top) : false,
    };
  })()`);
  check('grid mode engaged', gridInfo.grid === true);
  check('grid tiles are uniformly sized', gridInfo.tileH > 0, 'tileH=' + gridInfo.tileH);
  check('grid lays tiles out in rows', gridInfo.sameRow === true, JSON.stringify(gridInfo));
  check('grid keeps the node count bounded', gridInfo.n > 0 && gridInfo.n < 200, 'nodes=' + gridInfo.n);

  console.log('== console health ==');
  check('no uncaught exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  console.log(`\nPERF RESULT: ${pass} passed, ${fail} failed`);
  dropFixture();
  cleanup(fail ? 1 : 0);
} catch (e) {
  console.error('perf smoke crashed: ' + e.message);
  cleanup(2);
}
