'use strict';
/* Preview modal: images, video/audio, PDF, Markdown, office documents, hex fallback.
 *
 * Text and code files normally open in the built-in editor (editor.js) so they
 * can be edited rather than just read. Two families are the exception and get a
 * rendered read view here instead — Markdown and office documents — with an
 * "Edit" button that hands a text file off to the editor. */
import { el, clear, fmtSize, renderMarkdown } from './util.js';
import { icon } from './icons.js';
import { buildMediaPlayer } from './player.js';
import { toastErr } from './ui.js';
import { openEditor, isTextEntry, TEXT_EXT } from './editor.js';

const MD_EXT = new Set(['md', 'markdown']);
// Office formats we can render server-side. Legacy binary .doc is included so
// it still opens the modal (the server answers "unsupported" and we show a
// friendly notice + download instead of a hex dump).
const DOC_EXT = new Set(['docx', 'doc', 'odt', 'rtf']);

/** Extension of an entry, from its extension field or its name. */
function extOf(entry) {
  const e = String((entry && entry.extension) || '').toLowerCase();
  if (e) return e;
  const name = String((entry && (entry.name || entry.path)) || '');
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Does this entry get a rendered (non-editor) preview? */
export function hasRichPreview(entry) {
  const e = extOf(entry);
  return MD_EXT.has(e) || DOC_EXT.has(e);
}

export function preview(entry, mount) {
  // Markdown + office documents get a rendered view (Google-Drive style)
  // rather than the raw editor or a hex dump.
  if (hasRichPreview(entry)) { previewBytes(entry, mount); return; }

  // Other text/code files open in the code editor. `openEditor` returns false
  // only when the file turned out not to be text after all (the server sniffs
  // for binary content), in which case the hex view below takes over.
  if (isTextEntry(entry)) {
    openEditor(entry, mount)
      .then((handled) => { if (!handled) previewBytes(entry, mount); })
      // Never fail silently. A throw inside the editor's overlay builder used to
      // leave the user with no editor and no message at all.
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
    // A rendered preview of an editable file keeps a one-click route to editing.
    isTextEntry(entry)
      ? el('button', { class: 'btn', title: 'Edit in the code editor', onclick: () => { close(); openEditor(entry, mount); } },
          icon('edit', ''), el('span', { class: 'lbl', text: 'Edit' }))
      : null,
    el('a', { class: 'btn icon', href: downloadUrl, download: entry.name, title: 'Download', 'aria-label': 'Download' }, icon('download')),
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

  Promise.resolve(renderInto(body, entry, mount, path, url, downloadUrl))
    .then((fn) => { cleanup = typeof fn === 'function' ? fn : null; })
    .catch(err => {
      clear(body);
      body.appendChild(el('div', { class: 'muted', text: 'Preview unavailable: ' + (err && err.message ? err.message : 'unknown error') }));
    });
}

function iconName(entry) {
  const e = extOf(entry);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(e)) return 'image';
  if (['mp4', 'webm', 'mkv', 'mov'].includes(e)) return 'video';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(e)) return 'audio';
  if (e === 'pdf') return 'pdf';
  if (MD_EXT.has(e)) return 'code';
  if (DOC_EXT.has(e)) return 'file';
  if (TEXT_EXT.has(e)) return 'code';
  return 'file';
}

async function renderInto(body, entry, mount, path, url, downloadUrl) {
  const e = extOf(entry);
  const mime = entry.mime || '';
  clear(body);

  // Markdown / markup -> rendered HTML (safe subset, escaped).
  if (MD_EXT.has(e)) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const wrap = el('div', { class: 'md doc' });
    wrap.innerHTML = renderMarkdown(text);
    body.appendChild(wrap);
    return;
  }

  // Office documents -> server-rendered, sanitized HTML.
  if (DOC_EXT.has(e)) {
    const res = await fetch(`/api/fs/${encodeURIComponent(mount)}/render?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' });
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-JSON */ }
    if (!res.ok || !data || !data.ok) {
      const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
      body.appendChild(el('div', { class: 'md doc' }, el('p', { class: 'muted', text: 'Preview unavailable: ' + msg })));
      return;
    }
    const payload = data.data || {};
    if (payload.kind === 'unsupported' || !payload.html) {
      body.appendChild(el('div', { class: 'md doc' },
        el('p', { class: 'muted', text: 'No inline preview for this document type. Use Download to open it in a desktop app.' })));
      return;
    }
    const wrap = el('div', { class: 'md doc' });
    wrap.innerHTML = payload.html; // server-sanitized (whitelisted tags, escaped text)
    body.appendChild(wrap);
    return;
  }

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
    // Some embedded webviews have no PDF plugin; keep a quiet escape hatch.
    body.appendChild(el('div', { class: 'preview-hint muted' },
      'If the document does not appear, ',
      el('a', { href: url, target: '_blank', rel: 'noopener', text: 'open it in a new tab' }), '.'));
    return;
  }
  // hex fallback (first 4 KiB) — also what a text file lands on when the server
  // sniffs binary content in it (see openEditor in editor.js).
  const res = await fetch(url, { credentials: 'same-origin' });
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
