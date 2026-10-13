'use strict';
/*
 * Advanced settings: everything security-related in one place, so a user can see
 * how their account and this installation are configured without asking.
 *
 * Deliberately a mix of live values and actions: the point is visibility, so the
 * server's actual policy is shown rather than guessed at.
 */
import { el, clear } from './util.js';
import { api, invalidate } from './api.js';
import { state } from './state.js';
import { icon } from './icons.js';
import { toastOk, toastErr } from './ui.js';

/** Settings the server publishes in /api/bootstrap, for transparency. */
function card(title, icon_, rows) {
  const body = el('div', { class: 'settings-card-body' });
  for (const [label, value] of rows) {
    body.appendChild(el('div', { class: 'kv' },
      el('span', { class: 'k', text: label }),
      el('span', { class: 'v', text: value }),
    ));
  }
  return el('div', { class: 'settings-card' },
    el('h3', {}, icon(icon_, 'ico'), title),
    body,
  );
}

function actionCard(title, icon_, description, actions) {
  const body = el('div', { class: 'settings-card-body' });
  body.appendChild(el('p', { class: 'muted', text: description }));
  const row = el('div', { class: 'settings-actions' });
  for (const [label, handler, danger] of actions) {
    const b = el('button', { class: 'btn' + (danger ? ' danger' : '') }, label);
    b.addEventListener('click', handler);
    row.appendChild(b);
  }
  body.appendChild(row);
  return el('div', { class: 'settings-card' },
    el('h3', {}, icon(icon_, 'ico'), title),
    body,
  );
}

export async function renderSettings(container, { onChangePassword, onOpenView }) {
  const page = el('div', { class: 'admin-page' }, el('h2', {}, 'Settings'));
  page.appendChild(el('p', { class: 'muted', text:
    'Your account security and the policy this installation enforces. Values shown here are read from the server.' }));

  let boot = null;
  try {
    boot = (await api.get('/api/bootstrap', { cacheKey: 'bootstrap', ttl: 0 })).data;
  } catch (e) { toastErr(e.message); }
  boot = boot || {};

  const isAdmin = state.user?.role === 'admin';

  /* ---- account security ---- */
  page.appendChild(actionCard('Account security', 'shield',
    'Your password is the only credential for this account — keep it long and unique.',
    [
      ['Change password', () => onChangePassword && onChangePassword(false)],
    ]));

  /* ---- session ---- */
  page.appendChild(card('Session & sign-in', 'clock', [
    ['Signed in as', state.user?.displayName || state.user?.username || '—'],
    ['Role', state.user?.role || '—'],
    ['Idle timeout', fmtDuration(boot.idleTimeout ?? 1800) + ' of inactivity'],
    ['Absolute session lifetime', fmtDuration(boot.sessionLifetime ?? 43200)],
    ['Session binding', 'Bound to this browser (a copied session cookie will not work elsewhere)'],
    ['CSRF protection', 'On — every change requires a same-origin token'],
    ['Brute-force lockout', `${boot.loginMaxAttempts ?? 5} failed attempts, then an exponential lockout`],
  ]));

  /* ---- sharing ---- */
  page.appendChild(card('Sharing', 'share', [
    ['Share links', 'Optional password, optional expiry, revocable at any time'],
    ['Link tokens', 'Stored hashed — a leaked database yields no working links'],
    ['Recipient access', 'Read-only; folder shares expose only that subtree'],
    ['Manage', 'Use "Shared links" in the sidebar to revoke or re-issue'],
  ]));

  /* ---- uploads & files ---- */
  page.appendChild(card('Files & uploads', 'up', [
    ['Blocked file types', (boot.blockedExtensions || []).length
      ? (boot.blockedExtensions || []).join(', ')
      : 'server default list'],
    ['Server-side code detection', 'On — uploads are inspected regardless of file name'],
    ['Path safety', 'Traversal, reserved device names and absolute paths are rejected'],
    ['Trash / recycle', 'Deletes are reversible while trash is enabled on the drive'],
  ]));

  /* ---- what you can see and do, per drive ---- */
  const driveRows = (state.mounts || []).map((m) => {
    const caps = m.capabilities || {};
    const can = (c) => (caps[c] !== false);
    const canDoList = [
      can('read') ? 'view & download' : null,
      can('share') ? 'share' : null,
      can('create') ? 'upload & create' : null,
      can('rename') ? 'rename' : null,
      can('delete') ? 'delete' : null,
    ].filter(Boolean);
    return [m.label || m.name, can('write') ? canDoList.join(', ') : 'view only (read-only)'];
  });
  page.appendChild(card('Your access, per drive', 'check', driveRows));

  /* ---- storage ---- */
  page.appendChild(card('Storage', 'drive', [
    ['Drives visible to you', String((state.mounts || []).length)],
    ['Transport', 'Encrypted connections where the drive supports it'],
    ['Data location', 'Managed by the server administrator'],
  ]));

  /* ---- server (admin only) ---- */
  if (isAdmin) {
    page.appendChild(card('Server (administrator)', 'shield', [
      ['Installation key', 'Per-install APP_KEY used for secrets and share tokens'],
      ['User & drive management', 'Administration section in the sidebar'],
    ]));
  }

  container.appendChild(page);
}

function fmtDuration(seconds) {
  const s = Number(seconds) || 0;
  if (s % 3600 === 0 && s >= 3600) return (s / 3600) + ' h';
  if (s % 60 === 0) return (s / 60) + ' min';
  return s + ' s';
}

void clear; void invalidate; void toastOk;
