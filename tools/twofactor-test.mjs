#!/usr/bin/env node
/*
 * Two-factor authentication end-to-end test.
 *
 * TOTP codes are generated HERE with Node's crypto, independently of the PHP
 * implementation, so agreement between the two is real evidence the algorithm
 * is right — not a test of a test.
 *
 * Covers: enrolment, the two-stage login, wrong-code rejection, recovery codes
 * (single use), and disabling. Usage: ANSNEW_PW=<pw> node tools/twofactor-test.mjs
 */
import crypto from 'node:crypto';

const BASE = process.argv[2] || 'http://127.0.0.1:8200';
const PW = process.env.ANSNEW_PW;
if (!PW) { console.error('set ANSNEW_PW'); process.exit(2); }

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { console.log('  PASS  ' + label); pass++; }
  else { console.log('  FAIL  ' + label + (extra ? '  (' + extra + ')' : '')); fail++; }
};

/* --- independent RFC 6238 implementation (Node) --- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s) {
  let bits = '';
  for (const c of s.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    bits += B32.indexOf(c).toString(2).padStart(5, '0');
  }
  const out = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;   // Buffer, NOT a string — see below
}
function totp(secret, offsetSteps = 0, period = 30, digits = 6) {
  const counter = Math.floor(Date.now() / 1000 / period) + offsetSteps;
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  // The key MUST be a Buffer. Passing a string makes Node encode it as UTF-8,
  // so any key byte >= 0x80 becomes two bytes and the code silently diverges
  // from every other implementation. (The RFC test vector is pure ASCII, which
  // is exactly why this bug hid there.)
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/* --- tiny cookie jar --- */
const jar = new Map();
// A browser drops the cookie when the server expires it; do the same, or a
// stale session id keeps arriving and every mutating call fails the CSRF check.
const save = (res) => {
  for (const c of (res.headers.getSetCookie?.() || [])) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value === '') jar.delete(name); else jar.set(name, value);
  }
};
function clearCookies() { jar.clear(); }

/** Mirror a browser arriving at the login page: new session, fresh token. */
async function freshSession() {
  clearCookies();
  const res = await fetch(BASE + '/api/bootstrap');
  save(res);
  csrf = (await res.json()).data.csrf;
}
const cookie = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');
const H = () => ({ 'Content-Type': 'application/json', Cookie: cookie(), 'X-CSRF-Token': csrf });

let csrf = '';
async function call(path, method = 'GET', body = null) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? H() : { Cookie: cookie(), 'X-CSRF-Token': csrf },
    body: body ? JSON.stringify(body) : undefined,
  });
  save(res);
  let json = null;
  try { json = await res.json(); } catch (_) { /* non-JSON */ }
  // Login and the 2FA step both rotate the session id and mint a fresh token.
  if (json?.data?.csrf) csrf = json.data.csrf;
  return { status: res.status, json };
}

/* --- bootstrap: base session + csrf --- */
let r = await fetch(BASE + '/api/bootstrap'); save(r);
csrf = (await r.json()).data.csrf;

console.log('== enrolment ==');
// Enrolment is an authenticated operation, so start with a plain login.
r = await call('/api/auth/login', 'POST', { username: 'admin', password: PW });
check('initial single-stage login works', r.status === 200 && !!r.json?.data?.user,
  JSON.stringify(r.json).slice(0, 100));

