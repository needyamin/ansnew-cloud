'use strict';
/*
 * Lazy image thumbnails.
 *
 * Each pane owns its own observer. This used to be one module-level observer
 * whose `observeThumbs()` called `disconnect()` on every render — which meant
 * the second pane's render silently unobserved the first pane's images, and
 * with node recycling it would have been fatal. Per-pane + explicit
 * `unwatch()` on recycle keeps requests bounded to what is actually on screen.
 */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']);
const THUMB_SIZE = 256;

export function isThumbnailable(entry) {
  if (!entry || entry.type === 'dir') return false;
  const ext = String(entry.extension || '').toLowerCase();
  if (IMAGE_EXT.has(ext)) return true;
  return String(entry.mime || '').startsWith('image/');
}

export function thumbUrl(mount, path, size = THUMB_SIZE) {
  return `/api/fs/${encodeURIComponent(mount)}/thumb?path=${encodeURIComponent(path)}&size=${size}`;
}

/**
 * Create a thumbnail loader bound to one pane. Call `watch(img)` from the row
 * fill routine and `unwatch(img)` when the node is recycled.
 */
export function createThumbObserver() {
  const observed = new Set();
  let observer = null;

  function ensure() {
    if (observer) return observer;
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target;
        observed.delete(img);
        observer.unobserve(img);
        // Assigning src is what actually triggers the request.
        if (img.dataset.thumb && !img.src) img.src = img.dataset.thumb;
      }
    }, { rootMargin: '300px 0px' });
    return observer;
  }

  return {
    watch(img) {
      if (!img || observed.has(img)) return;
      observed.add(img);
      ensure().observe(img);
    },
    unwatch(img) {
      if (!img || !observed.delete(img)) return;
      if (observer) observer.unobserve(img);
    },
    disconnect() {
      if (observer) { observer.disconnect(); observer = null; }
      observed.clear();
    },
  };
}

/**
 * Fall back to the type icon when a thumbnail fails to load.
 * Bound once per <img> — recycled nodes reuse the same element, so the handler
 * has to survive multiple loads (the old `{once:true}` version did not).
 */
export function onThumbError(img) {
  if (img._thumbErrBound) return;
  img._thumbErrBound = true;
  img.addEventListener('error', () => {
    img.classList.add('thumb-failed');
    img.removeAttribute('src');
  });
}
