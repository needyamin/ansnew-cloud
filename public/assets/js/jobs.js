'use strict';
/*
 * Jobs drawer: live background job list with progress + cancel.
 *
 * Cards are keyed by job id and updated in place. Progress is polled from
 * /api/jobs (every 3 s) while at least one job is in flight — there is no
 * WebSocket in this build, so the poll IS the live channel.
 */
import { el, clear, fmtDate } from './util.js';
import { api } from './api.js';
import { toast } from './ui.js';

let drawer = null;
let listNode = null;
let pollTimer = null;
/** jobId -> { card, bar, status, msg } */
const cards = new Map();

const ACTIVE = new Set(['queued', 'running']);

export function initJobs() {
  // No push channel in this build; the drawer polls while it is open and
  // something is in flight. Toasts for finished jobs are raised by the poller.
}

export function openJobs() {
  if (drawer) { refresh(); return; }
  drawer = el('div', { class: 'jobdrawer', role: 'dialog', 'aria-label': 'Background jobs' },
    el('header', {},
      'Background jobs',
      el('span', { style: 'flex:1' }),
      el('button', { class: 'btn icon', text: '⟳', title: 'Refresh', onclick: refresh }),
      el('button', { class: 'btn icon', text: '×', title: 'Close', onclick: closeJobs }),
    ),
  );
  listNode = el('div', { class: 'jobs' });
  drawer.appendChild(listNode);
  document.body.appendChild(drawer);
  // Lets CSS shift the upload tray clear instead of the drawer covering it.
  document.body.classList.add('jobdrawer-open');
  refresh();
  startPolling();
}

export function closeJobs() {
  stopPolling();
  if (drawer) { drawer.remove(); drawer = null; }
  listNode = null;
  cards.clear();
  document.body.classList.remove('jobdrawer-open');
}

/** Poll only while something is actually in flight. */
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (!hasActive()) return;
    refresh();
  }, 3000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function hasActive() {
  for (const c of cards.values()) if (ACTIVE.has(c.status)) return true;
  return false;
}

export async function refresh() {
  if (!listNode) return;
  let jobs;
  try { ({ jobs } = await api.get('/api/jobs?limit=50')); } catch (_) { return; }
  render(jobs || []);
}

function render(jobs) {
  if (!listNode) return;
  if (!jobs.length) {
    cards.clear();
    clear(listNode);
    listNode.appendChild(el('div', { class: 'muted', text: 'No jobs yet.' }));
    return;
  }
  const placeholder = listNode.querySelector('.muted');
  if (placeholder) placeholder.remove();

  const seen = new Set();
  jobs.forEach((j, i) => {
    seen.add(j.id);
    let c = cards.get(j.id);
    const isNew = !c;
    if (!c) { c = createCard(j); cards.set(j.id, c); }
    updateCard(c, j);
    // Toast once when a job reaches a terminal state (poll = the only channel).
    if (!isNew && c.status !== 'queued' && c.status !== 'running' && !c.toasted) {
      c.toasted = true;
      if (c.status === 'done') toast('Job finished: ' + (j.type || ''), 'ok');
      if (c.status === 'error') toast('Job failed: ' + (j.message || j.type || ''), 'err');
    }
    // Keep the DOM order aligned with the server's newest-first ordering.
    if (listNode.children[i] !== c.card) listNode.insertBefore(c.card, listNode.children[i] || null);
  });
  for (const [id, c] of [...cards]) {
    if (!seen.has(id)) { c.card.remove(); cards.delete(id); }
  }
  if (!hasActive()) stopPolling();
}

function createCard(j) {
  const bar = el('i', { style: 'width:0%' });
  const statusEl = el('span', { class: 'st', text: j.status || 'queued' });
  const msg = el('div', { class: 'msg' });
  const when = el('div', { class: 'msg', text: fmtDate(j.created_at) });
  const cancelBtn = el('button', { class: 'btn', text: 'Cancel' });
  cancelBtn.addEventListener('click', async () => {
    try {
      await api.post(`/api/jobs/${encodeURIComponent(j.id)}/cancel`, {});
      refresh();
    } catch (e) { toast(e.message, 'err'); }
  });
  const actions = el('div', { class: 'row' }, cancelBtn);
  const card = el('div', { class: 'jobcard' },
    el('div', { class: 'row' },
      el('span', { class: 'type', text: j.type }),
      statusEl,
    ),
    el('div', { class: 'prog' }, bar),
    msg,
    when,
    actions,
  );
  // `status` holds the state string; `statusEl` is the DOM node showing it.
  return { card, bar, statusEl, msg, actions, status: j.status || 'queued', rendered: null, toasted: ACTIVE.has(j.status) ? false : true };
}

function updateCard(c, j) {
  const st = j.status || 'queued';
  c.status = st;
  if (c.rendered !== st) {
    c.statusEl.textContent = st;
    c.statusEl.className = 'st st-' + st;
    c.rendered = st;
  }
  const pct = Math.max(0, Math.min(100, Number(j.progress) || 0));
  c.bar.style.width = pct + '%';
  const text = j.message || '';
  if (c.msg.textContent !== text) c.msg.textContent = text;
  c.actions.hidden = !ACTIVE.has(st);
}
