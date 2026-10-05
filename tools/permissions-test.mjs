#!/usr/bin/env node
/*
 * Permission mapping test.
 *
 * Builds a real read-only grant for a real second account, then checks that the
 * SAME action is allowed for the owner and refused for the read-only account —
 * and that the API reports what each can do.
 *
 * Usage: ANSNEW_PW=<admin pw> node tools/permissions-test.mjs [baseUrl]
 */
const BASE = process.argv[2] || 'http://nginx:8080';
const PW = process.env.ANSNEW_PW || 'admin';

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { console.log('  PASS  ' + label); pass++; }
  else { console.log('  FAIL  ' + label + (extra ? '  (' + extra + ')' : '')); fail++; }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeClient() {
  const jar = new Map();
  let csrf = '';
  const save = (res) => { for (const c of (res.headers.getSetCookie?.() || [])) { const [p] = c.split(';'); const i = p.indexOf('='); if (i > 0) { const v = p.slice(i + 1).trim(); if (v) jar.set(p.slice(0, i).trim(), v); } } };
  const cookie = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');
  const client = {
    async bootstrap() {
      const res = await fetch(BASE + '/api/bootstrap'); save(res);
      csrf = (await res.json()).data.csrf;
    },
    async call(path, method = 'GET', body = null) {
      const h = { Cookie: cookie(), 'X-CSRF-Token': csrf };
      if (body) h['Content-Type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
      save(res); const clone = res.clone();
      let json = null; try { json = await res.json(); } catch (_) {}
      if (json?.data?.csrf) csrf = json.data.csrf;
      return { status: res.status, json, text: await clone.text().catch(() => '') };
    },
    async login(u, p) { return client.call('/api/auth/login', 'POST', { username: u, password: p }); },
  };
  return client;
}

const admin = makeClient();
const user = makeClient();

await admin.bootstrap();
await admin.call('/api/auth/login', 'POST', { username: 'admin', password: PW });

const STAMP = Date.now();
const ROLABEL = `Viewer Drive ${STAMP}`;
const USERNAME = `viewer${STAMP}`;

console.log('== setup ==');
// A second account, and a drive where that account can look but not touch.
let r = await admin.call('/api/admin/users', 'POST', {
  username: USERNAME, password: 'Viewer-Pass-1', role: 'user', displayName: 'Viewer',
});
check('a second account can be created', r.status === 200 || /exists/i.test(r.json?.error?.message || ''),
  JSON.stringify(r.json).slice(0, 100));

r = await admin.call('/api/admin/mounts', 'POST', {
  name: `ro-${STAMP}`, label: ROLABEL, adapter: 'local', visibleAll: false,
  readOnly: false, trashEnabled: true,
});
const roName = r.json?.data?.name || `ro-${STAMP}`;
check('a second drive can be created', r.status === 200 || /exists/i.test(r.json?.error?.message || ''),
  JSON.stringify(r.json).slice(0, 100));

// Grant the viewer READ-ONLY access (canWrite = false).
const mounts = (await admin.call('/api/admin/mounts')).json?.data?.mounts || [];
const roRow = mounts.find(m => m.name === roName);
const users = (await admin.call('/api/admin/users')).json?.data?.users || [];
const viewerRow = users.find(u => u.username === USERNAME);
check('the grant targets resolve', !!roRow && !!viewerRow,
  'mount=' + !!roRow + ' user=' + !!viewerRow);

r = await admin.call(`/api/admin/mounts/${roRow.id}`, 'POST', {
  action: 'set-grants',
  grants: [
    { userId: viewerRow.id, canWrite: false },   // the account under test: read-only
    { userId: users.find(u => u.username === 'admin').id, canWrite: true },  // the owner/seeder
  ],
});
check('a read-only grant can be applied', r.status === 200 || r.json?.ok === true,
  JSON.stringify(r.json).slice(0, 120));

// Seed one file on the read-only drive so "see" is testable.
r = await admin.call(`/api/fs/${roName}/mkdir`, 'POST', { path: '/', name: 'docs' });
check('admin can seed the drive', r.status === 200, JSON.stringify(r.json).slice(0, 100));

console.log('== capability map ==');
await user.bootstrap();
await user.login(USERNAME, 'Viewer-Pass-1');
r = await user.call('/api/mounts');
const viewerMounts = r.json?.data?.mounts || [];
const ro = viewerMounts.find(m => m.name === roName);
const visible = viewerMounts.some(m => m.name === 'local');
check('the read-only drive is visible to the granted user', !!ro, JSON.stringify(mounts.map(m => m.name)));
check('shared (visible_all) drives are visible to everyone', visible === true,
  'local visible=' + visible);
check('the capability map is published', !!ro?.capabilities, JSON.stringify(ro));
check('read-only drive maps write/create/rename/delete to false',
  ro?.capabilities?.write === false && ro?.capabilities?.create === false
  && ro?.capabilities?.rename === false && ro?.capabilities?.delete === false,
  JSON.stringify(ro?.capabilities));
check('read-only drive still allows list/read/share',
  ro?.capabilities?.list === true && ro?.capabilities?.read === true && ro?.capabilities?.share === true,
  JSON.stringify(ro?.capabilities));

r = await admin.call('/api/mounts');
const ownerMounts = (r.json?.data?.mounts || []).find(m => m.name === roName);
check('the owner maps the same drive to full access',
  ownerMounts?.capabilities?.write === true, JSON.stringify(ownerMounts?.capabilities));

console.log('== what the read-only account can DO ==');
check('can list the drive', (await user.call(`/api/fs/${roName}/list?path=/`)).status === 200);

r = await user.call(`/api/fs/${roName}/mkdir`, 'POST', { path: '/', name: 'nope' });
check('cannot create a folder', r.status === 403, 'status=' + r.status + ' ' + (r.json?.error?.message || ''));

r = await user.call(`/api/fs/${roName}/file`, 'POST', { path: '/', name: 'nope.txt' });
check('cannot create a file', r.status === 403, 'status=' + r.status);

r = await user.call(`/api/fs/${roName}/rename`, 'POST', { path: '/docs', name: 'docs2' });
check('cannot rename', r.status === 403, 'status=' + r.status);

// THE one that used to slip through: deleting on a read-only drive.
r = await user.call(`/api/fs/${roName}/delete`, 'POST', { path: '/docs' });
check('cannot delete (this hole is new-closed)', r.status === 403,
  'status=' + r.status + ' ' + (r.json?.error?.message || ''));

r = await user.call(`/api/fs/${roName}/delete-batch`, 'POST', { items: [{ path: '/docs' }] });
check('cannot batch-delete', r.status === 403, 'status=' + r.status);

// Moving INTO the read-only drive from a readable one is refused too — the
// viewer can read `local` (visible_all) but cannot write to their own drive.
r = await admin.call('/api/fs/local/mkdir', 'POST', { path: '/', name: `mv-src-${STAMP}` });
await admin.call('/api/fs/local/file', 'POST', { path: `/mv-src-${STAMP}`, name: 'a.txt' });
r = await user.call('/api/fs/local/move-batch', 'POST', {
  items: [{ path: `/mv-src-${STAMP}/a.txt` }], destDir: '/', destMount: roName,
});
const refused = r.status >= 400 || (r.json?.data?.failed || []).length > 0;
check('cannot move into the read-only drive', refused, JSON.stringify(r.json).slice(0, 120));

// Reading is still fine.
r = await user.call(`/api/fs/${roName}/list?path=/docs`);
check('can still list (read-only is not no-access)', r.status === 200 && (r.json?.data?.entries || []).length >= 0);

// And the drive really is untouched.
r = await admin.call(`/api/fs/${roName}/list?path=/`);
const still = (r.json?.data?.entries || []).map(e => e.path);
check('nothing was deleted by the read-only account', still.includes('/docs'), JSON.stringify(still));

console.log('== cleanup ==');
await admin.call(`/api/fs/${roName}/delete-batch`, 'POST', { items: [{ path: '/docs' }], permanent: true });
await admin.call(`/api/fs/local/delete-batch`, 'POST', { items: [{ path: `/mv-src-${STAMP}` }], permanent: true });

console.log(`\nPERMISSIONS RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
