'use strict';
/*
 * Full-drive backup.
 *
 * The browser never touches the data: it creates a run, the worker copies the
 * drive, and this module only renders state and sends control commands
 * (pause / resume / cancel / verify). Everything is designed around the idea
 * that a backup of a real drive takes hours and will be interrupted at least
 * once — so the UI always offers a way forward, never a dead end.
 */
import { el, clear, fmtSize, fmtDate } from './util.js';
import { api } from './api.js';
import { icon } from './icons.js';
import { toast, toastOk, toastErr, dialog, confirmDialog } from './ui.js';
import { state } from './state.js';

const STATUS_TONE = {
  queued: 'muted',
  running: 'ok',
  paused: 'warn',
  done: 'ok',
  verified: 'ok',
  'verify-failed': 'err',
  verifying: 'ok',
  error: 'err',
  canceled: 'muted',
};

const STATUS_LABEL = {
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  done: 'Completed',
  verified: 'Verified',
  'verify-failed': 'Verification failed',
  verifying: 'Verifying',
  error: 'Interrupted',
  canceled: 'Canceled',
};

const ACTIVE = new Set(['queued', 'running', 'verifying', 'paused']);

function mountLabel(name) {
  const m = (state.mounts || []).find((x) => x.name === name);
  return m ? (m.label || m.name) : name;
}

/* ----------------------------------------------------------------- dialog */

/**
 * Ask for the source and destination and start a run.
 *
 * @param {{mount?:string, path?:string}} preset  defaults taken from the pane
 * @param {Function} onStarted
 */
