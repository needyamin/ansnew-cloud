#!/usr/bin/env node
/**
 * Editor smoke test — loads public/assets/js/editor.js in a real DOM (jsdom)
 * and drives it the way the browser does.
 *
 * WHY THIS EXISTS
 * ---------------
 * The editor is only exercised by a human clicking a file, so a mistake that
 * throws *after* the text has been fetched (a missing variable in the overlay
 * builder, for example) is invisible to the API tests: the server returns 200
 * and simply nothing appears on screen. That is exactly how a
 * "ReferenceError: path is not defined" in buildEditor() shipped once.
 * This test fails loudly instead.
 *
 * Run:
 *   NODE_PATH=<managed workspace>/node_modules node tools/editor-smoke.mjs
 * (or `npm i -D jsdom` in the project and just `node tools/editor-smoke.mjs`)
 *
 * Read-only: it never talks to a real server — fetch is stubbed.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const JS_DIR = join(ROOT, 'public', 'assets', 'js');

/* ---------------------------------------------------------------- jsdom */

let JSDOM;
try {
  ({ JSDOM } = createRequire(import.meta.url)('jsdom'));
} catch {
  console.error('jsdom is not installed. Point NODE_PATH at a node_modules that has it:\n' +
    '  NODE_PATH=/path/to/node_modules node tools/editor-smoke.mjs');
  process.exit(2);
}

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \u2713 ${name}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  \u2717 ${name}  ${detail}`); }
  return cond;
};

/* -------------------------------------------------- module preparation */

/**
 * The SPA modules are plain .js ESM with no package.json `type: module`, so Node
 * refuses to import them directly. Copy them to a scratch dir as .mjs and point
 * the relative imports at the copies.
 */
function stageModules() {
  const out = join(ROOT, '.scratch-editor-smoke');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(JS_DIR)) {
    if (!f.endsWith('.js')) continue;
    const src = readFileSync(join(JS_DIR, f), 'utf8')
      .replace(/from\s+'\.\/([A-Za-z0-9_]+)\.js'/g, "from './$1.mjs'");
    writeFileSync(join(out, f.replace(/\.js$/, '.mjs')), src);
  }
  return out;
}

/* --------------------------------------------------------------- harness */

/** fetch stub: /text returns the file, /write records what was sent. */
function installFetchStub(state) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const json = (data, status = 200) => ({
      ok: status < 400,
      status,
      headers: new Map(),
      json: async () => data,
      text: async () => JSON.stringify(data),
    });

    if (u.includes('/text?')) {
      state.textCalls++;
      return json({ ok: true, data: state.file });
    }
    if (u.includes('/write')) {
      state.writeCalls.push(JSON.parse(opts.body));
      return json({ ok: true, data: { path: state.file.path, name: state.file.name, size: state.file.content.length, written: state.file.content.length, hash: 'newhash' } });
    }
    if (u.includes('/preview?')) {
      return { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0), text: async () => '' };
    }
    return json({ ok: false, error: { code: 'not_found', message: 'stub: ' + u } }, 404);
  };
}

async function boot() {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'http://localhost:9090/',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // Expose the DOM + browser globals the SPA expects. state.js touches
  // localStorage at import time, so these must exist BEFORE the import.
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Node = window.Node;
  globalThis.Element = window.Element;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.XMLHttpRequest = window.XMLHttpRequest;
  globalThis.localStorage = window.localStorage;
  globalThis.sessionStorage = window.sessionStorage;
  // Node 22 defines navigator/location as getter-only on globalThis, so a plain
  // assignment throws — define them instead, and tolerate a locked-down host.
  for (const [key, value] of [['navigator', window.navigator], ['location', window.location]]) {
    try {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    } catch { /* keep Node's own */ }
  }
  globalThis.history = window.history;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.MouseEvent = window.MouseEvent;
  globalThis.KeyboardEvent = window.KeyboardEvent;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  // jsdom has no layout engine; the SPA only needs these to exist.
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  globalThis.ResizeObserver = window.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
  globalThis.IntersectionObserver = window.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
  globalThis.performance = window.performance || globalThis.performance;
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.cancelAnimationFrame = clearTimeout;

  const staged = stageModules();
  const mod = await import(pathToFileURL(join(staged, 'editor.mjs')).href);
  return { dom, window, mod };
}

/* ------------------------------------------------------------------ run */

async function main() {
  const state = {
    textCalls: 0,
    writeCalls: [],
    file: {
      path: '/notes.txt',
      name: 'notes.txt',
      size: 24,
      mtime: 1791400000,
      content: 'alpha\nbeta\ngamma\n',
      eol: 'lf',
      bom: false,
      encoding: 'utf-8',
      hash: 'abc123',
      readOnly: false,
      readOnlyReason: null,
    },
  };
  installFetchStub(state);

  const { window, mod } = await boot();
  const doc = window.document;

  console.log('\nModule surface');
  check('exports openEditor', typeof mod.openEditor === 'function');
  check('exports isTextEntry', typeof mod.isTextEntry === 'function');
  check('exports TEXT_EXT', mod.TEXT_EXT instanceof Set, `${mod.TEXT_EXT && mod.TEXT_EXT.size} extensions`);

  console.log('\nText detection — known text extensions');
  for (const [name, want] of [
    ['notes.txt', true], ['app.js', true], ['config.yaml', true], ['Dockerfile', true],
    ['data.json', true], ['script.py', true], ['query.sql', true], ['README', true],
    ['icon.svg', true], ['subtitles.srt', true],
  ]) {
    const got = mod.isTextEntry({ name, type: 'file' });
    check(`isTextEntry(${name}) === ${want}`, got === want, got === want ? '' : `got ${got}`);
  }

  console.log('\nText detection — UNKNOWN extensions open the editor');
  for (const name of ['archive.dat', 'mystery.xyz', 'data.foo', 'backup.bak', 'no-extension',
    'file.', 'x.qqq', 'notes.unknownext']) {
    const got = mod.isTextEntry({ name, type: 'file' });
    check(`isTextEntry(${name}) === true`, got === true, got === true ? '' : `got ${got}`);
  }
  check('a file with no extension at all opens the editor',
    mod.isTextEntry({ name: 'myapp', type: 'file' }) === true);

  console.log('\nText detection — media and binary formats do NOT');
  for (const name of ['photo.png', 'clip.mp4', 'song.flac', 'movie.mkv', 'audio.mp3',
    'scan.pdf', 'bundle.zip', 'installer.exe', 'font.woff2', 'data.sqlite',
    'sheet.xlsx', 'book.epub', 'disk.iso', 'lib.so', 'photo.heic', 'vector.ai']) {
    const got = mod.isTextEntry({ name, type: 'file' });
    check(`isTextEntry(${name}) === false`, got === false, got === false ? '' : `got ${got}`);
  }

  console.log('\nText detection — MIME signal and precedence');
  check('a text MIME beats an unknown extension',
    mod.isTextEntry({ name: 'weird.zzz', type: 'file', mime: 'text/x-python' }) === true);
  check('an image MIME is believed even with no extension',
    mod.isTextEntry({ name: 'blob', type: 'file', mime: 'image/png' }) === false);
  check('a video MIME is believed even with no extension',
    mod.isTextEntry({ name: 'blob', type: 'file', mime: 'video/mp4' }) === false);
  check('an audio MIME is believed even with no extension',
    mod.isTextEntry({ name: 'blob', type: 'file', mime: 'audio/flac' }) === false);
  check('application/octet-stream still opens the editor (sniff decides)',
    mod.isTextEntry({ name: 'thing.dat', type: 'file', mime: 'application/octet-stream' }) === true);
  check('.ts stays TypeScript, not MPEG transport stream',
    mod.isTextEntry({ name: 'app.ts', type: 'file' }) === true);
  check('.obj is left to the sniff (Wavefront OBJ is text)',
    mod.isTextEntry({ name: 'model.obj', type: 'file' }) === true);
  check('a directory never opens the editor',
    mod.isTextEntry({ name: 'docs', type: 'dir' }) === false);

  console.log('\nopenEditor builds the overlay');
  const entry = { name: 'notes.txt', path: '/notes.txt', type: 'file', size: 24, extension: 'txt' };
  let handled;
  let threw = null;
  try {
    handled = await mod.openEditor(entry, 'local');
  } catch (err) {
    threw = err;
  }
  if (!check('openEditor resolves without throwing', threw === null, threw ? String(threw && threw.message) : '')) {
    console.log('\n' + (threw && threw.stack));
  }
  check('openEditor reports it handled the file', handled === true);
  check('the text endpoint was called exactly once', state.textCalls === 1, `calls=${state.textCalls}`);

  const ov = doc.querySelector('.editor-overlay');
  if (!check('an .editor-overlay is in the DOM', !!ov)) {
    console.log(`\nFAIL — ${passed} passed, ${failed} failed\n`);
    process.exit(1);
  }

  const ta = ov.querySelector('textarea.editor-text');
  check('the textarea exists', !!ta);
  check('the textarea holds the file contents', ta && ta.value === state.file.content,
    ta ? JSON.stringify(ta.value) : '');
  check('the header shows the file name', !!ov.querySelector('.editor-bar .name'));
  check('the header shows the full path', ov.querySelector('.editor-bar .path')?.textContent === '/notes.txt',
    ov.querySelector('.editor-bar .path')?.textContent);
  check('the line-number gutter was rendered', ov.querySelector('.editor-gutter')?.textContent.startsWith('1\n2\n3'),
    JSON.stringify(ov.querySelector('.editor-gutter')?.textContent));
  // The editor focuses and parks the caret on line 1 in a 20 ms timeout.
  await new Promise((r) => setTimeout(r, 60));
  check('the caret starts on the first line', /Ln 1, Col 1/.test(ov.querySelector('.editor-status')?.textContent || ''),
    ov.querySelector('.editor-status')?.textContent);
  check('the status bar reports a position', /Ln \d+, Col \d+/.test(ov.querySelector('.editor-status')?.textContent || ''),
    ov.querySelector('.editor-status')?.textContent);
  check('Save is enabled on a writable file', !ov.querySelector('.btn.primary')?.hasAttribute('disabled'));

  console.log('\nEditing and saving');
  ta.value = 'alpha\nbeta\nGAMMA\n';
  ta.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('the dirty dot becomes visible', ov.querySelector('.editor-dirty')?.classList.contains('show'));

  const saveBtn = ov.querySelector('.btn.primary');
  saveBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));

  check('Save posted to /write', state.writeCalls.length === 1, `calls=${state.writeCalls.length}`);
  const sent = state.writeCalls[0] || {};
  check('the POST carries the right path', sent.path === '/notes.txt', String(sent.path));
  check('the POST carries the edited content', sent.content === 'alpha\nbeta\nGAMMA\n', JSON.stringify(sent.content));
  check('the POST carries the concurrency hash', sent.baseHash === 'abc123', String(sent.baseHash));

  console.log('\nCRLF + BOM are preserved on save');
  state.writeCalls.length = 0;
  state.file = { ...state.file, content: 'x\ny\n', eol: 'crlf', bom: true, hash: 'h2' };
  doc.querySelector('.editor-overlay')?.remove();
  await mod.openEditor(entry, 'local');
  const ov2 = doc.querySelector('.editor-overlay');
  check('CRLF file opens with LF in the textarea (browser normalisation)',
    ov2.querySelector('textarea').value === 'x\ny\n');
  check('the status bar shows CRLF', /CRLF/.test(ov2.querySelector('.editor-status')?.textContent || ''));
  ov2.querySelector('textarea').dispatchEvent(new window.Event('input', { bubbles: true }));
  ov2.querySelector('.btn.primary').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  check('save restores CRLF and the BOM', state.writeCalls[0]?.content === '\uFEFFx\r\ny\r\n',
    JSON.stringify(state.writeCalls[0]?.content));
  check('save re-adds the UTF-8 BOM', (state.writeCalls[0]?.content || '').startsWith('\uFEFF'));

  console.log('\nRead-only files');
  state.writeCalls.length = 0;
  state.file = { ...state.file, readOnly: true, readOnlyReason: 'This file type is protected.', eol: 'lf', bom: false };
  doc.querySelector('.editor-overlay')?.remove();
  await mod.openEditor(entry, 'local');
  const ov3 = doc.querySelector('.editor-overlay');
  check('a read-only file still opens', !!ov3);
  check('Save is disabled', ov3.querySelector('.btn.primary')?.hasAttribute('disabled'));
  check('the reason is shown', /protected/.test(ov3.querySelector('.editor-badge')?.textContent || ''),
    ov3.querySelector('.editor-badge')?.textContent);
  check('the textarea is read-only', ov3.querySelector('textarea')?.readOnly === true);

  console.log('\nBinary content falls back');
  globalThis.fetch = async (url) => {
    if (String(url).includes('/text?')) {
      return { ok: false, status: 415, headers: new Map(), json: async () => ({ ok: false, error: { code: 'not_text', message: 'Not a text file' } }) };
    }
    return { ok: false, status: 404, headers: new Map(), json: async () => ({ ok: false, error: { code: 'x', message: 'x' } }) };
  };
  doc.querySelector('.editor-overlay')?.remove();
  const handledBinary = await mod.openEditor(entry, 'local');
  check('a 415 makes openEditor return false (hex view takes over)', handledBinary === false, `got ${handledBinary}`);
  check('no overlay was left behind', !doc.querySelector('.editor-overlay'));

  rmSync(join(ROOT, '.scratch-editor-smoke'), { recursive: true, force: true });

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nHarness error:', err);
  process.exit(1);
});
