#!/usr/bin/env node
/*
 * ANSNEW CLOUD layout diagnostic via CDP.
 * Logs in, then reports as TEXT:
 *   - viewport / document scroll metrics
 *   - elements overflowing their parent or the viewport
 *   - visible elements that collapsed to zero size
 *   - overlapping fixed/absolute panels
 *   - computed geometry of the main shell regions
 * Also writes a screenshot to /tmp for manual inspection.
 *
 * Usage: ANSNEW_PW=... node tools/ui-diagnose.mjs [baseUrl] [outPng]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8081';
const OUT = process.argv[3] || '/tmp/ansnew-ui.png';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PW = process.env.ANSNEW_PW;
if (!PW) { console.error('set ANSNEW_PW'); process.exit(2); }

const PORT = 9344;
const WIDTH = Number(process.env.VIEW_W || 1440);
const HEIGHT = Number(process.env.VIEW_H || 900);
const profile = mkdtempSync(join(tmpdir(), 'ansnew-diag-'));
let chrome, ws, msgId = 0;
const pending = new Map();
const errors = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timeout')); } }, 25000);
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

const PROBE = `(() => {
  const out = { problems: [], regions: {}, counts: {} };
  const vw = innerWidth, vh = innerHeight;
  out.viewport = { vw, vh };
  out.document = {
    scrollW: document.documentElement.scrollWidth,
    scrollH: document.documentElement.scrollHeight,
    bodyScrollW: document.body.scrollWidth,
    bodyScrollH: document.body.scrollHeight,
  };

  const regions = ['.shell','.sidebar','.main','.topbar','.tabs','.content','.fm-split','.pane','.fm-toolbar','.crumbs','.list-head','.filelist','.side-head'];
  for (const sel of regions) {
    const el = document.querySelector(sel);
    if (!el) { out.regions[sel] = null; continue; }
    const r = el.getBoundingClientRect();
    out.regions[sel] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }

  // element counts
  for (const sel of ['.side-item','.frow','.fitem','.tab','.crumb','.frow .ico','svg.icon','img.thumb','img.thumb[src]','.details','.selbar']) {
    out.counts[sel] = document.querySelectorAll(sel).length;
  }

  // visible elements collapsed to zero size. Native-rendered elements
  // (<option>, <br>, ...) legitimately have no box of their own, and an element
  // inside a display:none ancestor is hidden rather than collapsed — so use
  // checkVisibility(), which accounts for ancestors, not just the element.
  const NATIVE = new Set(['OPTION','OPTGROUP','DATALIST','BR','SCRIPT','STYLE','TEMPLATE','META','LINK','TRACK','SOURCE','PARAM','TITLE']);
  for (const el of document.querySelectorAll('.shell *, .login-card *')) {
    if (NATIVE.has(el.tagName)) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') continue;
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) continue;
    } else if (cs.display === 'none' || cs.visibility === 'hidden') {
      continue;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && el.children.length === 0 && el.textContent.trim() !== '') {
      out.problems.push({ kind: 'zero-size', tag: el.tagName.toLowerCase(), cls: el.className, text: el.textContent.trim().slice(0, 40) });
    }
  }

  // horizontal overflow of the page itself
  if (document.documentElement.scrollWidth > vw + 1) {
    out.problems.push({ kind: 'page-h-overflow', scrollW: document.documentElement.scrollWidth, vw });
  }

  // children wider than their parent (clipped / overflowing layout)
  const seen = new Set();
  for (const el of document.querySelectorAll('.sidebar *, .topbar *, .fm-toolbar *, .pane > *')) {
    const p = el.parentElement;
    if (!p) continue;
    const pr = p.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    if (er.width === 0 || pr.width === 0) continue;
    if (er.right > pr.right + 2 || er.left < pr.left - 2) {
      const key = el.className + '|' + p.className;
      if (seen.has(key)) continue;
      seen.add(key);
      const pcs = getComputedStyle(p);
      out.problems.push({
        kind: 'child-outside-parent',
        child: el.tagName.toLowerCase() + '.' + el.className + (el.getAttribute('title') ? '[' + el.getAttribute('title') + ']' : ''),
        parent: p.tagName.toLowerCase() + '.' + p.className + (p.getAttribute('title') ? '[' + p.getAttribute('title') + ']' : ''),
        childW: Math.round(er.width), parentW: Math.round(pr.width),
        parentPad: pcs.padding, parentDisplay: pcs.display,
        over: Math.round(er.right - pr.right),
      });
    }
  }

  // Sidebar taller than the viewport is fine when it is a scroll container
  // (which it is by design); only flag it when content is actually clipped.
  const sb = document.querySelector('.sidebar');
  if (sb && sb.scrollHeight > sb.clientHeight + 2) {
    const oy = getComputedStyle(sb).overflowY;
    if (oy === 'auto' || oy === 'scroll') out.counts['sidebar-scrollable'] = true;
    else out.problems.push({ kind: 'sidebar-clipped', scrollH: sb.scrollHeight, clientH: sb.clientHeight, overflowY: oy });
  }

  // does the file list have any height?
  const fl = document.querySelector('.filelist');
  if (fl && fl.getBoundingClientRect().height < 60) {
    out.problems.push({ kind: 'filelist-too-short', h: Math.round(fl.getBoundingClientRect().height) });
  }

  return out;
})()`;

try {
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
    '--disable-dev-shm-usage', `--window-size=${WIDTH},${HEIGHT}`,
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page');
    } catch (_) {}
  }
  if (!target) { console.error('no chrome target'); cleanup(2); }

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'exception');
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push((m.params.args || []).map(a => a.value ?? '').join(' '));
  };
  await send('Runtime.enable');
  await send('Page.enable');

  await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(2500);
  await evaluate(`(() => { const u=document.querySelector('.login-card input[type=text]'); const p=document.querySelector('.login-card input[type=password]'); if(!u) return false; u.value='admin'; p.value=${JSON.stringify(PW)}; document.querySelector('.login-card button.primary').click(); return true; })()`);
  await sleep(3200);

  // seed some files so the listing has rows to lay out
  await evaluate(`(async () => {
    const csrf = document.querySelector('meta[name=csrf]')?.content || '';
    return true;
  })()`);
  await sleep(300);

  // optional view state for the capture: THEME=light GRID=1 SPLIT=1 OPEN_MENU=1 DRAWER=1
  if (process.env.DRAWER === '1') {
    await evaluate(`[...document.querySelectorAll('.topbar button')].find(b => b.title === 'Menu')?.click()`);
    await sleep(600);
  }
  if (process.env.GRID === '1') {
    await evaluate(`[...document.querySelectorAll('.topbar button')].find(b => b.title === 'Grid view')?.click()`);
    await sleep(500);
  }
  if (process.env.SPLIT === '1') {
    await evaluate(`[...document.querySelectorAll('.topbar button')].find(b => b.title === 'Toggle split pane')?.click()`);
    await sleep(700);
  }
  if (process.env.THEME === 'light') {
    await evaluate(`[...document.querySelectorAll('.topbar button')].find(b => b.title === 'Toggle theme')?.click()`);
    await sleep(500);
  }
  if (process.env.SELECT === '1') {
    await evaluate(`(() => {
      const r = document.querySelector('.filelist [data-path]');
      if (r) r.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    await sleep(500);
  }
  if (process.env.OPEN_MENU === '1') {
    await evaluate(`(() => {
      const row = document.querySelector('.filelist [data-path]');
      if (!row) return false;
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 40, clientY: r.top + 10 }));
      return true;
    })()`);
    await sleep(400);
  }

  const probe = await evaluate(PROBE);
  console.log(JSON.stringify(probe, null, 2));

  if (errors.length) {
    console.log('\nCONSOLE ERRORS:');
    for (const e of errors.slice(0, 10)) console.log('  ' + e);
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('\nscreenshot written to ' + OUT);
  cleanup(0);
} catch (e) {
  console.error('diagnose error: ' + e.message);
  cleanup(1);
}
