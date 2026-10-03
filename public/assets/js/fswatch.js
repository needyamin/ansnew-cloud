'use strict';
/*
 * Realtime filesystem-change consumer.
 *
 * The server pushes `fs.changed` whenever a mutation lands — from this browser,
 * another tab, another device, or a background job. Two things happen:
 *   1. the affected cached listings are dropped, and
 *   2. any pane showing an affected directory revalidates *silently*.
 *
 * So a file created elsewhere appears on its own, without a reload and without
 * losing scroll position or selection. Revalidation is debounced because one
 * batch operation can produce a burst of events.
 */
import { invalidateList } from './api.js';
import { state } from './state.js';
import * as rt from './realtime.js';

/** One batch of uploads can emit hundreds of events; coalesce them. */
const DEBOUNCE_MS = 750;

/** Does `dir` (as announced) affect the directory `path` a pane is showing? */
function affects(dir, path) {
  if (dir === '/') return true;                 // whole-mount invalidation
  if (dir === path) return true;
  // A change to an ancestor means this directory's listing may be stale too.
  return path.startsWith(dir + '/');
}

export function initFsWatch() {
  rt.on('fs.changed', (d) => {
    if (!d || !d.mounts || typeof d.mounts !== 'object') return;

    for (const [mount, dirs] of Object.entries(d.mounts)) {
      if (!Array.isArray(dirs)) continue;
      for (const dir of dirs) invalidateList(mount, dir);
    }

    for (const pane of state.panes) {
      const dirs = d.mounts[pane.loc.mount];
      if (!Array.isArray(dirs)) continue;
      if (!dirs.some((dir) => affects(dir, pane.loc.path))) continue;
      // Don't fight an optimistic operation that is still in flight — it
      // revalidates itself when it settles.
      if (pane.pending && pane.pending.size) {
        pane.scheduleRevalidate(1200);
        continue;
      }
      pane.scheduleRevalidate(DEBOUNCE_MS);
    }
  });
}