r = await call('/api/auth/2fa/setup', 'POST', { password: PW });
check('setup requires the password', r.status === 200 && r.json?.data?.secret, JSON.stringify(r.json).slice(0, 100));
const secret = r.json?.data?.secret;
check('secret is base32 (16+ chars)', /^[A-Z2-7]{16,}$/.test(secret || ''), secret);
check('provisioning URI is well formed', /^otpauth:\/\/totp\//.test(r.json?.data?.uri || ''), r.json?.data?.uri);

// A code generated independently must be accepted.
r = await call('/api/auth/2fa/confirm', 'POST', { code: totp(secret) });
check('independently-generated TOTP code confirms enrolment', r.status === 200, JSON.stringify(r.json).slice(0, 120));
const recovery = r.json?.data?.recoveryCodes || [];
check('recovery codes are issued', Array.isArray(recovery) && recovery.length >= 4, 'count=' + recovery.length);
check('recovery codes are grouped and uppercase', recovery.every(c => /^[0-9A-F]{5}(-[0-9A-F]{5}){3}$/.test(c)), JSON.stringify(recovery[0]));

r = await call('/api/auth/2fa');
check('2FA now reports enabled', r.json?.data?.enabled === true, JSON.stringify(r.json));

console.log('== two-stage login ==');
r = await call('/api/auth/login', 'POST', { username: 'admin', password: PW });
check('password alone does NOT grant a session', r.json?.data?.twoFactorRequired === true && !r.json?.data?.user,
  JSON.stringify(r.json).slice(0, 120));

// A wrong code must be refused.
r = await call('/api/auth/2fa', 'POST', { code: '000000' });
check('a wrong code is rejected', r.status === 401, 'status=' + r.status);
// Non-numeric junk too.
r = await call('/api/auth/2fa', 'POST', { code: 'abc' });
check('non-numeric input is rejected', r.status === 401, 'status=' + r.status);

// A code from the PREVIOUS window must still be accepted (clock drift).
r = await call('/api/auth/2fa', 'POST', { code: totp(secret, -1) });
check('sign-in completes with a valid code (drift window)', r.status === 200 && r.json?.data?.user,
  JSON.stringify(r.json).slice(0, 120));
check('session is now real (csrf returned)', !!r.json?.data?.csrf);

console.log('== recovery codes ==');
// Sign out and come back with a recovery code instead of the app.
await call('/api/auth/logout', 'POST'); await freshSession();
r = await call('/api/auth/login', 'POST', { username: 'admin', password: PW });
if (process.env.VERBOSE) console.log('  [dbg] relogin status=' + r.status + ' body=' + JSON.stringify(r.json).slice(0, 160));
check('login requires 2FA again', r.json?.data?.twoFactorRequired === true);
r = await call('/api/auth/2fa', 'POST', { code: recovery[0] });
check('a recovery code signs in', r.status === 200, 'status=' + r.status + ' ' + JSON.stringify(r.json).slice(0, 120));
check('the response flags recovery-code use', r.json?.data?.usedRecoveryCode === true);

// The same code must not work twice.
await call('/api/auth/logout', 'POST'); await freshSession();
await call('/api/auth/login', 'POST', { username: 'admin', password: PW });
r = await call('/api/auth/2fa', 'POST', { code: recovery[0] });
check('a used recovery code is refused (single use)', r.status === 401, 'status=' + r.status);

// A different, still-unused recovery code works.
r = await call('/api/auth/2fa', 'POST', { code: recovery[1] });
check('an unused recovery code still works', r.status === 200, 'status=' + r.status);

console.log('== disable ==');
r = await call('/api/auth/2fa/disable', 'POST', { password: 'wrong-password', code: totp(secret) });
check('disabling needs the right password', r.status === 403, 'status=' + r.status);
r = await call('/api/auth/2fa/disable', 'POST', { password: PW, code: '000000' });
check('disabling needs a valid code too', r.status === 403, 'status=' + r.status);
r = await call('/api/auth/2fa/disable', 'POST', { password: PW, code: totp(secret) });
check('2FA can be disabled with password + code', r.status === 200, JSON.stringify(r.json).slice(0, 100));

// Back to a single-factor login.
await call('/api/auth/logout', 'POST'); await freshSession();
r = await call('/api/auth/login', 'POST', { username: 'admin', password: PW });
check('after disabling, login is single-stage again', r.status === 200 && !!r.json?.data?.user,
  JSON.stringify(r.json).slice(0, 100));

console.log(`\n2FA RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
