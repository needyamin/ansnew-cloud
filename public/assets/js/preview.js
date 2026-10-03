'use strict';
/* Preview modal: images, video/audio, PDF, text/code, markdown, hex fallback. */
import { el, clear, fmtSize, renderMarkdown, debounce } from './util.js';
import { api } from './api.js';
import { icon } from './icons.js';
import { state } from './state.js';

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'json', 'js', 'mjs', 'ts', 'css', 'html', 'htm', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'log', 'sql', 'sh', 'py', 'c', 'cpp', 'h', 'go', 'rs', 'java', 'rb', 'php', 'csv']);
const TEXT_MAX = 2 * 1024 * 1024; // 2 MiB cap for text preview

export function preview(entry, mount) {
  const path = entry.path || entry.name;
  const url = `/api/fs/${encodeURIComponent(mount)}/preview?path=${encodeURIComponent(path)}`;

  const bar = el('div', { class: 'preview-bar' },
    icon(iconName(entry), ''),
    el('span', { class: 'name', text: entry.name }),
    el('span', { class: 'muted', text: fmtSize(entry.size) }),
    el('span', { style: 'flex:1' }),
    el('button', { class: 'btn', text: 'Close (Esc)', onclick: () => close() }),
  );
  const body = el('div', { class: 'preview-body' }, el('span', { class: 'muted spin', text: 'Loading…' }));
  const ov = el('div', { class: 'preview-overlay' }, bar, body);
  function close() { document.removeEventListener('keydown', onKey); ov.remove(); if (body.querySelector('video, audio')) { const m = body.querySelector('video, audio'); try { m.pause(); } catch (_) {} } }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  document.body.appendChild(ov);

  renderInto(body, entry, url).catch(err => {
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

async function renderInto(body, entry, url) {
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
    body.appendChild(el(isAudio ? 'audio' : 'video', { src: url, controls: true, autoplay: false }));
    return;
  }
  if (e === 'pdf' || mime === 'application/pdf') {
    const obj = el('object', { type: 'application/pdf', data: url });
    body.appendChild(obj);
    return;
  }
  if (TEXT_EXT.has(e) || mime.startsWith('text/')) {
    if ((entry.size || 0) > TEXT_MAX) { body.appendChild(el('div', { class: 'muted', text: 'Text file too large to preview (2 MiB limit).' })); return; }
    const text = await api.text(url, TEXT_MAX + 1);
    if (['md', 'markdown'].includes(e)) {
      const div = el('div', { class: 'md' });
      div.innerHTML = renderMarkdown(text);
      body.appendChild(div);
    } else {
      body.appendChild(el('pre', { text: text }));
    }
    return;
  }
  // hex fallback (first 4 KiB)
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
