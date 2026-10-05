'use strict';
/*
 * Two-factor authentication UI.
 *
 * Enrolment is a three-step wizard: prove the password, add the secret to an
 * authenticator app, confirm with a live code — and recovery codes are shown
 * exactly once, because the server only keeps their hashes.
 */
import { el } from './util.js';
import { api } from './api.js';
import { dialog, toastOk, toastErr } from './ui.js';

const SECRET_GROUP = 4;

/** Group a base32 secret into readable blocks, as authenticator apps display it. */
function prettySecret(secret) {
  return (secret.match(new RegExp('.{1,' + SECRET_GROUP + '}', 'g')) || []).join(' ');
}

export async function twoFactorDialog() {
  let enabled = false;
  try {
    enabled = (await api.get('/api/auth/2fa', { cacheKey: '2fa', ttl: 0 })).enabled;
  } catch (e) {
    toastErr(e.message);
    return;
  }
  enabled ? disableFlow() : enableFlow();
}

/* --------------------------------------------------------------- enable */

function enableFlow() {
  const password = el('input', { type: 'password', placeholder: 'Your password', autocomplete: 'current-password' });
  const nextBtn = el('button', { class: 'btn primary', text: 'Continue', style: 'justify-content:center' });
  const note = el('p', { class: 'muted', text: 'Two-factor authentication adds a second check at sign-in: after your password, your authenticator app produces a code that changes every 30 seconds.' });

  const dlg = dialog({
    title: 'Set up two-factor authentication',
    body: [note, password, nextBtn],
    buttons: [{ label: 'Cancel' }],
    onClose: () => {},
  });

  const proceed = async () => {
    if (!password.value) { toastErr('Enter your password to continue'); return; }
    nextBtn.disabled = true;
    try {
      const r = await api.post('/api/auth/2fa/setup', { password: password.value });
      dlg.close();
      qrStep(r.secret, r.uri);
    } catch (e) {
      toastErr(e.message);
    } finally {
      nextBtn.disabled = false;
    }
  };
  password.addEventListener('keydown', (e) => { if (e.key === 'Enter') proceed(); });
  nextBtn.addEventListener('click', proceed);
  setTimeout(() => password.focus(), 40);
}

/** Show the secret + otpauth URI, then ask for a code to confirm. */
function qrStep(secret, uri) {
  const box = el('code', { class: 'totp-secret', text: prettySecret(secret) });
  const copyBtn = el('button', { class: 'btn sm', text: 'Copy secret' });
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(secret);
      toastOk('Secret copied');
    } catch (_) { toastErr('Copy failed — select the text manually'); }
  });

  const link = el('a', { class: 'muted totp-uri', href: uri, text: uri });
  link.addEventListener('click', (e) => e.preventDefault());

  const code = el('input', {
    type: 'text', placeholder: '123 456', inputmode: 'numeric',
    autocomplete: 'one-time-code', maxlength: '6',
  });
  const confirmBtn = el('button', { class: 'btn primary', text: 'Confirm', style: 'justify-content:center' });
  const hint = el('p', { class: 'muted', text:
    'Add the secret to your authenticator app (Google Authenticator, Authy, 1Password, Aegis…) using "Enter a setup key", then type the 6-digit code it shows.' });

  const dlg = dialog({
    title: 'Add to your authenticator app',
    body: [hint, el('div', { class: 'totp-row' }, box, copyBtn), link, code, confirmBtn],
    buttons: [{ label: 'Cancel' }],
  });

  const confirm = async () => {
    if (!code.value.trim()) { toastErr('Enter the 6-digit code'); return; }
    confirmBtn.disabled = true;
    try {
      const r = await api.post('/api/auth/2fa/confirm', { code: code.value.trim() });
      dlg.close();
      recoveryStep(r.recoveryCodes || []);
    } catch (e) {
      toastErr(e.message);
    } finally {
      confirmBtn.disabled = false;
    }
  };
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm(); });
  confirmBtn.addEventListener('click', confirm);
  setTimeout(() => code.focus(), 40);
}

/** Recovery codes: shown once, only hashes are stored server-side. */
function recoveryStep(codes) {
  const list = el('div', { class: 'recovery-codes' }, ...codes.map((c) => el('code', { text: c })));
  const copyBtn = el('button', { class: 'btn sm', text: 'Copy all codes' });
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      toastOk('Codes copied');
    } catch (_) { toastErr('Copy failed'); }
  });

  dialog({
    title: 'Save your recovery codes',
    body: [
      el('p', { class: 'muted', text:
        'Each code works once, if you ever lose access to your authenticator app. They are shown only this once — the server stores them hashed and cannot show them again. Print them or store them in a password manager.' }),
      list,
      copyBtn,
    ],
    buttons: [{ label: 'Done', kind: 'primary', primary: true, onClick: () => true }],
  });
}

/* --------------------------------------------------------------- disable */

function disableFlow() {
  const password = el('input', { type: 'password', placeholder: 'Your password', autocomplete: 'current-password' });
  const code = el('input', { type: 'text', placeholder: 'Current 6-digit code', inputmode: 'numeric', maxlength: '40' });
  const note = el('p', { class: 'muted', text:
    'Two-factor authentication is ON. Turning it off requires your password and a current code, so a stolen browser session alone cannot weaken your account.' });

  const dlg = dialog({
    title: 'Turn off two-factor authentication',
    body: [note, password, code],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Turn off', kind: 'danger', primary: true,
        onClick: async () => {
          if (!password.value || !code.value.trim()) {
            toastErr('Password and current code are required');
            return false;
          }
          try {
            await api.post('/api/auth/2fa/disable', { password: password.value, code: code.value.trim() });
            toastOk('Two-factor authentication turned off');
            return true;
          } catch (e) {
            toastErr(e.message);
            return false;
          }
        },
      },
    ],
  });
  void dlg;
}
