'use strict';
/* Toast notifications + confirm/prompt dialog helpers. */
import { el, clear } from './util.js';

const box = () => {
  let b = document.querySelector('.toasts');
  if (!b) { b = el('div', { class: 'toasts' }); document.body.appendChild(b); }
  return b;
};

export function toast(message, kind = 'info', ms = 4200) {
  const t = el('div', { class: 'toast ' + kind }, message);
  box().appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; setTimeout(() => t.remove(), 400); }, ms);
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