export function backupDialog(preset = {}, onStarted = null) {
  const drives = state.mounts || [];
  if (!drives.length) { toastErr('No drives available'); return; }

  const srcMount = el('select', { class: 'field-input' },
    ...drives.map((d) => el('option', { value: d.name, text: d.label || d.name })));
  srcMount.value = preset.mount || drives[0].name;

  const srcPath = el('input', { type: 'text', class: 'field-input', value: preset.path || '/' });

  const destMount = el('select', { class: 'field-input' },
    ...drives.map((d) => el('option', { value: d.name, text: d.label || d.name })));
  // Default to a different drive: backing up onto the same drive is refused by
  // the server, so offering it as the default would just produce an error.
  const other = drives.find((d) => d.name !== srcMount.value);
  destMount.value = (other || drives[0]).name;
  srcMount.addEventListener('change', () => {
    if (destMount.value === srcMount.value) {
      const alt = drives.find((d) => d.name !== srcMount.value);
      if (alt) destMount.value = alt.name;
    }
  });

  const destPath = el('input', { type: 'text', class: 'field-input', value: '/' });
  const label = el('input', { type: 'text', class: 'field-input', value: '', placeholder: 'Optional name' });
  const verify = el('input', { type: 'checkbox' });
  verify.checked = true;

  const body = [
    el('p', { class: 'muted', text: 'Every file on the source is copied into a new, timestamped folder on the destination. Nothing is overwritten and nothing is deleted — a cancelled run simply leaves what it copied so far.' }),
    el('label', { class: 'field' }, 'Back up (drive)', srcMount),
    el('label', { class: 'field' }, 'Folder to back up', srcPath),
    el('label', { class: 'field' }, 'Destination drive', destMount),
    el('label', { class: 'field' }, 'Destination folder', destPath),
    el('label', { class: 'field' }, 'Backup name (optional)', label),
    el('label', { class: 'checkbox' }, verify, 'Verify the backup when it finishes (slower, but proves every file arrived)'),
  ];

  dialog({
    title: 'Back up a drive',
    body,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Start backup', kind: 'primary', primary: true,
        onClick: async () => {
          if (srcMount.value === destMount.value) {
            toastErr('Choose a destination drive that is different from the source');
            return false;
          }
          try {
            const r = await api.post('/api/backups', {
              sourceMount: srcMount.value,
              sourcePath: srcPath.value || '/',
              destMount: destMount.value,
              destPath: destPath.value || '/',
              label: label.value.trim(),
              verify: verify.checked,
            });
            toastOk('Backup started');
            if (onStarted) onStarted(r.backup);
          } catch (e) { toastErr(e.message); return false; }
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------- view */

let pollTimer = null;

/**
 * @param {HTMLElement} c
 * @param {{onOpenPath?:Function}} opts
 */
export async function renderBackupsView(c, opts = {}) {
  clear(c);
  stopPolling();

  const page = el('div', { class: 'admin-page' }, el('h2', {}, 'Backups'));
  const bar = el('div', { class: 'admin-toolbar' });
  const add = el('button', { class: 'btn primary' }, icon('shield'), el('span', { text: 'Back up a drive' }));
  add.addEventListener('click', () => backupDialog({}, () => renderBackupsView(c, opts)));
  bar.appendChild(add);
  page.appendChild(bar);

  const wrap = el('div', { class: 'backup-list' });
  page.appendChild(wrap);
  c.appendChild(page);

  let backups = [];
  try {
    backups = (await api.get('/api/backups?limit=50', { cacheKey: 'backups', ttl: 5000, force: true })).backups || [];
  } catch (e) {
    wrap.appendChild(el('div', { class: 'muted', text: e.message }));
    return;
  }

  if (!backups.length) {
    wrap.appendChild(el('div', { class: 'empty-state' },
      icon('shield', 'empty-ico'),
      el('div', { class: 'empty-title', text: 'No backups yet' }),
      el('div', { class: 'empty-sub muted', text: 'Back up a whole drive to another drive. Runs can be paused, resumed and verified.' }),
    ));
    return;
  }

  for (const b of backups) wrap.appendChild(backupCard(b, () => renderBackupsView(c, opts), opts));

  // Keep live runs moving: the job pushes progress, but the backup row (files,
  // bytes, phase) only lives in this endpoint.
  if (backups.some((b) => ACTIVE.has(b.status))) startPolling(c, opts);
}

function startPolling(c, opts) {
  stopPolling();
  pollTimer = setInterval(async () => {
    // Stop as soon as the user navigated away from this view.
    if (!document.body.contains(c)) { stopPolling(); return; }
    try {
      const list = (await api.get('/api/backups?limit=50', { cacheKey: 'backups', ttl: 0, force: true })).backups || [];
      renderBackupRows(c, list, opts);
      if (!list.some((b) => ACTIVE.has(b.status))) stopPolling();
    } catch (_) { stopPolling(); }
  }, 3000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/** Replace only the cards, so the toolbar and scroll position survive. */
function renderBackupRows(c, list, opts) {
  const wrap = c.querySelector('.backup-list');
  if (!wrap) return;
  clear(wrap);
  for (const b of list) wrap.appendChild(backupCard(b, () => renderBackupsView(c, opts), opts));
}

function backupCard(b, refresh, opts) {
  const pct = b.percent !== null && b.percent !== undefined ? b.percent : 0;
  const finished = ['done', 'verified', 'verify-failed', 'canceled', 'error'].includes(b.status);

  const card = el('div', { class: 'backup-card' },
    el('div', { class: 'bc-head' },
      icon('shield', 'ico'),
      el('div', { class: 'bc-title' },
        el('div', { class: 'bc-name', text: b.label || 'Backup' }),
        el('div', { class: 'bc-sub muted', text: `${mountLabel(b.sourceMount)}:${b.sourcePath}  →  ${mountLabel(b.destMount)}:${b.destPath}` }),
      ),
      el('span', { class: 'badge ' + (STATUS_TONE[b.status] || 'muted'), text: STATUS_LABEL[b.status] || b.status }),
    ),
    el('div', { class: 'prog' }, el('i', { style: 'width:' + pct.toFixed(1) + '%' })),
    el('div', { class: 'bc-meta muted', text: metaText(b) }),
    b.error ? el('div', { class: 'bc-err', text: b.error }) : null,
  );

  const actions = el('div', { class: 'bc-actions' });
  const btn = (label, ico, fn, cls = 'btn') => {
    const x = el('button', { class: cls }, icon(ico), el('span', { text: label }));
    x.addEventListener('click', fn);
    actions.appendChild(x);
    return x;
  };

  if (b.status === 'running' || b.status === 'queued') btn('Pause', 'clock', () => act(b, 'pause', refresh));
  if (b.status === 'paused' || b.status === 'error') btn('Resume', 'refresh', () => act(b, 'resume', refresh));
  if (ACTIVE.has(b.status)) btn('Cancel', 'close', () => act(b, 'cancel', refresh), 'btn danger');
  if (finished && b.status !== 'verifying') btn('Verify', 'check', () => act(b, 'verify', refresh, { deep: false }));
  if (finished) btn('Deep verify', 'shield', () => act(b, 'verify', refresh, { deep: true }));
  if (opts.onOpenPath) btn('Open destination', 'folder', () => opts.onOpenPath(b.destMount, b.destPath));
  btn('Remove entry', 'trash', () => forget(b, refresh), 'btn danger');

  card.appendChild(actions);
  return card;
}

function metaText(b) {
  const parts = [];
  if (b.filesTotal) parts.push(`${b.filesDone.toLocaleString()} of ${b.filesTotal.toLocaleString()} files`);
  if (b.bytesTotal) parts.push(`${fmtSize(b.bytesDone)} of ${fmtSize(b.bytesTotal)}`);
  if (b.percent !== null && b.percent !== undefined) parts.push(Math.round(b.percent) + '%');
  if (b.startedAt) parts.push('started ' + fmtDate(Math.floor(Date.parse(b.startedAt.replace(' ', 'T') + 'Z') / 1000)));
  return parts.join(' · ') || 'Waiting to start';
}

async function act(b, action, refresh, body = {}) {
  if (action === 'cancel') {
    const ok = await confirmDialog(
      'Cancel this backup? Files already copied stay on the destination drive, and the run can be resumed later.',
      { title: 'Cancel backup', danger: true, okLabel: 'Cancel backup' },
    );
    if (!ok) return;
  }
  try {
    await api.post(`/api/backups/${encodeURIComponent(b.id)}/${action}`, body);
    toastOk(action === 'verify' ? 'Verification started' : `Backup ${action}d`);
    refresh();
  } catch (e) { toastErr(e.message); }
}

async function forget(b, refresh) {
  const ok = await confirmDialog(
    'Remove this backup from the list? The copied files are NOT deleted — only this record disappears.',
    { title: 'Remove backup entry', danger: true, okLabel: 'Remove entry' },
  );
  if (!ok) return;
  try {
    await api.delete(`/api/backups/${encodeURIComponent(b.id)}`);
    toastOk('Backup entry removed — files kept');
    refresh();
  } catch (e) { toastErr(e.message); }
}
