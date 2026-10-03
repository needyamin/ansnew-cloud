'use strict';
/*
 * Lazy image thumbnails.
 *
 * One IntersectionObserver serves every pane. Grid tiles render an <img> with a
 * data-thumb URL; the URL is only assigned once the tile nears the viewport, so
 * opening a folder with 500 photos doesn't fire 500 requests.
 */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']);
const THUMB_SIZE = 256;

let observer = null;

export function isThumbnailable(entry) {
  if (!entry || entry.type === 'dir') return false;
  const ext = String(entry.extension || '').toLowerCase();
  if (IMAGE_EXT.has(ext)) return true;
  return String(entry.mime || '').startsWith('image/');
}

export function thumbUrl(mount, path, size = THUMB_SIZE) {
  return `/api/fs/${encodeURIComponent(mount)}/thumb?path=${encodeURIComponent(path)}&size=${size}`;
}

function getObserver() {
  if (observer) return observer;
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target;
      observer.unobserve(img);
      if (img.dataset.thumb && !img.src) img.src = img.dataset.thumb;
    }
  }, { rootMargin: '240px 0px' });
  return observer;
}

/**
 * (Re)attach the observer to every pending thumbnail under `root`.
 * Disconnects first so a re-render can't leak references to removed tiles.
 */
export function observeThumbs(root) {
  const obs = getObserver();
  obs.disconnect();
  for (const img of root.querySelectorAll('img.thumb[data-thumb]')) obs.observe(img);
}

/** Fall back to the type icon when a thumbnail fails to load. */
export function onThumbError(img) {
  img.addEventListener('error', () => {
    img.classList.add('thumb-failed');
    img.removeAttribute('src');
  }, { once: true });
}
