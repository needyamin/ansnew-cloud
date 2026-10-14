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
// Archives and PDF never render inline: show the action card (open in a new
// tab / download) instead of a hex dump or a PDF plugin that may not exist.
const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz']);
const OPEN_INSTEAD_EXT = new Set(['pdf', ...ARCHIVE_EXT]);

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

export function preview(entry, mount, gallery) {
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
  previewBytes(entry, mount, gallery);
}

function previewUrl(mount, path) {
  return `/api/fs/${encodeURIComponent(mount)}/preview?path=${encodeURIComponent(path)}`;
}

function previewBytes(entry, mount, gallery) {
  // Image slider: when the caller passes a list of sibling images (2+), the
  // preview becomes navigable — prev/next arrows, arrow keys, wrap-around.
  const list = Array.isArray(gallery) && gallery.length > 1 ? gallery.slice() : null;
  let idx = list ? Math.max(0, list.findIndex((g) => g.path === entry.path)) : 0;

  const path = entry.path || entry.name;
  let url = previewUrl(mount, path);
  const downloadUrl = `/api/fs/${encodeURIComponent(mount)}/download?path=${encodeURIComponent(path)}`;
  let cleanup = null;
  let nameEl = null, sizeEl = null, dlLink = null;

  const bar = el('div', { class: 'preview-bar' },
    icon(iconName(entry), ''),
    nameEl = el('span', { class: 'name', text: entry.name }),
    sizeEl = el('span', { class: 'muted', text: fmtSize(entry.size) }),
    el('span', { style: 'flex:1' }),
    // A rendered preview of an editable file keeps a one-click route to editing.
    isTextEntry(entry)
      ? el('button', { class: 'btn', title: 'Edit in the code editor', onclick: () => { close(); openEditor(entry, mount); } },
          icon('edit', ''), el('span', { class: 'lbl', text: 'Edit' }))
      : null,
  );
  // Slider chrome (counter + arrows) sits right before the download link.
  if (list) {
    bar.appendChild(el('span', { class: 'preview-counter', text: (idx + 1) + ' / ' + list.length }));
    bar.appendChild(el('button', {
      class: 'btn preview-nav prev', title: 'Previous image (←)', 'aria-label': 'Previous image',
      onclick: () => show(idx - 1),
    }, icon('up', 'rot90')));
    bar.appendChild(el('button', {
      class: 'btn preview-nav next', title: 'Next image (→)', 'aria-label': 'Next image',
      onclick: () => show(idx + 1),
    }, icon('up', 'rot270')));
  }
  dlLink = el('a', { class: 'btn icon', href: downloadUrl, download: entry.name, title: 'Download', 'aria-label': 'Download' }, icon('download'));
  bar.appendChild(dlLink);
  bar.appendChild(el('button', { class: 'btn', text: 'Close (Esc)', onclick: () => close() }));

  const body = el('div', { class: 'preview-body' }, el('span', { class: 'muted spin', text: 'Loading…' }));
  const ov = el('div', { class: 'preview-overlay' }, bar, body);

  function renderCurrent() {
    const cur = list ? list[idx] : entry;
    const p = cur.path || cur.name;
    url = previewUrl(mount, p);
    if (nameEl) nameEl.textContent = cur.name || p;
    if (sizeEl) sizeEl.textContent = fmtSize(cur.size);
    if (dlLink) { dlLink.href = `/api/fs/${encodeURIComponent(mount)}/download?path=${encodeURIComponent(p)}`; dlLink.setAttribute('download', cur.name || p); }
    const counter = bar.querySelector('.preview-counter');
    if (counter) counter.textContent = (idx + 1) + ' / ' + list.length;
    if (cleanup) { try { cleanup(); } catch (_) {} cleanup = null; }
    Promise.resolve(renderInto(body, cur, mount, p, url, dlLink.href))
      .then((fn) => { cleanup = typeof fn === 'function' ? fn : null; })
      .catch(err => {
        clear(body);
        body.appendChild(el('div', { class: 'muted', text: 'Preview unavailable: ' + (err && err.message ? err.message : 'unknown error') }));
      });
  }

  function show(i) {
    if (!list) return;
    idx = ((i % list.length) + list.length) % list.length; // wrap around
    renderCurrent();
  }

  function close() {
    document.removeEventListener('keydown', onKey);
    if (cleanup) { try { cleanup(); } catch (_) {} cleanup = null; }
    ov.remove();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (list && e.key === 'ArrowLeft') show(idx - 1);
    else if (list && e.key === 'ArrowRight') show(idx + 1);
  }
  document.addEventListener('keydown', onKey);
  document.body.appendChild(ov);

  renderCurrent();
}

function iconName(entry) {
  const e = extOf(entry);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(e)) return 'image';
  if (['mp4', 'webm', 'mkv', 'mov'].includes(e)) return 'video';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(e)) return 'audio';
  if (e === 'pdf') return 'pdf';
  if (ARCHIVE_EXT.has(e)) return 'archive';
  if (MD_EXT.has(e)) return 'code';
  if (DOC_EXT.has(e)) return 'file';
  if (TEXT_EXT.has(e)) return 'code';
  return 'file';
}

async function renderInto(body, entry, mount, path, url, downloadUrl) {
  const e = extOf(entry);
  const mime = entry.mime || '';
  clear(body);

  // Archives + PDF: no inline render. Show a clear card with both actions —
  // open the raw bytes in a new tab, or download — rather than a hex dump or
  // a PDF object plugin that embedded webviews often lack.
  if (OPEN_INSTEAD_EXT.has(e) || mime === 'application/pdf') {
    const card = el('div', { class: 'preview-notice' },
      el('p', { class: 'notice-title', text: 'No inline preview for this file type' }),
      el('p', { class: 'muted', text: entry.name + ' (' + fmtSize(entry.size) + ')' }),
      el('p', { class: 'muted', text: 'Open it in a new tab or download it to your device.' }),
      el('div', { class: 'notice-actions' },
        el('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener' },
          icon('ext', ''), el('span', { class: 'lbl', text: 'Open in new tab' })),
        el('a', { class: 'btn', href: downloadUrl, download: entry.name },
          icon('download', ''), el('span', { class: 'lbl', text: 'Download' })),
      ),
    );
    body.appendChild(card);
    return;
  }

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
