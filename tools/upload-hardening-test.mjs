#!/usr/bin/env node
/* Upload hardening checks: content sniffing, multi-extension names, legit files. */
const BASE = process.env.BASE || 'http://nginx:8080';
const jar = new Map();
const save = (res) => { for (const c of (res.headers.getSetCookie?.() || [])) { const [p] = c.split(';'); const i = p.indexOf('='); if (i > 0) { const v = p.slice(i + 1).trim(); if (v) jar.set(p.slice(0, i).trim(), v); } } };
const cookie = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');

let r = await fetch(BASE + '/api/bootstrap'); save(r);
let csrf = (await r.json()).data.csrf;
r = await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie(), 'X-CSRF-Token': csrf },
  body: JSON.stringify({ username: 'admin', password: process.env.ANSNEW_PW || 'admin' }),
});
save(r); csrf = (await r.json()).data.csrf;

async function upload(name, content) {
  const fd = new FormData();
  fd.append('path', '/'); fd.append('conflict', 'rename');
  fd.append('files[]', new Blob([content], { type: 'application/octet-stream' }), name);
  const res = await fetch(BASE + '/api/upload/local', { method: 'POST', headers: { Cookie: cookie(), 'X-CSRF-Token': csrf }, body: fd });
  return { status: res.status, json: await res.json().catch(() => null) };
}

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { if (ok) { console.log('  PASS  ' + label); pass++; } else { console.log('  FAIL  ' + label + (extra ? '  (' + extra + ')' : '')); fail++; } };

const php = '<?php echo "pwned"; ?>';
r = await upload('shell.jpg', php);
check('PHP content named .jpg is rejected', r.status >= 400 || r.json?.ok === false, JSON.stringify(r.json).slice(0, 100));
r = await upload('shell.php.txt', php);
check('PHP content named shell.php.txt is rejected', r.status >= 400 || r.json?.ok === false, JSON.stringify(r.json).slice(0, 100));
r = await upload('plain.php', php);
check('a .php file is rejected by extension', r.status >= 400 || r.json?.ok === false, JSON.stringify(r.json).slice(0, 100));

// A real image must still go through.
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
r = await upload('photo.jpg', jpeg);
check('a real JPEG still uploads', r.json?.ok === true, JSON.stringify(r.json).slice(0, 100));

// Text file, no PHP tag.
r = await upload('notes.txt', 'just some text\n');
check('a plain text file still uploads', r.json?.ok === true, JSON.stringify(r.json).slice(0, 100));

// Clean up whatever landed.
for (const p of ['/photo.jpg', '/notes.txt']) {
  await fetch(BASE + '/api/fs/local/delete-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie(), 'X-CSRF-Token': csrf },
    body: JSON.stringify({ items: [{ path: p }], permanent: true }),
  });
}
console.log(`\nUPLOAD-HARDENING RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
