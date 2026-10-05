'use strict';
/*
 * Client half of the destructive-action password gate.
 *
 * The SERVER is the authority: it rejects a gated request with 403
 * `sensitive_required` whether or not this module ran. Everything here exists
 * so the user is asked at the right moment, once, with a dialog that explains
 * itself — not so the check can be bypassed.
 *
 * Grants are time-boxed (default 60s) and minted server-side, so a burst of
 * deletes after one confirmation does not re-prompt.
 */
import { api } from './api.js';
import { state } from './state.js';
import { passwordDialog } from './ui.js';

/** scope -> expiry (ms). Mirrors the server's session grant, loosely. */
const grants = new Map();

/** In-flight confirmations, so two panes can't open two dialogs at once. */
const inflight = new Map();

/** Human wording per scope. Shown as the dialog's reason line. */
const REASON = {
  'fs.delete': 'Deleting files needs your password. It lasts a minute, so a batch of deletes only asks once.',
  'drive.disconnect': 'Disconnecting a drive needs your password. Its files are left untouched, but every link and pinned path built on this drive stops resolving.',
  'connection.delete': 'Deleting a stored connection needs your password — it holds live remote credentials and may be used by several drives.',
  'favorites.clear': 'Removing every favourite at once needs your password. There is no undo for the whole list.',
  'trash.empty': 'Emptying the trash needs your password. Everything currently recoverable will be destroyed.',
};

/** Titles per scope — the dialog header is the first thing read. */
const TITLE = {
  'fs.delete': 'Confirm delete',
  'drive.disconnect': 'Confirm disconnect',
  'connection.delete': 'Confirm deletion',
  'favorites.clear': 'Remove all favourites',
  'trash.empty': 'Confirm empty trash',
};

export function scopeReason(scope) {
  return REASON[scope] || 'This action needs your password to confirm.';
}
export function scopeTitle(scope) {
  return TITLE[scope] || 'Confirm your password';
}

/** Forget every grant (call on logout / account switch). */
export function resetGrants() { grants.clear(); }

/** Is a grant believed to be live? Optimistic only — the server decides. */
export function hasGrant(scope) {
  const exp = grants.get(scope);
  if (!exp) return false;
  if (exp <= Date.now()) { grants.delete(scope); return false; }
  return true;
}

function noteGrant(scope, ttlSeconds) {
  grants.set(scope, Date.now() + Math.max(5, (ttlSeconds || 60)) * 1000);
}

/**
 * Ask for the password and mint a grant.
 * @returns {Promise<boolean>} true when the server accepted.
 */
async function confirmNow(scope) {
  const needsCode = !!(state.user && state.user.twoFactorEnabled);
  const ok = await passwordDialog({
    title: scopeTitle(scope),
    message: scopeReason(scope),
    needsCode,
    submit: async (password, code) => {
      try {
        const r = await api.post('/api/auth/confirm', { scope, password, ...(code ? { code } : {}) });
        if (r && r.ok) {
          noteGrant(scope, r.ttl);
          return { ok: true };
        }
        return { ok: false, error: 'Password is incorrect' };
      } catch (e) {
        // 429 (lockout) and 403 (wrong password) both carry a usable message.
        return { ok: false, error: e && e.message ? e.message : 'Confirmation failed' };
      }
    },
  });
  return ok;
}

/**
 * Ensure a sensitive scope is authorised before running `fn`.
 *
 * @param {string} scope one of the server's SensitiveGate scopes
 * @returns {Promise<boolean>} true if the caller may proceed
 */
/**
 * Is this scope gated right now?
 *
 * Only `fs.delete` is conditional, and the answer comes from the server's
 * bootstrap payload rather than a client-side constant. `permanent` (a delete
 * that bypasses the trash) is always gated regardless of the toggle.
 */
export function isGated(scope, permanent = false) {
  if (scope === 'fs.delete') return !!permanent || !!state.sensitive.gateDeleteTrash;
  return true;
}

export async function ensureSensitive(scope) {
  if (hasGrant(scope)) return true;

  let p = inflight.get(scope);
  if (p) return p;
  p = (async () => {
    try {
      return await confirmNow(scope);
    } finally {
      inflight.delete(scope);
    }
  })();
  inflight.set(scope, p);
  return p;
}

/**
 * Run a gated operation, asking for the password if the server demands it.
 *
 * The prompt is driven by the server's 403 rather than by a local guess of
 * whether the gate is on: server policy is the single source of truth, so
 * turning the "even to trash" toggle off in Settings needs no client change.
 *
 * @param {string}   scope
 * @param {Function} fn  async () => result
 * @param {boolean}  [permanent] for fs.delete: a permanent delete is always gated
 * @returns {Promise<*>} the result, or undefined when the user cancelled.
 */
export async function withSensitive(scope, fn, permanent = false) {
  const need = isGated(scope, permanent);

  // Already holding a grant — skip the round trip that would 403.
  if (need && !hasGrant(scope)) {
    const ok = await ensureSensitive(scope);
    if (!ok) return undefined;
  }
  try {
    return await fn();
  } catch (e) {
    // The server always has the final say. Even when we believed no password
    // was needed (or the grant was still live), a 403 here means ask now.
    if (e && e.code === 'sensitive_required') {
      grants.delete(scope);
      const ok = await ensureSensitive(scope);
      if (!ok) return undefined;
      return await fn();
    }
    throw e;
  }
}
