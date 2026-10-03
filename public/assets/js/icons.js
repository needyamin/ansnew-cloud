'use strict';
/* ANSNEW CLOUD icons: inline <use> helpers built from /assets/icons.svg sprite (fetched once). */
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

/** Pick an icon name for an entry returned by the list API. */
export function iconFor(entry) {
  if (entry.type === 'dir') return 'folder';
  const e = (entry.extension || '').toLowerCase();
  const mime = entry.mime || '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'].includes(e) || mime.startsWith('image/')) return 'image';
  if (['mp4', 'webm', 'mkv', 'mov', 'avi'].includes(e) || mime.startsWith('video/')) return 'video';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(e) || mime.startsWith('audio/')) return 'audio';
  if (['zip', 'gz', 'tar', 'tgz', 'bz2', 'xz', '7z', 'rar'].includes(e) || mime.includes('zip') || mime.includes('compressed')) return 'archive';
  if (e === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (['js', 'mjs', 'ts', 'json', 'css', 'html', 'htm', 'xml', 'yml', 'yaml', 'sql', 'c', 'cpp', 'h', 'go', 'rs', 'java', 'rb', 'sh', 'md', 'txt', 'log', 'conf', 'toml'].includes(e) || mime.startsWith('text/')) return 'code';
  return 'file';
}
