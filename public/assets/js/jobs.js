'use strict';
/* Jobs drawer: live background job list with progress + cancel (WS updates). */
import { el, clear, fmtDate } from './util.js';
import { api } from './api.js';
import { on } from './realtime.js';
import { toast } from './ui.js';

let drawer = null;
let listNode = null;
let pollTimer = null;

export function initJobs() {
  on('job.progress', (d) => updateJob(d));
  on('job.done', (d) => {
    updateJob(d);
    if (d && d.status === 'done') toast('Job finished: ' + (d.type || ''), 'ok');
    if (d && d.status === 'error') toast('Job failed: ' + (d.message || d.type || ''), 'err');
    refresh();
  });
  on('notify', (d) => { if (d && d.message) toast(d.message, d.kind || 'info'); });
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
  pollTimer = setInterval(refresh, 5000);
}

export function closeJobs() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (drawer) { drawer.remove(); drawer = null; }
  document.body.classList.remove('jobdrawer-open');
}

export async function refresh() {
  if (!listNode) return;
  try {
    const { jobs } = await api.get('/api/jobs?limit=50');
    clear(listNode);
    if (!jobs.length) { listNode.appendChild(el('div', { class: 'muted', text: 'No jobs yet.' })); return; }
    for (const j of jobs) listNode.appendChild(jobCard(j));
  } catch (_) { /* transient */ }
}

function updateJob(d) {
  // Lightweight in-place update; full refresh covers the rest.
  if (drawer && d && d.id) refresh();
}

function jobCard(j) {
  const st = j.status || 'queued';
  const card = el('div', { class: 'jobcard' },
    el('div', { class: 'row' },
      el('span', { class: 'type', text: j.type }),
      el('span', { class: 'st ' + 'st-' + st, text: st }),
    ),
    el('div', { class: 'prog' }, el('i', { style: `width:${j.progress || 0}%` })),
  );
  if (j.message) card.appendChild(el('div', { class: 'msg', text: j.message }));
  card.appendChild(el('div', { class: 'msg', text: fmtDate(j.created_at) }));
  if (st === 'running' || st === 'queued') {
    card.appendChild(el('div', { class: 'row' },
      el('button', { class: 'btn', text: 'Cancel', onclick: async () => { try { await api.post(`/api/jobs/${encodeURIComponent(j.id)}/cancel`, {}); refresh(); } catch (e) { toast(e.message, 'err'); } } }),
    ));
  }
  return card;
}
