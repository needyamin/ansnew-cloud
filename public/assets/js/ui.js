'use strict';
/* Toast notifications + confirm/prompt dialog helpers. */
import { el, clear } from './util.js';

const box = () => {
  let b = document.querySelector('.toasts');
  if (!b) { b = el('div', { class: 'toasts' }); document.body.appendChild(b); }
  return b;
};

/**
 * Show a toast. `action` (optional) turns it into an actionable notice — used
 * for "Deleted 3 items  [Undo]".
 * @param {{label:string, onClick:Function}} [action]
 */
export function toast(message, kind = 'info', ms = 4200, action = null) {
  const t = el('div', { class: 'toast ' + kind });
  t.appendChild(el('span', { class: 'msg', text: message }));
  if (action && typeof action.onClick === 'function') {
    const b = el('button', { class: 'toast-action', text: action.label || 'Undo' });
    b.addEventListener('click', () => {
      try { action.onClick(); } finally { t.remove(); }
    });
    t.appendChild(b);
  }
  box().appendChild(t);
  const life = ms + (action ? 4000 : 0);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; setTimeout(() => t.remove(), 400); }, life);
  return t;
}
export const toastOk = (m) => toast(m, 'ok');
export const toastErr = (m) => toast(m, 'err', 6500);
export const toastWarn = (m) => toast(m, 'warn');

function overlay(dlg) {
  const ov = el('div', { class: 'overlay' }, dlg);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  function close() { ov.remove(); }
  dlg.close = close;
  document.body.appendChild(ov);
  return close;
}

export function dialog({ title, body, buttons }) {
  const foot = el('footer');
  const dlg = el('div', { class: 'dialog' }, el('header', { text: title }), el('div', { class: 'body' }, body), foot);
  for (const b of buttons || []) {
    const btn = el('button', {
      class: 'btn ' + (b.kind || ''),
      text: b.label,
      onclick: async () => {
        if (b.onClick) { const keep = await b.onClick(dlg); if (keep === false) return; }
        close();
      },
    });
    if (b.primary) btn.classList.add('primary');
    foot.appendChild(btn);
  }
  const close = overlay(dlg);
  return { dlg, close };
}

export function confirmDialog(message, { title = 'Confirm', danger = false, okLabel = 'OK' } = {}) {
  return new Promise((resolve) => {
    const { dlg, close } = dialog({
      title,
      body: [el('p', { text: message })],
      buttons: [
        { label: 'Cancel', onClick: () => { resolve(false); } },
        { label: okLabel, kind: danger ? 'danger' : 'primary', primary: !danger, onClick: () => { resolve(true); } },
      ],
    });
    dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') { resolve(false); } });
  });
}

export function promptDialog(message, value = '', { title = 'Input', okLabel = 'OK', validate } = {}) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', value, style: 'width:100%' });
    const submit = () => {
      const v = input.value.trim();
      if (validate) {
        const err = validate(v);
        if (err) { errEl.textContent = err; return false; }
      }
      resolve(v);
      return true;
    };
    const errEl = el('div', { class: 'err', style: 'color:var(--err);font-size:12.5px;min-height:16px' });
    const { close } = dialog({
      title,
      body: [el('p', { text: message }), input, errEl],
      buttons: [
        { label: 'Cancel', onClick: () => resolve(null) },
        // submit() returns true on success (-> dialog() closes) and false when
        // validation fails (-> dialog() keeps it open). Returning the negated
        // value here left every prompt dialog stuck open after a valid submit.
        { label: okLabel, kind: 'primary', primary: true, onClick: () => submit() },
      ],
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { if (submit()) close(); } });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

/**
 * Re-enter the account password to authorise a destructive action.
 *
 * Deliberately NOT built on promptDialog(): the value is a secret, so it needs
 * type=password, must never be echoed back into the dialog on a retry, and the
 * error has to come from the server rather than a local validator.
 *
 * `submit` is provided by the caller (see sensitive.js) so this stays a pure
 * view: it never knows that /api/auth/confirm exists.
 *
 * @param {object}   opts
 * @param {string}   opts.message      Why the password is needed.
 * @param {Function} opts.submit       async (password, code) -> {ok:true} | {error:string}
 * @param {boolean}  [opts.needsCode]  Show an authenticator code field (2FA accounts).
 * @returns {Promise<boolean>} true once the server accepted the credentials.
 */
export function passwordDialog({ title = 'Confirm your password', message, submit, needsCode = false, okLabel = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    const pw = el('input', {
      type: 'password', autocomplete: 'current-password',
      placeholder: 'Account password', style: 'width:100%',
      'aria-label': 'Account password',
    });
    const code = needsCode
      ? el('input', {
          type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
          placeholder: '6-digit code', maxlength: '8', style: 'width:100%',
          'aria-label': 'Authenticator code',
        })
      : null;
    const errEl = el('div', { class: 'err', style: 'color:var(--err);font-size:12.5px;min-height:16px' });

    const trySubmit = async () => {
      const value = pw.value;
      if (!value) { errEl.textContent = 'Enter your password'; return false; }
      errEl.textContent = 'Checking…';
      try {
        const r = await submit(value, code ? code.value.trim() : '');
        if (r && r.ok) { resolve(true); return true; }
        errEl.textContent = (r && r.error) || 'Password is incorrect';
        // Clear the field: a wrong password must not sit there in plain text
        // waiting to be re-submitted by a stray Enter.
        pw.value = '';
        pw.focus();
        return false;
      } catch (e) {
        errEl.textContent = e && e.message ? e.message : 'Confirmation failed';
        return false;
      }
    };

    const body = [el('p', { text: message || 'Enter your password to continue.' })];
    if (code) {
      body.push(el('label', { class: 'field' }, 'Account password', pw));
      body.push(el('label', { class: 'field' }, 'Authenticator code', code));
    } else {
      body.push(el('label', { class: 'field' }, 'Account password', pw));
    }
    body.push(errEl);

    const { close } = dialog({
      title,
      body,
      buttons: [
        { label: 'Cancel', onClick: () => resolve(false) },
        { label: okLabel, kind: 'primary', primary: true, onClick: () => trySubmit() },
      ],
    });

    const onEnter = (e) => { if (e.key === 'Enter') { if (trySubmit()) close(); } };
    pw.addEventListener('keydown', onEnter);
    if (code) code.addEventListener('keydown', onEnter);
    setTimeout(() => pw.focus(), 30);
  });
}

export function choiceDialog(message, choices, { title = 'Choose' } = {}) {
  return new Promise((resolve) => {
    const { close } = dialog({
      title,
      body: [el('p', { text: message }), ...choices.map(c =>
        el('button', { class: 'btn', style: 'justify-content:flex-start', text: c.label, onclick: () => { resolve(c.value); close(); } }))],
      buttons: [{ label: 'Cancel', onClick: () => resolve(null) }],
    });
  });
}
