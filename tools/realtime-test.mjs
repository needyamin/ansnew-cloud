#!/usr/bin/env node
/*
 * ANSNEW CLOUD realtime (fs.changed) end-to-end check.
 *
 * Connects a real WebSocket client, then performs mutations over the REST API
 * and asserts the server announces each one. This is what lets open panes
 * revalidate on their own instead of waiting for a manual refresh.
 *
 * Runs entirely in Node, so it does not depend on a browser: headless Chrome in
 * some sandboxed/containerised environments never delivers WebSocket frames to
 * page scripts, which makes the equivalent in-browser assertion unreliable.
 *
 * Usage: ANSNEW_PW=<password> node tools/realtime-test.mjs [baseUrl]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8200';
const PW = process.env.ANSNEW_PW;
if (!PW) { console.error('set ANSNEW_PW'); process.exit(2); }

const jar = new Map();
const save = (res) => {
  for (const c of (res.headers.getSetCookie?.() || [])) {
    const [p] = c.split(';');
    const i = p.indexOf('=');
    if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
  }
};
const cookie = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');
const H = () => ({ 'Content-Type': 'application/json', Cookie: cookie() });

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { console.log('  PASS  ' + label); pass++; }
  else { console.log('  FAIL  ' + label + (extra ? '  (' + extra + ')' : '')); fail++; }
};

let r = await fetch(BASE + '/api/bootstrap'); save(r);
let csrf = (await r.json()).data.csrf;
r = await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { ...H(), 'X-CSRF-Token': csrf },
  body: JSON.stringify({ username: 'admin', password: PW }),
});
save(r);
const login = await r.json();
if (!login.ok) { console.error('login failed', login); process.exit(1); }
csrf = login.data.csrf;

const post = (path, body) => fetch(BASE + path, {
  method: 'POST', headers: { ...H(), 'X-CSRF-Token': csrf }, body: JSON.stringify(body),
}).then((res) => res.json());

r = await fetch(BASE + '/api/ws/ticket', {
  method: 'POST', headers: { ...H(), 'X-CSRF-Token': csrf },
  body: JSON.stringify({ channel: 'events' }),
});
const ticket = (await r.json()).data.ticket;

/** Collected fs.changed events, newest last. */
const changes = [];
const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?channel=events&ticket=${encodeURIComponent(ticket)}`);
const hello = await new Promise((resolve) => {
  let got = null;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.event === 'hello' && !got) { got = m; resolve(m); }
    if (m.event === 'fs.changed') changes.push(m.data);
  };
  ws.onerror = () => resolve(null);
  setTimeout(() => resolve(got), 5000);
});
check('websocket connected and greeted', !!hello, hello ? '' : 'no hello frame received');

const STAMP = Date.now();
const FOLDER = `rt-${STAMP}`;
const FILE = `rt-${STAMP}.txt`;
const MOVE_DIR = `rt-${STAMP}-dst`;

/** Wait for an fs.changed event matching a predicate. */
async function waitChange(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hit = changes.find(predicate);
    if (hit) return hit;
    await new Promise((res) => setTimeout(res, 120));
  }
  return null;
}

const dirsFor = (e, mount = 'local') => (e && e.mounts && e.mounts[mount]) || [];

console.log('== create ==');
changes.length = 0;
await post('/api/fs/local/mkdir', { path: '/', name: FOLDER });
const onMkdir = await waitChange((e) => e.reason === 'mkdir');
check('mkdir announces the parent directory', dirsFor(onMkdir).includes('/'),
  JSON.stringify(onMkdir));

changes.length = 0;
await post('/api/fs/local/file', { path: '/', name: FILE });
const onCreate = await waitChange((e) => e.reason === 'create');
check('file creation announces the parent directory', dirsFor(onCreate).includes('/'),
  JSON.stringify(onCreate));

console.log('== rename ==');
changes.length = 0;
await post('/api/fs/local/mkdir', { path: '/', name: MOVE_DIR });
await waitChange((e) => e.reason === 'mkdir');
changes.length = 0;
const RENAMED = FILE.replace('.txt', '-renamed.txt');
await post('/api/fs/local/rename', { path: '/' + FILE, name: RENAMED });
const onRename = await waitChange((e) => e.reason === 'rename');
check('rename announces old and new locations', dirsFor(onRename).includes('/'),
  JSON.stringify(onRename));

console.log('== move (cross-directory) ==');
changes.length = 0;
await post('/api/fs/local/move', { path: '/' + RENAMED, destDir: '/' + MOVE_DIR, destMount: 'local' });
const onMove = await waitChange((e) => e.reason === 'move');
check('move announces the source directory', dirsFor(onMove).includes('/'), JSON.stringify(onMove));
check('move announces the destination directory', dirsFor(onMove).includes('/' + MOVE_DIR),
  JSON.stringify(onMove));

console.log('== upload ==');
changes.length = 0;
const fd = new FormData();
fd.append('path', '/' + MOVE_DIR);
fd.append('conflict', 'rename');
fd.append('files', new Blob(['realtime test'], { type: 'text/plain' }), `up-${STAMP}.txt`);
const upRes = await fetch(BASE + '/api/upload/local', {
  method: 'POST', headers: { Cookie: cookie(), 'X-CSRF-Token': csrf }, body: fd,
});
const upJson = await upRes.json();
check('upload succeeded', upJson.ok === true, JSON.stringify(upJson).slice(0, 120));
const onUpload = await waitChange((e) => e.reason === 'upload');
check('upload announces the target directory', dirsFor(onUpload).includes('/' + MOVE_DIR),
  JSON.stringify(onUpload));

console.log('== batch delete ==');
changes.length = 0;
const delRes = await post('/api/fs/local/delete-batch', {
  items: [{ path: '/' + FOLDER }, { path: '/' + MOVE_DIR }],
  permanent: true,
});
check('batch delete succeeded', delRes.ok === true, JSON.stringify(delRes).slice(0, 140));
const onDelete = await waitChange((e) => e.reason === 'delete-batch');
check('batch delete announces the affected directories', dirsFor(onDelete).includes('/'),
  JSON.stringify(onDelete));
check('a single batch produces a single event', changes.filter((e) => e.reason === 'delete-batch').length === 1,
  'events=' + changes.length);

// The batch delete above enqueues jobs for directories; give them a moment.
await new Promise((res) => setTimeout(res, 2500));

console.log('== response integrity ==');
// Regression guard: the notification path used to print the WS server's reply
// into the caller's own response body, corrupting the JSON.
r = await fetch(BASE + '/api/fs/local/list?path=/', { headers: { Cookie: cookie() } });
const raw = await r.text();
let parsed = null;
try { parsed = JSON.parse(raw); } catch (_) { /* left null */ }
check('list response is valid JSON', parsed !== null && parsed.ok === true, raw.slice(0, 80));
check('list response is not polluted by the notify call', !raw.startsWith('{"ok":true}{'), raw.slice(0, 40));

r = await fetch(BASE + '/api/fs/local/mkdir', {
  method: 'POST', headers: { ...H(), 'X-CSRF-Token': csrf },
  body: JSON.stringify({ path: '/', name: `rt-int-${STAMP}` }),
});
const mkRaw = await r.text();
let mkParsed = null;
try { mkParsed = JSON.parse(mkRaw); } catch (_) { /* left null */ }
check('mutating response is valid JSON', mkParsed !== null && mkParsed.ok === true, mkRaw.slice(0, 90));
await post('/api/fs/local/delete-batch', { items: [{ path: `/rt-int-${STAMP}` }], permanent: true });

ws.close();
console.log(`\nREALTIME RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
