#!/usr/bin/env node
/*
 * Rubber-band (drag-to-select) test — runs in REAL headless Chrome.
 *
 * Why a browser and not jsdom: the marquee is entirely a geometry feature
 * (getBoundingClientRect, clientWidth, scrollTop). jsdom has no layout engine,
 * so every rect there is 0x0 and the test would pass vacuously. This drives
 * actual mouse input through the DevTools Protocol, so the assertions are about
 * what the user really gets.
 *
 * It is self-contained: it creates its own fixture folder over the API, cleans
 * it up afterwards, and needs no npm dependencies (Node's global WebSocket).
 *
 * Usage:
 *   node tools/marquee-test.mjs [baseUrl] [chromePath]
 *   ADMIN_USER=admin ADMIN_PASS=admin node tools/marquee-test.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:9090';
const CHROME = process.argv[3] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'admin';
const MOUNT = 'local';

const FOLDER_FEW = 'mq-few';       // short listing: empty space below the rows
const FILES_FEW = 12;
const FOLDER_MANY = 'mq-many';     // long listing: forces scrolling + auto-scroll
const FILES_MANY = 90;

const PORT = 9344;
const profile = mkdtempSync(join(tmpdir(), 'ansnew-mq-'));
let chrome, ws, msgId = 0;
const pending = new Map();
const pageErrors = [];

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  \u2713 ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  \u2717 ${label}${extra ? '  ' + extra : ''}`); }
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- CDP client */

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timed out')); }
    }, 25000);
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.value;
}

/* --------------------------------------------------------- API (Node side) */

let cookie = '';
let csrf = '';

function setCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const m = /^(ANSNEW_SID=[^;]*)/.exec(c);
    if (m) cookie = m[1];
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  setCookies(res);
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json, data: json && json.data };
}

async function login() {
  const boot = await api('/api/bootstrap');
  csrf = boot.data && boot.data.csrf;
  const r = await api('/api/auth/login', { method: 'POST', body: { username: USER, password: PASS } });
  if (!r.json || r.json.ok !== true) throw new Error('login failed: ' + JSON.stringify(r.json));
  // The CSRF token rotates on login.
  csrf = r.data.csrf;
  // Deletes are gated behind a password confirmation.
  await api('/api/auth/confirm', { method: 'POST', body: { password: PASS, scope: 'fs.delete' } });
}

async function makeFixture(name, count) {
  await api(`/api/fs/${MOUNT}/delete`, { method: 'POST', body: { path: '/' + name, permanent: true } });
  const mk = await api(`/api/fs/${MOUNT}/mkdir`, { method: 'POST', body: { path: '/', name } });
  if (mk.status >= 400) throw new Error('mkdir failed: ' + JSON.stringify(mk.json));
  for (let i = 1; i <= count; i++) {
    await api(`/api/fs/${MOUNT}/file`, {
      method: 'POST',
      body: { path: '/' + name, name: `file-${String(i).padStart(3, '0')}.txt` },
    });
  }
}

async function dropFixture(name) {
  await api(`/api/fs/${MOUNT}/delete`, { method: 'POST', body: { path: '/' + name, permanent: true } });
}

/* ------------------------------------------------------------ mouse input */

const MOD_CTRL = 2;

async function mouse(type, x, y, { modifiers = 0, buttons = 0 } = {}) {
  await send('Input.dispatchMouseEvent', {
    type, x, y, button: type === 'mouseMoved' ? 'none' : 'left',
    buttons, clickCount: 1, modifiers,
  });
}

/** Press at (x0,y0), drag to (x1,y1) in steps, optionally release. */
async function drag(x0, y0, x1, y1, { modifiers = 0, release = true, steps = 8 } = {}) {
  await mouse('mousePressed', x0, y0, { modifiers, buttons: 1 });
  await sleep(40);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await mouse('mouseMoved', x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, { modifiers, buttons: 1 });
    await sleep(18);
  }
  if (release) {
    await mouse('mouseReleased', x1, y1, { modifiers, buttons: 0 });
    await sleep(60);
  }
}

/* ------------------------------------------------------------- page probes */

const SELECTED = `[...document.querySelectorAll('.filelist .frow.selected, .filelist .fitem.selected')]
  .map(n => n.dataset.path).sort()`;

const ROWS = `(() => {
  const list = document.querySelector('.filelist');
  const lr = list.getBoundingClientRect();
  const rows = [...list.querySelectorAll('.frow, .fitem')].map(n => {
    const r = n.getBoundingClientRect();
    return { path: n.dataset.path, top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  }).sort((a, b) => a.top - b.top);
  return { list: { top: lr.top, bottom: lr.bottom, left: lr.left, right: lr.right },
           rows, scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight };
})()`;

async function gotoFolder(folder) {
  await send('Page.navigate', { url: `${BASE}/?mount=${MOUNT}&path=%2F${folder}` });
  await sleep(1600);
}

