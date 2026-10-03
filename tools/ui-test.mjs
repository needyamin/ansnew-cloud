#!/usr/bin/env node
/*
 * ANSNEW CLOUD UI smoke test via Chrome DevTools Protocol (no npm deps).
 *
 * Launches headless Chrome, loads the SPA, logs in with real credentials,
 * then asserts the authenticated shell rendered and reports any console
 * errors / uncaught exceptions. This is what catches "blank page" bugs that
 * static checks and curl cannot.
 *
 * Usage: ANSNEW_PW=<password> node tools/ui-test.mjs [baseUrl] [chromePath]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8081';
const CHROME = process.argv[3] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PW = process.env.ANSNEW_PW;
if (!PW) { console.error('set ANSNEW_PW'); process.exit(2); }

const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), 'ansnew-cdp-'));
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

  // wait for the debugger endpoint
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

  // Pin a desktop viewport so the main assertions are deterministic (the
  // headless default is 800x600, which is below the drawer breakpoint).
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  console.log('== load ==');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(2500);

  const spriteOk = await evaluate(`document.querySelectorAll('svg symbol').length > 10`);
  check('icon sprite injected', spriteOk === true);

  const hasLogin = await evaluate(`!!document.querySelector('.login-card')`);
  check('login card rendered', hasLogin === true);

  const noFatal = await evaluate(`!document.body.textContent.includes('Cannot reach the server')`);
  check('no bootstrap failure', noFatal === true);

  console.log('== login ==');
  await evaluate(`(() => {
    const u = document.querySelector('.login-card input[type=text]');
    const p = document.querySelector('.login-card input[type=password]');
    u.value = 'admin'; p.value = ${JSON.stringify(PW)};
    document.querySelector('.login-card button.primary').click();
    return true;
  })()`);
  await sleep(3000);

  const shellOk = await evaluate(`!!document.querySelector('.shell')`);
  check('app shell rendered', shellOk === true, await evaluate(`document.querySelector('.login-card .err')?.textContent || ''`));

  check('sidebar present', await evaluate(`!!document.querySelector('.sidebar')`) === true);
  check('topbar present', await evaluate(`!!document.querySelector('.topbar')`) === true);
  check('tabs bar present', await evaluate(`!!document.querySelector('.tabs')`) === true);

  const mounts = await evaluate(`[...document.querySelectorAll('.sidebar .side-item .lbl')].map(e => e.textContent)`);
  check('mount listed in sidebar', Array.isArray(mounts) && mounts.some(m => /local/i.test(m)), JSON.stringify(mounts));

  const filelist = await evaluate(`!!document.querySelector('.filelist')`);
  check('file list rendered', filelist === true);

  const crumbs = await evaluate(`document.querySelectorAll('.crumbs .crumb').length`);
  check('breadcrumbs rendered', typeof crumbs === 'number' && crumbs >= 1, 'crumbs=' + crumbs);

  const empties = await evaluate(`document.querySelector('.empty-hint')?.textContent || ''`);
  check('root listing is not an error', !/failed|error|authentication/i.test(empties), empties);

  console.log('== regressions ==');
  // An <svg> with no intrinsic size lays out at 300x150 and destroys the shell.
  const bigIcons = await evaluate(`[...document.querySelectorAll('svg.icon, svg.ico')].filter(s => {
    const r = s.getBoundingClientRect();
    return r.width > 60 || r.height > 60;
  }).length`);
  check('no oversized icons', bigIcons === 0, 'oversized=' + bigIcons);

  // A .btn carrying the `icon` class must stay inline-flex, not be squashed.
  // Skip hidden controls: display:none measures 0 and is not "squashed".
  const squashed = await evaluate(`[...document.querySelectorAll('.topbar .btn.icon')].filter(b => {
    if (getComputedStyle(b).display === 'none') return false;
    return b.getBoundingClientRect().width < 24;
  }).length`);
  check('topbar icon buttons not squashed', squashed === 0, 'squashed=' + squashed);

  // Icons must point at symbols that actually exist in the sprite.
  const brokenIcons = await evaluate(`(() => {
    const ids = new Set([...document.querySelectorAll('symbol')].map(s => s.id));
    return [...document.querySelectorAll('svg use')].filter(u => {
      const href = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
      return href.startsWith('#') && !ids.has(href.slice(1));
    }).length;
  })()`);
  check('no icons pointing at missing sprite symbols', brokenIcons === 0, 'broken=' + brokenIcons);

  // The internal trash directory is an implementation detail, not user content.
  const names = await evaluate(`[...document.querySelectorAll('.filelist [data-path]')].map(e => e.dataset.path)`);
  check('internal trash dir hidden from listing', !names.some(n => String(n).includes('__ansnew_trash__')), JSON.stringify(names).slice(0, 140));

  const hOverflow = await evaluate(`document.documentElement.scrollWidth - innerWidth`);
  check('no horizontal page overflow', hOverflow <= 1, 'overflow=' + hOverflow + 'px');

  console.log('== views ==');
  await evaluate(`[...document.querySelectorAll('.sidebar .side-item')].find(b => b.textContent.includes('Trash'))?.click()`);
  await sleep(900);
  check('trash view rendered', await evaluate(`!!document.querySelector('.admin-page')`) === true);

  await evaluate(`[...document.querySelectorAll('.sidebar .side-item')].find(b => b.textContent.includes('Users'))?.click()`);
  await sleep(900);
  const userRows = await evaluate(`document.querySelectorAll('.admin-page table.table tbody tr').length`);
  check('admin users table has rows', typeof userRows === 'number' && userRows >= 1, 'rows=' + userRows);

  await evaluate(`[...document.querySelectorAll('.sidebar .side-item')].find(b => b.textContent.includes('Mounts'))?.click()`);
  await sleep(900);
  const mountRows = await evaluate(`document.querySelectorAll('.admin-page table.table tbody tr').length`);
  check('admin mounts table has rows', typeof mountRows === 'number' && mountRows >= 1, 'rows=' + mountRows);

  console.log('== interaction (real write through the UI) ==');
  await evaluate(`[...document.querySelectorAll('.sidebar .side-item')].find(b => b.textContent.includes('Local Storage'))?.click()`);
  await sleep(1200);

  const FOLDER = 'ui-smoke-' + Date.now();
  await evaluate(`[...document.querySelectorAll('.topbar button')].find(b => b.title === 'New folder').click()`);
  await sleep(400);
  const dialogOpen = await evaluate(`!!document.querySelector('.overlay .dialog input[type=text]')`);
  check('new-folder dialog opened', dialogOpen === true);

  await evaluate(`(() => {
    const inp = document.querySelector('.overlay .dialog input[type=text]');
    inp.value = ${JSON.stringify(FOLDER)};
    [...document.querySelectorAll('.overlay .dialog footer button')].find(b => b.classList.contains('primary')).click();
    return true;
  })()`);
  await sleep(1800);

  // Regression: a valid submit must CLOSE the dialog (it used to stay open).
  check('new-folder dialog closes on submit', await evaluate(`!document.querySelector('.overlay .dialog')`) === true);

  const listed = await evaluate(`[...document.querySelectorAll('.filelist [data-path]')].map(e => e.dataset.path)`);
  check('created folder appears in listing', Array.isArray(listed) && listed.includes('/' + FOLDER), JSON.stringify(listed).slice(0, 160));

  // navigate into it by double-clicking the row
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.filelist [data-path]')].find(e => e.dataset.path === '/${FOLDER}');
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  })()`);
  await sleep(1400);
  const crumbsNow = await evaluate(`[...document.querySelectorAll('.crumbs .crumb')].map(e => e.textContent).join('/')`);
  check('navigated into the new folder', String(crumbsNow).includes(FOLDER), crumbsNow);

  // view toggle + theme toggle must not throw
  await evaluate(`[...document.querySelectorAll('.topbar button')].find(b => b.title === 'Grid view')?.click()`);
  await sleep(500);
  check('grid view applied', await evaluate(`!!document.querySelector('.filelist.grid')`) === true);

  await evaluate(`[...document.querySelectorAll('.topbar button')].find(b => b.title === 'Toggle theme')?.click()`);
  await sleep(400);
  check('theme toggled to light', await evaluate(`document.body.dataset.theme`) === 'light');

  console.log('== selection bar + drag & drop ==');
  // helper: create a folder through the real UI dialog
  const uiMkdir = async (name) => {
    await evaluate(`[...document.querySelectorAll('.topbar button')].find(b => b.title === 'New folder')?.click()`);
    await sleep(500);
    await evaluate(`(() => { const i = document.querySelector('.overlay .dialog input[type=text]'); if (i) i.value = ${JSON.stringify(name)}; return true; })()`);
    await evaluate(`(() => { const b = [...document.querySelectorAll('.overlay .dialog footer button')].find(x => x.classList.contains('primary')); if (b) b.click(); return true; })()`);
    await sleep(1300);
  };
  const openRow = async (path) => {
    await evaluate(`(() => {
      const r = [...document.querySelectorAll('.filelist [data-path]')].find(e => e.dataset.path === ${JSON.stringify(path)});
      if (r) r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;
    })()`);
    await sleep(1300);
  };
  const goRoot = async () => {
    await evaluate(`[...document.querySelectorAll('.crumbs .crumb')][0]?.click()`);
    await sleep(1300);
  };

  // --- selection action bar ---
  await goRoot();
  await evaluate(`(() => { const r = document.querySelector('.filelist [data-path]'); r?.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
  await sleep(400);
  const selbar = await evaluate(`(() => {
    const s = document.querySelector('.selbar');
    if (!s || s.hidden) return null;
    return { count: s.querySelector('.sel-count')?.textContent || '', buttons: s.querySelectorAll('button').length };
  })()`);
  check('selection bar appears on select', selbar !== null && /1 selected/.test(selbar.count), JSON.stringify(selbar));

  check('rows are draggable', await evaluate(`document.querySelector('.filelist [data-path]')?.draggable === true`));

  // --- internal drag & drop (move a folder onto another folder) ---
  const SRC = 'dndsrc' + Date.now().toString(36);
  const DST = 'dnddst' + Date.now().toString(36);
  await uiMkdir(SRC);
  await uiMkdir(DST);
  // put a file inside SRC so the move carries content
  await openRow('/' + SRC);
  await evaluate(`[...document.querySelectorAll('.topbar button')].find(b => b.title === 'New file')?.click()`);
  await sleep(500);
  await evaluate(`(() => { const i = document.querySelector('.overlay .dialog input[type=text]'); if (i) i.value = 'inside.txt'; return true; })()`);
  await evaluate(`(() => { const b = [...document.querySelectorAll('.overlay .dialog footer button')].find(x => x.classList.contains('primary')); if (b) b.click(); return true; })()`);
  await sleep(1300);
  await goRoot();

  const dropped = await evaluate(`(() => {
    const src = [...document.querySelectorAll('.filelist [data-path]')].find(e => e.dataset.path === ${JSON.stringify('/' + SRC)});
    const dst = [...document.querySelectorAll('.filelist [data-path]')].find(e => e.dataset.path === ${JSON.stringify('/' + DST)});
    if (!src || !dst) return 'missing-rows';
    const dt = new DataTransfer();
    dt.setData('application/x-ansnew', JSON.stringify({ mount: 'local', paths: [${JSON.stringify('/' + SRC)}] }));
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return 'dispatched';
  })()`);
  check('internal drag & drop dispatched', dropped === 'dispatched', String(dropped));
  await sleep(2500);

  await openRow('/' + DST);
  const insideDst = await evaluate(`[...document.querySelectorAll('.filelist [data-path]')].map(e => e.dataset.path)`);
  check('dragged folder landed inside target', Array.isArray(insideDst) && insideDst.includes('/' + DST + '/' + SRC), JSON.stringify(insideDst).slice(0, 160));
  // step into the moved folder to confirm its contents travelled with it
  await openRow('/' + DST + '/' + SRC);
  const insideSrc = await evaluate(`[...document.querySelectorAll('.filelist [data-path]')].map(e => e.dataset.path)`);
  check('moved folder kept its contents', Array.isArray(insideSrc) && insideSrc.includes('/' + DST + '/' + SRC + '/inside.txt'), JSON.stringify(insideSrc).slice(0, 160));

  // --- sort control works in both view modes ---
  check('sort control present', await evaluate(`!!document.querySelector('.fm-toolbar .sort-select')`));
  const sortedOk = await evaluate(`(() => {
    const s = document.querySelector('.fm-toolbar .sort-select');
    if (!s) return 'missing';
    s.value = 'name:desc';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return 'changed';
  })()`);
  check('sort control applies', sortedOk === 'changed', String(sortedOk));
  await sleep(700);
  await goRoot();

  console.log('== thumbnails + details panel ==');
  await goRoot();

  // Self-seed an image by uploading one through the real UI (also exercises the
  // upload path). A canvas-generated PNG avoids shipping binary fixtures.
  await evaluate(`[...document.querySelectorAll('.topbar button')].find(b => b.title && b.title.startsWith('Upload'))?.click()`);
  await sleep(500);
  const uploaded = await evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#3a7bd5'; ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = '#ffffff'; ctx.font = '28px sans-serif'; ctx.fillText('ANSNEW CLOUD', 24, 70);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const file = new File([blob], 'uitest-thumb.png', { type: 'image/png' });
    const input = document.querySelector('input[type=file]');
    if (!input) return 'no-input';
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'dispatched';
  })()`);
  check('image uploaded through the UI', uploaded === 'dispatched', String(uploaded));
  await sleep(3200);
  check('uploaded image appears in listing', await evaluate(`[...document.querySelectorAll('.filelist [data-path]')].some(e => e.dataset.path === '/uitest-thumb.png')`) === true);

  // Force grid mode explicitly — the toggle's label depends on the current mode.
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.topbar button')].find(x => x.title === 'Grid view' || x.title === 'List view');
    if (b && b.title === 'Grid view') b.click();
    return true;
  })()`);
  await sleep(2600);   // let the IntersectionObserver fire and images load
  const thumbs = await evaluate(`(() => {
    const imgs = [...document.querySelectorAll('img.thumb')];
    return {
      mode: document.querySelector('.filelist')?.className || '',
      here: [...document.querySelectorAll('.crumbs .crumb')].map(c => c.textContent).join('/'),
      count: imgs.length,
      loaded: imgs.filter(i => i.naturalWidth > 0).length,
    };
  })()`);
  check('grid renders thumbnail images', thumbs.count >= 1, JSON.stringify(thumbs));
  check('thumbnails actually load bytes', thumbs.loaded >= 1, JSON.stringify(thumbs));

  await evaluate(`[...document.querySelectorAll('.topbar button')].find(b => b.title === 'List view')?.click()`);
  await sleep(1300);
  await evaluate(`(() => { const r = document.querySelector('.filelist [data-path]'); r?.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
  await sleep(700);
  const det = await evaluate(`(() => {
    const p = document.querySelector('.details');
    if (!p || p.hidden) return null;
    return {
      title: p.querySelector('.details-title')?.textContent || '',
      rows: [...p.querySelectorAll('.details-rows dt')].map(d => d.textContent),
    };
  })()`);
  check('details panel shows metadata', det !== null && det.rows.includes('Size') && det.rows.includes('Modified'), JSON.stringify(det));
  check('details panel has action buttons', await evaluate(`document.querySelectorAll('.details-actions button').length`) >= 3);

  console.log('== responsive ==');
  for (const [w, h, label] of [[1440, 900, 'desktop'], [1024, 800, 'narrow'], [768, 900, 'tablet'], [375, 812, 'phone'], [320, 640, 'small-phone']]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    const overflow = await evaluate(`document.documentElement.scrollWidth - innerWidth`);
    check(`${label} ${w}x${h}: no horizontal overflow`, overflow <= 1, 'overflow=' + overflow + 'px');
  }

  // --- sidebar drawer behaviour at phone width ---
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  const offscreen = await evaluate(`document.querySelector('.sidebar').getBoundingClientRect().right <= 1`);
  check('phone: sidebar starts off-screen', offscreen === true);

  const hamburger = await evaluate(`(() => {
    const b = [...document.querySelectorAll('.topbar button')].find(x => x.title === 'Menu');
    if (!b) return 'missing';
    b.click();
    return 'clicked';
  })()`);
  check('phone: hamburger present', hamburger === 'clicked', hamburger);
  await sleep(600);
  check('phone: sidebar opens as drawer', await evaluate(`document.querySelector('.sidebar').getBoundingClientRect().left >= -1`) === true);
  check('phone: scrim visible while open', await evaluate(`!!document.querySelector('.scrim.show')`) === true);

  await evaluate(`document.querySelector('.scrim').click()`);
  await sleep(600);
  check('phone: scrim closes the drawer', await evaluate(`document.querySelector('.sidebar').getBoundingClientRect().right <= 1`) === true);

  // --- dialogs must fit the viewport (regression: min-width:380px clipped them) ---
  // At phone width "New folder" lives in the "More actions" menu.
  await evaluate(`[...document.querySelectorAll('.topbar button')].find(b => b.title === 'More actions')?.click()`);
  await sleep(500);
  await evaluate(`(() => {
    const m = [...document.querySelectorAll('.ctxmenu button')].find(b => b.textContent.includes('New folder'));
    if (m) m.click();
    return true;
  })()`);
  await sleep(500);
  const dlg = await evaluate(`(() => {
    const d = document.querySelector('.overlay .dialog');
    if (!d) return null;
    const r = d.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) };
  })()`);
  check('phone: dialog fits inside viewport', dlg !== null && dlg.left >= -1 && dlg.right <= 376, JSON.stringify(dlg));
  // dismiss it
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.overlay .dialog footer button')].find(x => !x.classList.contains('primary'));
    if (b) b.click();
    return true;
  })()`);
  await sleep(400);

  // --- admin tables must scroll inside their wrapper, not the page ---
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  await evaluate(`document.querySelector('.sidebar').classList.add('open')`);
  await sleep(300);
  await evaluate(`[...document.querySelectorAll('.sidebar .side-item')].find(b => b.textContent.includes('Users'))?.click()`);
  await sleep(1200);
  const tableScrolls = await evaluate(`(() => {
    const w = document.querySelector('.admin-page .table-wrap');
    if (!w) return 'no-wrapper';
    return getComputedStyle(w).overflowX;
  })()`);
  check('phone: admin table has a scroll wrapper', tableScrolls === 'auto' || tableScrolls === 'scroll', String(tableScrolls));
  check('phone: no page overflow on admin view', await evaluate(`document.documentElement.scrollWidth - innerWidth`) <= 1);

  // back to a desktop viewport for the console-health pass
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(600);

  console.log('== console health ==');
  check('no uncaught exceptions', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  const realErrors = consoleErrors.filter(e => !/favicon|net::ERR_/i.test(e));
  check('no console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  console.log(`\nUI RESULT: ${pass} passed, ${fail} failed`);
  cleanup(fail === 0 ? 0 : 1);
} catch (e) {
  console.error('UI test error: ' + e.message);
  if (pageErrors.length) console.error('page errors:\n  ' + pageErrors.join('\n  '));
  if (consoleErrors.length) console.error('console errors:\n  ' + consoleErrors.join('\n  '));
  cleanup(1);
}
