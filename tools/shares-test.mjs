#!/usr/bin/env node
/*
 * Share links, URL deep-linking, and the folder empty state.
 *
 * The share checks hit the PUBLIC page with no cookies at all — that is the whole
 * contract: someone with no account must be able to open the link and nothing else.
 */
const BASE = process.argv[2] || process.env.BASE || 'http://nginx:8080';
const PW = process.env.ANSNEW_PW || 'admin';

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { console.log('  PASS  ' + label); pass++; }
  else { console.log('  FAIL  ' + label + (extra ? '  (' + extra + ')' : '')); fail++; }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const jar = new Map();
const save = (res) => { for (const c of (res.headers.getSetCookie?.() || [])) { const [p] = c.split(';'); const i = p.indexOf('='); if (i > 0) { const v = p.slice(i + 1).trim(); if (v) jar.set(p.slice(0, i).trim(), v); } } };
const cookie = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');
let csrf = '';

async function call(path, method = 'GET', body = null) {
  const h = { Cookie: cookie(), 'X-CSRF-Token': csrf };
  if (body) h['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  save(res);
  // Clone BEFORE reading: a body can only be consumed once.
  const clone = res.clone();
  let json = null;
  try { json = await res.json(); } catch (_) { /* html or empty */ }
  if (json?.data?.csrf) csrf = json.data.csrf;
  const text = await clone.text().catch(() => '');
  return { status: res.status, json, text };
}

async function freshSession() {
  jar.clear();
  const res = await fetch(BASE + '/api/bootstrap');
  save(res);
  csrf = (await res.json()).data.csrf;
}

async function upload(name, content) {
  const fd = new FormData();
  fd.append('path', '/'); fd.append('conflict', 'rename');
  fd.append('files[]', new Blob([content], { type: 'text/plain' }), name);
  return await fetch(BASE + '/api/upload/local', { method: 'POST', headers: { Cookie: cookie(), 'X-CSRF-Token': csrf }, body: fd });
}

/* ---- setup ---- */
await freshSession();
await call('/api/auth/login', 'POST', { username: 'admin', password: PW });
const STAMP = Date.now();
const FOLDER = `share-${STAMP}`;
const FILE = `shared-${STAMP}.txt`;
const PRIVATE = `secret-${STAMP}.txt`;

await call('/api/fs/local/mkdir', 'POST', { path: '/', name: FOLDER });
await upload(`${FOLDER}/${FILE}`, 'this file is shared\n');
await upload(PRIVATE, 'this file must stay private\n');
await sleep(300);

const listDir = async (p) => {
  const r = await call(`/api/fs/local/list?path=${encodeURIComponent(p)}`);
  return (r.json?.data?.entries || []).map(e => e.path);
};

console.log('== empty state correctness ==');
// A folder with content must list it; a folder without must not.
const withContent = await listDir('/' + FOLDER);
check('folder with a file lists that file', withContent.includes(`/${FOLDER}/${FILE}`),
  JSON.stringify(withContent));
const emptyDir = `empty-${STAMP}`;
await call('/api/fs/local/mkdir', 'POST', { path: '/', name: emptyDir });
const emptyList = await listDir('/' + emptyDir);
check('genuinely empty folder lists nothing', emptyList.length === 0, JSON.stringify(emptyList));

// The browser must not show "This folder is empty" over a non-empty folder.
const browser = await fetch(`${BASE}/api/fs/local/list?path=${encodeURIComponent('/' + FOLDER)}`,
  { headers: { Cookie: cookie() } });
const shown = (await browser.json()).data.entries.length;
check('listing API returns the entries the pane will render', shown > 0, 'entries=' + shown);

console.log('== share a file ==');
let r = await call('/api/shares', 'POST', { mount: 'local', path: `/${FOLDER}/${FILE}` });
check('a share link can be created', r.status === 200 && !!r.json?.data?.token, JSON.stringify(r.json).slice(0, 120));
const fileToken = r.json?.data?.token;
check('the token looks like base64url (43 chars)', /^[A-Za-z0-9_-]{40,50}$/.test(fileToken || ''), fileToken);

// The public page must be reachable with NO cookies and NO CSRF token.
const pub = await fetch(`${BASE}/s/${encodeURIComponent(fileToken)}`);
const pubHtml = await pub.text();
check('the public link works with no session', pub.status === 200, 'status=' + pub.status);
check('the public page names the shared file', pubHtml.includes(FILE), 'len=' + pubHtml.length);
check('the public page does not leak other files', !pubHtml.includes(PRIVATE));

// Download must work publicly too.
const dl = await fetch(`${BASE}/s/${encodeURIComponent(fileToken)}/download`);
const body = await dl.text();
check('the shared file is downloadable with no session', dl.status === 200 && body.includes('this file is shared'),
  'status=' + dl.status);

// Sibling content must NOT be reachable by editing the path.
const sibling = await fetch(
  `${BASE}/s/${encodeURIComponent(fileToken)}/download?path=${encodeURIComponent('../' + PRIVATE)}`);
check('path traversal out of the share is refused', sibling.status >= 400, 'status=' + sibling.status);
const outside = await fetch(
  `${BASE}/s/${encodeURIComponent(fileToken)}/download?path=${encodeURIComponent('/' + PRIVATE)}`);
check('an absolute path outside the share is refused', outside.status >= 400, 'status=' + outside.status);

console.log('== share a folder ==');
r = await call('/api/shares', 'POST', { mount: 'local', path: `/${FOLDER}` });
check('a folder can be shared', r.status === 200 && r.json?.data?.isDir === true, JSON.stringify(r.json).slice(0, 100));
const folderToken = r.json?.data?.token;

const folderPage = await (await fetch(`${BASE}/s/${encodeURIComponent(folderToken)}`)).text();
check('the shared folder lists its contents publicly', folderPage.includes(FILE), 'len=' + folderPage.length);
check('the folder page does not leak files outside it', !folderPage.includes(PRIVATE));

// Password protection.
r = await call('/api/shares', 'POST', { mount: 'local', path: `/${FOLDER}`, password: 'letmein' });
const protToken = r.json?.data?.token;
const noPw = await fetch(`${BASE}/s/${encodeURIComponent(protToken)}`);
check('a password-protected link asks for the password', noPw.status === 401, 'status=' + noPw.status);
const withPw = await fetch(`${BASE}/s/${encodeURIComponent(protToken)}?password=letmein`);
check('the right password opens it', withPw.status === 200, 'status=' + withPw.status);

// Expiry.
r = await call('/api/shares', 'POST', { mount: 'local', path: `/${FOLDER}`, expiresDays: 900 });
check('an over-long expiry is refused', r.status >= 400, 'status=' + r.status);

console.log('== revoke & rotate ==');
r = await call('/api/shares');
const mine = (r.json?.data?.shares || []).find(s => s.token && false) || (r.json?.data?.shares || [])[0];
check('shares are listed for the owner', (r.json?.data?.shares || []).length >= 3,
  'count=' + (r.json?.data?.shares || []).length);

// Create a throwaway share, rotate it, confirm the old token dies.
r = await call('/api/shares', 'POST', { mount: 'local', path: `/${FOLDER}/${FILE}` });
const throwToken = r.json?.data?.token;
const throwId = r.json?.data?.id;
r = await call(`/api/shares/${throwId}/rotate`, 'POST');
const newToken = r.json?.data?.token;
check('rotating issues a different token', !!newToken && newToken !== throwToken);
check('the old token no longer resolves',
  (await fetch(`${BASE}/s/${encodeURIComponent(throwToken)}`)).status === 404);
check('the new token works',
  (await fetch(`${BASE}/s/${encodeURIComponent(newToken)}`)).status === 200);

r = await call(`/api/shares/${throwId}`, 'DELETE');
check('a share can be revoked', r.status === 200);
check('a revoked token stops working immediately',
  (await fetch(`${BASE}/s/${encodeURIComponent(newToken)}`)).status === 404);

console.log('== URL deep-linking ==');
// The client-side URL sync is exercised by the browser suite; here we confirm the
// server serves the app shell for a deep link, so a reload cannot 404.
for (const url of ['/?mount=local&path=%2F', '/?mount=local&path=' + encodeURIComponent('/' + FOLDER)]) {
  const res = await fetch(BASE + url);
  const html = await res.text();
  check(`app shell served for ${decodeURIComponent(url)}`, res.status === 200 && html.includes('<script'),
    'status=' + res.status);
}

/* ---- cleanup ---- */
// The public-page fetches above never touch the session, but re-establishing a
// clean one makes the delete below immune to any token drift from the rotate
// and revoke calls.
await freshSession();
const rm = await call('/api/fs/local/delete-batch', 'POST', {
  items: [{ path: '/' + FOLDER }, { path: '/' + PRIVATE }, { path: '/' + emptyDir }],
  permanent: true,
});
const leftovers = await listDir('/');
const stillMine = leftovers.filter(p => p.includes(String(STAMP)));
check('fixtures cleaned up', stillMine.length === 0,
  'delete=' + JSON.stringify(rm.json).slice(0, 120) + ' left=' + JSON.stringify(leftovers));

console.log(`\nSHARES RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
