'use strict';
/*
 * Undo / Redo over file operations.
 *
 * The stack lives on the server (op_history), so it survives a reload and is
 * shared between tabs. This module is the client half: it records a completed
 * operation, asks for it to be reversed or repeated, and invalidates the
 * listings that changed so every open pane agrees.
 *
 * An operation that crossed drives is undone through a background job; the
 * caller gets a job id back instead of an instant result and says so.
 */
import { api, invalidateList } from './api.js';
import { state } from './state.js';
import { toast, toastOk, toastErr, toastWarn } from './ui.js';
import { dirOf } from './fsops.js';

state.history = { entries: [], canUndo: false, canRedo: false };

/** Invalidate every directory an operation touched, on both sides. */
function invalidateItems(op, mount, destMount, items) {
  const m2 = destMount || mount;
  for (const it of items || []) {
    if (typeof it === 'string') { invalidateList(mount, dirOf(it)); continue; }
    if (it.from) invalidateList(mount, dirOf(it.from));
    if (it.to) invalidateList(m2, dirOf(it.to));
    if (it.path) invalidateList(mount, dirOf(it.path));
  }
}

/**
 * Record a completed operation so it can be undone.
 *
 * Fire-and-forget by design: failing to record must never fail the operation
 * the user just performed.
 *
 * @param {'move'|'copy'|'rename'|'delete'|'mkdir'} op
 * @param {string} mount
 * @param {string} summary                     shown in the history menu
 * @param {{mount:string,destMount?:string,items:Array}} payload
 */
export async function recordOp(op, mount, summary, payload) {
  invalidateItems(op, mount, payload.destMount, payload.items);
  try {
    await api.post('/api/history', { op, mount, summary, payload });
  } catch (_) { /* non-critical */ }
  refreshHistory();
}

/** Re-read the stack (and therefore what Undo/Redo can currently do). */
export async function refreshHistory() {
  try {
    const r = await api.get('/api/history?limit=40', { cacheKey: 'history', ttl: 5000, force: true });
    state.history = { entries: r.entries || [], canUndo: !!r.canUndo, canRedo: !!r.canRedo };
  } catch (_) {
    state.history = { entries: [], canUndo: false, canRedo: false };
  }
  return state.history;
}

/**
 * Undo the newest step.
 * @param {number|null} id  a specific step instead of the newest
 * @returns {Promise<boolean>} true when something was reversed
 */
export async function undoStep(id = null) {
  try {
    const r = await api.post('/api/history/undo', id ? { id } : {});
    await refreshHistory();
    report(r, 'undo');
    return true;
  } catch (e) {
    toastErr(e.message || 'Nothing to undo');
    return false;
  }
}

/** @returns {Promise<boolean>} true when something was repeated */
export async function redoStep(id = null) {
  try {
    const r = await api.post('/api/history/redo', id ? { id } : {});
    await refreshHistory();
    report(r, 'redo');
    return true;
  } catch (e) {
    toastErr(e.message || 'Nothing to redo');
    return false;
  }
}

/** @param {{op:string,done?:number,failed?:number,jobs?:string[]}} r */
function report(r, direction) {
  const past = direction === 'undo' ? 'Undone' : 'Redone';
  const label = OP_LABEL[r.op] || r.op;
  const jobs = r.jobs || [];
  if (jobs.length) {
    toast(`${label} — reversing this needs ${jobs.length} background job(s)`, 'info', 6000);
    return;
  }
  if (r.failed) toastWarn(`${past}: ${label} (${r.done || 0} ok, ${r.failed} failed)`);
  else toastOk(`${past}: ${label} (${r.done || 0} item(s))`);
}

export const OP_LABEL = {
  move: 'Move',
  copy: 'Copy',
  rename: 'Rename',
  delete: 'Delete',
  mkdir: 'New folder',
};

/** Human one-liner for a history entry, for the dropdown menu. */
export function historyLabel(e) {
  const verb = OP_LABEL[e.op] || e.op;
  const n = e.count ? ` ${e.count} item(s)` : '';
  return e.summary ? `${verb}: ${e.summary}` : `${verb}${n}`;
}

export async function clearHistory() {
  try {
    await api.delete('/api/history');
    await refreshHistory();
    toastOk('History cleared');
  } catch (e) { toastErr(e.message); }
}
