'use strict';
/*
 * Share links: create from a file or folder, manage from the "Shared links" view.
 *
 * The token is shown ONCE when created (the server stores only its hash), so the
 * dialog makes copying it the primary action and warns that it cannot be shown
 * again — only replaced.
 */
import { el, clear, fmtSize, fmtDate } from './util.js';
import { api, invalidate } from './api.js';
import { state } from './state.js';
import { icon } from './icons.js';
import { dialog, confirmDialog, toastOk, toastErr } from './ui.js';
import { ensureSensitive } from './sensitive.js';

function baseUrl() {
  return window.location.origin + window.location.pathname.replace(/\/index\.php$/, '');
}

/** Build the public URL for a token, keeping any ?page= deep link out of it. */
function shareUrl(token) {
  return `${baseUrl()}s/${encodeURIComponent(token)}`;
}

/**
 * Open the share dialog for one entry.
 * @param {{mount:string, path:string, name:string, type:string}} entry
 */
export function shareDialog(entry) {
  if (!entry || !entry.path) return;

  const password = el('input', { type: 'text', placeholder: 'Optional — at least 4 characters', autocomplete: 'off' });
  const days = el('select', {},
    el('option', { value: '0', text: 'Never expires' }),
    el('option', { value: '1', text: '1 day' }),
    el('option', { value: '7', text: '7 days' }),
    el('option', { value: '30', text: '30 days' }),
    el('option', { value: '90', text: '90 days' }),
  );
  const allowDl = el('input', { type: 'checkbox' });
  allowDl.checked = true;
  const dlLabel = el('label', { class: 'checkbox' }, allowDl, el('span', { text: 'Allow people to download' }));

  const kind = entry.type === 'dir' ? 'folder' : 'file';
  const note = el('p', { class: 'muted', text:
    `Anyone with the link can view this ${kind}` + (entry.type === 'dir'
      ? ' and everything inside it. They cannot change anything.'
      : '. They cannot see anything else in the folder.') });

  const createBtn = el('button', { class: 'btn primary', text: 'Create link', style: 'justify-content:center' });

  const dlg = dialog({
    title: `Share ${kind}: ${entry.name}`,
    body: [
      note,
      el('label', { class: 'field' }, 'Password (optional)', password),
      el('label', { class: 'field' }, 'Link expires', days),
      dlLabel,
      createBtn,
    ],
    buttons: [{ label: 'Cancel' }],
  });

  createBtn.addEventListener('click', async () => {
    createBtn.disabled = true;
    try {
      const r = await api.post('/api/shares', {
        mount: entry.mount,
        path: entry.path,
        password: password.value.trim(),
        expiresDays: parseInt(days.value, 10) || 0,
        allowDownload: allowDl.checked,
      });
      invalidate('shares');
      dlg.close();
      showCreated(r.token, entry.name, r.expiresAt);
    } catch (e) {
      toastErr(e.message);
      createBtn.disabled = false;
    }
  });
}

/** The one screen where the full link is visible, plus the copy action. */
function showCreated(token, name, expiresAt) {
  const url = shareUrl(token);
  const box = el('input', { type: 'text', readonly: 'readonly', value: url, class: 'share-url' });
  box.addEventListener('focus', () => box.select());

  const copy = el('button', { class: 'btn primary', text: 'Copy link', style: 'justify-content:center' });
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      toastOk('Link copied to the clipboard');
    } catch (_) {
      box.select();
      toastErr('Copy failed — select the link and copy manually');
    }
  });

  dialog({
    title: 'Link created',
    body: [
      el('p', { class: 'muted', text: `${name} is now shared.` }),
      box,
      copy,
      el('p', { class: 'muted warning-text', text:
        'This is the only time the full link is shown. It is stored hashed, so it cannot be displayed again — if you lose it, replace the link from "Shared links".' }),
      el('p', { class: 'muted', text: expiresAt
        ? 'Expires ' + fmtDate(Math.floor(new Date(expiresAt).getTime() / 1000)) + '.'
        : 'This link does not expire. Revoke it when you no longer want it public.' }),
    ],
    buttons: [{ label: 'Done', kind: 'primary', primary: true, onClick: () => true }],
  });
  setTimeout(() => { box.focus(); box.select(); }, 60);
}

/* -------------------------------------------------------- management view */