async function main() {
  console.log(`\nFixture: /${FOLDER_FEW} (${FILES_FEW} files), /${FOLDER_MANY} (${FILES_MANY} files)`);
  await login();
  await makeFixture(FOLDER_FEW, FILES_FEW);
  await makeFixture(FOLDER_MANY, FILES_MANY);

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
        target = list.find((t) => t.type === 'page');
      } catch { /* not up yet */ }
    }
    if (!target) throw new Error('chrome debugger never became reachable');

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
        pageErrors.push(msg.params.exceptionDetails?.exception?.description || 'unknown');
      }
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // Log in through the UI, then pin the view mode so the geometry is known.
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(2200);
    await evaluate(`(() => {
      const u = document.querySelector('.login-card input[type=text]');
      const p = document.querySelector('.login-card input[type=password]');
      u.value = ${JSON.stringify(USER)}; p.value = ${JSON.stringify(PASS)};
      document.querySelector('.login-card button.primary').click();
      return true;
    })()`);
    await sleep(2800);
    check('logged in (app shell rendered)', await evaluate(`!!document.querySelector('.shell')`) === true);

    /* =============================================== details view (rows) */
    console.log('\nDetails view — drag from empty space');
    await evaluate(`localStorage.setItem('ansnew.view','details')`);
    await gotoFolder(FOLDER_FEW);

    let geo = await evaluate(ROWS);
    if (!check('fixture listing rendered', geo.rows.length === FILES_FEW, `${geo.rows.length} rows`)) throw new Error('bad fixture');

    // Start below the last row (empty space), drag up to cover the last 4 rows.
    // NOTE: the pane can be narrow (sidebar + details panel), so every point must
    // be derived from the list's own rect rather than a fixed offset from its
    // left edge — otherwise the press lands on the details panel instead.
    const last = geo.rows[geo.rows.length - 1];
    const targetTop = geo.rows[FILES_FEW - 4].top + 2;
    const startX = Math.min(geo.list.left + Math.floor((geo.list.right - geo.list.left) / 2), geo.list.right - 20);
    const startY = Math.min(last.bottom + 40, geo.list.bottom - 12);
    const expected = geo.rows.filter((r) => r.top < startY && r.bottom > targetTop).map((r) => r.path).sort();

    await drag(startX, startY, startX, targetTop);
    let selected = await evaluate(SELECTED);
    check('the drag selected exactly the rows it covered',
      JSON.stringify(selected) === JSON.stringify(expected),
      `expected ${expected.length}, got ${selected.length}`);

    check('the click that follows the drag did not clear the selection', selected.length > 0,
      `${selected.length} still selected`);

    /* ------------------------------------------------ rubber band is drawn */
    await evaluate(`document.querySelector('.filelist').click()`);   // clear first
    await mouse('mousePressed', startX, startY, { buttons: 1 });
    for (let i = 1; i <= 6; i++) {
      await mouse('mouseMoved', startX, startY - i * 12, { buttons: 1 });
      await sleep(16);
    }
    const band = await evaluate(`(() => {
      const m = document.querySelector('.marquee');
      if (!m) return null;
      const r = m.getBoundingClientRect();
      return { hidden: m.hidden, w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    check('a rubber band is drawn while dragging',
      !!band && band.hidden === false && band.w > 0 && band.h > 0,
      band ? `${band.w}x${band.h}` : 'no .marquee element');
    await mouse('mouseReleased', startX, startY - 72, { buttons: 0 });
    await sleep(60);
    const bandGone = await evaluate(`document.querySelector('.marquee').hidden`);
    check('the rubber band is hidden again on release', bandGone === true);

    /* ------------------------------------------------------ plain drag replaces */
    // Rows are full-width, so a drag from below the last row up to just above
    // row N covers rows N..end. Derive the expectation from the same geometry.
    const covers = (endTop) => geo.rows.filter((r) => r.top < startY && r.bottom > endTop).map((r) => r.path).sort();

    await evaluate(`document.querySelector('.filelist').click()`);   // clear first
    const end9 = geo.rows[FILES_FEW - 3].top + 2;                     // rows 9..11
    await drag(startX, startY, startX, end9);
    selected = await evaluate(SELECTED);
    check('a drag replaces the previous selection',
      JSON.stringify(selected) === JSON.stringify(covers(end9)),
      `${selected.length} selected (expected ${covers(end9).length})`);

    /* ------------------------------------------------------- Ctrl adds to it */
    const end6 = geo.rows[FILES_FEW - 6].top + 2;                     // rows 6..11
    await drag(startX, startY, startX, end6, { modifiers: MOD_CTRL });
    selected = await evaluate(SELECTED);
    check('Ctrl+drag adds to the existing selection instead of replacing it',
      JSON.stringify(selected) === JSON.stringify(covers(end6)) && selected.length > covers(end9).length,
      `${covers(end9).length} -> ${selected.length} (expected ${covers(end6).length})`);

    /* -------------------------------------------------------- Esc restores it */
    const beforeEsc = await evaluate(SELECTED);
    await evaluate(`document.querySelector('.filelist').focus()`);
    await mouse('mousePressed', startX, startY, { buttons: 1 });
    await mouse('mouseMoved', startX, startY - 30, { buttons: 1 });
    await sleep(40);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(40);
    const afterEscKey = await evaluate(SELECTED);
    await mouse('mouseReleased', startX, startY - 30, { buttons: 0 });
    await sleep(120);
    const afterEsc = await evaluate(SELECTED);
    check('Esc during a drag restores the previous selection',
      JSON.stringify(afterEscKey) === JSON.stringify(beforeEsc) && JSON.stringify(afterEsc) === JSON.stringify(beforeEsc),
      `${beforeEsc.length} -> ${afterEscKey.length} (key) -> ${afterEsc.length} (after mouseup)`);

    /* -------------------------------------------- pressing a row is untouched */
    const rowCentre = {
      x: Math.min(geo.rows[5].left + 120, geo.list.right - 20),
      y: (geo.rows[5].top + geo.rows[5].bottom) / 2,
    };
    await mouse('mousePressed', rowCentre.x, rowCentre.y, { buttons: 1 });
    await mouse('mouseMoved', rowCentre.x + 40, rowCentre.y + 20, { buttons: 1 });
    await sleep(40);
    await mouse('mouseReleased', rowCentre.x + 40, rowCentre.y + 20, { buttons: 0 });
    await sleep(80);
    const noBandOnRow = await evaluate(`document.querySelector('.marquee').hidden`);
    check('a drag that starts ON a row does not start a marquee', noBandOnRow === true);

    /* ---------------------------------------------- a plain click clears it */
    await drag(startX, startY, startX, geo.rows[0].top + 2);
    const beforeClick = await evaluate(SELECTED);
    await mouse('mousePressed', startX, startY, { buttons: 1 });
    await mouse('mouseReleased', startX, startY, { buttons: 0 });
    await sleep(120);
    const afterClick = await evaluate(SELECTED);
    check('a plain click on empty space clears the selection',
      beforeClick.length > 0 && afterClick.length === 0,
      `${beforeClick.length} -> ${afterClick.length}`);

    /* ================================================ icons view + scrolling */
    console.log('\nIcons view — auto-scroll while dragging');
    await evaluate(`localStorage.setItem('ansnew.view','icons')`);
    await gotoFolder(FOLDER_MANY);

    geo = await evaluate(ROWS);
    check('long listing scrolls', geo.scrollHeight > geo.clientHeight,
      `${geo.scrollHeight} > ${geo.clientHeight}`);

    // Scroll to the bottom so the final (partial) row is visible with empty
    // space to its right — a valid place to start a rubber band.
    await evaluate(`(() => { const l = document.querySelector('.filelist'); l.scrollTop = l.scrollHeight; return l.scrollTop; })()`);
    await sleep(300);
    geo = await evaluate(ROWS);

    const bottomRow = geo.rows[geo.rows.length - 1];
    const bottomRowTiles = geo.rows.filter((r) => Math.abs(r.top - bottomRow.top) < 2);
    const lastTile = bottomRowTiles[bottomRowTiles.length - 1];
    const bandX = Math.min(lastTile.right + 40, geo.list.right - 8);
    const bandY = (lastTile.top + lastTile.bottom) / 2;
    const hasRoom = bandX > lastTile.right + 4 && bandX < geo.list.right;

    if (hasRoom) {
      const scrollBefore = await evaluate(`document.querySelector('.filelist').scrollTop`);
      // Drag from the empty space right of the last tile up to the top edge and
      // hold there: the pane must auto-scroll upwards.
      await mouse('mousePressed', bandX, bandY, { buttons: 1 });
      for (let i = 1; i <= 6; i++) {
        await mouse('mouseMoved', bandX, bandY - i * 10, { buttons: 1 });
        await sleep(16);
      }
      await mouse('mouseMoved', bandX, geo.list.top + 4, { buttons: 1 });
      await sleep(700);                       // let the auto-scroll run
      const scrollAfter = await evaluate(`document.querySelector('.filelist').scrollTop`);
      await mouse('mouseReleased', bandX, geo.list.top + 4, { buttons: 0 });
      await sleep(80);
      check('dragging to the top edge auto-scrolls the listing',
        scrollAfter < scrollBefore, `${Math.round(scrollBefore)} -> ${Math.round(scrollAfter)}`);
      const n = await evaluate(`document.querySelectorAll('.filelist .fitem.selected').length`);
      check('auto-scroll extends the selection beyond the first screen', n > 0, `${n} tiles selected`);
    } else {
      check('icons view has empty space to start a rubber band', false, 'layout had no room — skipped');
    }

    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    try { chrome && chrome.kill(); } catch { /* ignore */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    await dropFixture(FOLDER_FEW);
    await dropFixture(FOLDER_MANY);
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nHarness error:', err);
  process.exit(1);
});
