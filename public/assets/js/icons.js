'use strict';
/* ANSNEW CLOUD icons: inline <use> helpers built from /assets/icons.svg sprite (fetched once). */
import { categoryOf } from './filters.js';

let spriteLoaded = false;
let spriteText = '';

export async function loadSprite() {
  if (spriteLoaded) return;
  try {
    const res = await fetch('/assets/icons.svg');
    spriteText = await res.text();
    const holder = document.createElement('div');
    holder.style.display = 'none';
    holder.innerHTML = spriteText;
    document.body.prepend(holder);
    spriteLoaded = true;
  } catch (_) { /* icons degrade to first letters */ }
}

/**
 * Render an icon element. `name` is a symbol id without the i- prefix.
 */
export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', ('icon ' + cls).trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.appendChild(use);
  return svg;
}

/**
 * Pick an icon name for an entry returned by the list API.
 *
 * The classification itself lives in filters.js so the type chips and the row
 * icons can never disagree about what a file is.
 */
export function iconFor(entry) {
  if (!entry) return 'file';
  if (entry.type === 'dir') return 'folder';
  switch (categoryOf(entry)) {
    case 'images': return 'image';
    case 'video': return 'video';
    case 'audio': return 'audio';
    case 'archives': return 'archive';
    case 'documents':
      // PDFs have their own glyph; the sprite has no generic document icon, so
      // everything else falls back to the page icon (as it did before).
      return String(entry.extension || '').toLowerCase() === 'pdf' ? 'pdf' : 'file';
    case 'code': return 'code';
    default: return 'file';
  }
}