export async function renderSharesView(container, { onChanged }) {
  const page = el('div', { class: 'admin-page' }, el('h2', {}, 'Shared links'));
  page.appendChild(el('p', { class: 'muted', text:
    'Links you have created. Each one is read-only for the person who opens it, and stops working the moment you revoke it.' }));

  let shares = [];
  try {
    shares = (await api.get('/api/shares', { cacheKey: 'shares', ttl: 5000 })).shares || [];
  } catch (e) { toastErr(e.message); }

  if (!shares.length) {
    page.appendChild(el('div', { class: 'empty-state' },
      icon('share', 'empty-ico'),
      el('div', { class: 'empty-title', text: 'Nothing is shared yet' }),
      el('div', { class: 'empty-sub muted', text: 'Right-click any file or folder and choose "Share" to create a link.' }),
    ));
    container.appendChild(page);
    return;
  }

  const table = el('table', { class: 'table' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Name'),
      el('th', {}, 'Kind'),
      el('th', {}, 'Link'),
      el('th', {}, 'Status'),
      el('th', {}, 'Opens'),
      el('th', {}, 'Created'),
      el('th', {}, 'Actions'),
    )));
  const tbody = el('tbody');

  // One-click teardown of every link this user owns. Gated like "clear
  // favourites": a bulk, irreversible action, so it asks for the password
  // and then confirms before wiping the list.
  const removeAll = el('button', { class: 'btn danger' }, icon('trash'), 'Remove all');
  removeAll.addEventListener('click', async () => {
    const ok = await confirmDialog(
      'Remove every share link you have created? Anyone holding one of these links will immediately lose access, and there is no undo.',
      { title: 'Remove all share links', danger: true, okLabel: 'Remove all' });
    if (!ok) return;
    const granted = await ensureSensitive('shares.clear');
    if (!granted) return;
    try {
      const r = await api.delete('/api/shares/all');
      invalidate('shares');
      toastOk((r.removed ?? 0) + ' share link(s) removed');
      if (onChanged) onChanged();
    } catch (e) { toastErr(e.message); }
  });
  page.appendChild(el('div', { class: 'admin-toolbar' }, removeAll));

  for (const s of shares) {
    const status = s.revoked ? 'Revoked' : (s.expired ? 'Expired' : 'Active');
    const statusCell = el('td', { class: 'muted', text: status });
    if (s.active) statusCell.style.color = 'var(--ok, #4ade80)';

    // The link cannot be reconstructed from the database, so the owner manages
    // it by action rather than by URL.
    const actions = el('td', { class: 'row-actions-cell' });
    const replace = el('button', { class: 'btn sm', title: 'Issue a new link and invalidate this one' }, icon('refresh'), 'New link');
    replace.addEventListener('click', () => rotateShare(s, onChanged));
    actions.appendChild(replace);

    const revokeBtn = el('button', { class: 'btn sm danger', title: 'Stop sharing' }, icon('trash'), 'Revoke');
    revokeBtn.addEventListener('click', async () => {
      const ok = await confirmDialog(`Stop sharing "${s.name}"? Anyone with the link will immediately lose access.`,
        { title: 'Revoke link', danger: true, okLabel: 'Revoke' });
      if (!ok) return;
      try {
        await api.delete(`/api/shares/${s.id}`);
        invalidate('shares');
        toastOk('Link revoked');
        if (onChanged) onChanged();
      } catch (e) { toastErr(e.message); }
    });
    actions.appendChild(revokeBtn);

    tbody.appendChild(el('tr', {},
      el('td', {}, el('strong', { text: s.name })),
      el('td', { class: 'muted', text: s.is_dir ? 'Folder' : 'File' }),
      el('td', { class: 'muted', text: 'hashed — use "New link" to re-issue' }),
      statusCell,
      el('td', { class: 'muted', text: String(s.access_count ?? 0) }),
      el('td', { class: 'muted', text: fmtDate(sqlDateToUnix(s.created_at)) }),
      actions,
    ));
  }
  table.appendChild(tbody);
  page.appendChild(table);
  container.appendChild(page);
}

async function rotateShare(share, onChanged) {
  try {
    const r = await api.post(`/api/shares/${share.id}/rotate`);
    invalidate('shares');
    if (onChanged) onChanged();
    showCreated(r.token, share.name, null);
  } catch (e) { toastErr(e.message); }
}

function sqlDateToUnix(value) {
  if (!value) return 0;
  const ms = Date.parse(String(value).replace(' ', 'T') + 'Z');
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}
