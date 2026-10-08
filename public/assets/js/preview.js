'use strict';
/* Preview modal: images, video/audio, PDF, hex fallback.
 *
 * Text and code files do NOT come here — they open in the built-in editor
 * (editor.js) so they can be edited rather than just read. */
import { el, clear, fmtSize } from './util.js';
import { icon } from './icons.js';
import { buildMediaPlayer } from './player.js';
import { toastErr } from './ui.js';
import { openEditor, isTextEntry, TEXT_EXT } from './editor.js';

export function preview(entry, mount) {
  // Text/code files open in the code editor. `openEditor` returns false only
  // when the file turned out not to be text after all (the server sniffs for
  // binary content), in which case the hex view below takes over.
  if (isTextEntry(entry)) {
    openEditor(entry, mount)
      .then((handled) => { if (!handled) previewBytes(entry, mount); })
      // Never fail silently. A throw inside the editor's overlay builder used to
      // leave the user with no editor and no message at all — the server logged a
      // 200 and the click simply appeared to do nothing.
      .catch((err) => {
        console.error('[editor] could not open', entry.path || entry.name, err);
        toastErr('Could not open the editor: ' + (err && err.message ? err.message : 'unknown error'));
        previewBytes(entry, mount);
      });
    return;
  }
  previewBytes(entry, mount);
}

function previewBytes(entry, mount) {
  const path = entry.path || entry.name;
  const url = `/api/fs/${encodeURIComponent(mount)}/preview?path=${encodeURIComponent(path)}`;
  const downloadUrl = `/api/fs/${encodeURIComponent(mount)}/download?path=${encodeURIComponent(path)}`;
  let cleanup = null;

  const bar = el('div', { class: 'preview-bar' },
    icon(iconName(entry), ''),
    el('span', { class: 'name', text: entry.name }),
    el('span', { class: 'muted', text: fmtSize(entry.size) }),
    el('span', { style: 'flex:1' }),
    el('button', { class: 'btn', text: 'Close (Esc)', onclick: () => close() }),
  );
  const body = el('div', { class: 'preview-body' }, el('span', { class: 'muted spin', text: 'Loading…' }));
  const ov = el('div', { class: 'preview-overlay' }, bar, body);
  function close() {
    document.removeEventListener('keydown', onKey);
    if (cleanup) { try { cleanup(); } catch (_) {} cleanup = null; }
    ov.remove();
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  document.body.appendChild(ov);

  Promise.resolve(renderInto(body, entry, url, downloadUrl))
    .then((fn) => { cleanup = typeof fn === 'function' ? fn : null; })
    .catch(err => {
      clear(body);
      body.appendChild(el('div', { class: 'muted', text: 'Preview unavailable: ' + err.message }));
    });
}

function iconName(entry) {
  const e = (entry.extension || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(e)) return 'image';
  if (['mp4', 'webm', 'mkv', 'mov'].includes(e)) return 'video';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(e)) return 'audio';
  if (e === 'pdf') return 'pdf';
  if (TEXT_EXT.has(e)) return 'code';
  return 'file';
}

async function renderInto(body, entry, url, downloadUrl) {
  const e = (entry.extension || '').toLowerCase();
  const mime = entry.mime || '';
  clear(body);

  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico'].includes(e) || mime.startsWith('image/')) {
    const img = el('img', { src: url, alt: entry.name });
    img.onload = () => {};
    body.appendChild(img);
    return;
  }
  if (['mp4', 'webm', 'mkv', 'mov', 'mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(e) || mime.startsWith('video/') || mime.startsWith('audio/')) {
    const isAudio = mime.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(e);
    const player = buildMediaPlayer({ url, downloadUrl, isAudio, title: entry.name });
    body.appendChild(player.node);
    return player.destroy;
  }
  if (e === 'pdf' || mime === 'application/pdf') {
    const obj = el('object', { type: 'application/pdf', data: url });
    body.appendChild(obj);
    return;
  }
  // hex fallback (first 4 KiB) — also what a text file lands on when the server
  // sniffs binary content in it (see openEditor in editor.js).
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf.slice(0, 4096));
  let hex = '', ascii = '';
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    let h = '', a = '';
    for (let j = 0; j < 16 && i + j < bytes.length; j++) {
      const b = bytes[i + j];
      h += b.toString(16).padStart(2, '0') + ' ';
      a += (b >= 32 && b < 127) ? String.fromCharCode(b) : '.';
    }
    lines.push(i.toString(16).padStart(8, '0') + '  ' + h.padEnd(48) + ' ' + a);
  }
  body.appendChild(el('pre', { text: lines.join('\n') }));
}
