'use strict';
/*
 * Built-in code editor for text files.
 *
 * Any text/code file opens here instead of the read-only preview: a monospace
 * editor with a line-number gutter, Save (Ctrl+S), Revert, and a status bar.
 *
 * Two details make it safe to use on real files rather than a toy:
 *   - the text round-trips through a <textarea>, and browsers normalise CRLF to
 *     LF there, so the line ending (and a BOM) is recorded on load and restored
 *     on save — otherwise saving a Windows file would silently rewrite every
 *     line of it;
 *   - the server returns a hash of the original bytes, and save() sends it back,
 *     so a file changed elsewhere (another tab, another device, a job) is never
 *     clobbered — the server answers 409 and we offer to reload instead.
 *
 * Files the upload policy protects (shells, php, …) and mounts the user cannot
 * write to open read-only, with the reason shown in the toolbar.
 */
import { el, renderMarkdown } from './util.js';
import { api } from './api.js';
import { icon } from './icons.js';
import { toastOk, toastErr, dialog } from './ui.js';

/** Extensions (and bare names) the editor treats as text. */
export const TEXT_EXT = new Set([
  'txt', 'text', 'log', 'md', 'markdown', 'rst', 'adoc',
  'json', 'jsonc', 'json5', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'xhtml', 'xml', 'svg', 'xsl',
  'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'properties', 'env', 'editorconfig',
  'sql', 'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'py', 'rb', 'php',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'java', 'kt', 'kts', 'go', 'rs', 'swift',
  'lua', 'pl', 'r', 'dart', 'scala', 'groovy', 'clj', 'ex', 'exs', 'erl', 'hs',
  'csv', 'tsv', 'tex', 'bib', 'diff', 'patch', 'lock', 'gitignore', 'dockerignore',
  'dockerfile', 'makefile', 'cmake', 'gradle', 'srt', 'vtt', 'nfo', 'readme',
  'license', 'licence', 'authors', 'changelog', 'hosts', 'htaccess',
]);

/**
 * Formats that must NEVER open in the editor.
 *
 * This is the *negative* list, and it is deliberately the short one: anything
 * not named here is offered to the editor, because the user's rule is
 * "unknown extension and not media → open it in the editor". The server sniffs
 * every file for NUL bytes and answers 415 when the content is really binary, at
 * which point preview.js shows the hex view instead — so a wrong guess here
 * costs one cheap request, never a broken editor.
 *
 * Ambiguous extensions are deliberately absent so the sniff decides:
 * `.ts` (TypeScript, listed in TEXT_EXT), `.obj` (Wavefront text), `.stl`
 * (ASCII STL), `.fbx`/`.eps` (both have ASCII forms), `.dat`, `.bin`, `.db`.
 */
const BINARY_EXT = new Set([
  // images
  'png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'webp', 'bmp', 'avif', 'ico', 'cur', 'apng',
  'tif', 'tiff', 'heic', 'heif', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2',
  'psd', 'psb', 'ai', 'jxl', 'jp2',
  // video
  'mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'f4v', 'mpg', 'mpeg', 'mpe',
  'm2v', '3gp', '3g2', 'mts', 'm2ts', 'ogv', 'vob', 'rm', 'rmvb', 'divx', 'asf', 'dv', 'mxf',
  // audio
  'mp3', 'wav', 'wave', 'ogg', 'oga', 'flac', 'm4a', 'm4b', 'aac', 'wma', 'opus', 'aiff',
  'aif', 'aifc', 'mid', 'midi', 'amr', 'ape', 'mka', 'ac3', 'dts', 'ra', 'au',
  // documents / e-books (all binary containers)
  'pdf', 'doc', 'docx', 'dot', 'dotx', 'xls', 'xlsx', 'xlsm', 'xlt', 'xltx', 'ppt', 'pptx',
  'pps', 'ppsx', 'pot', 'potx', 'odt', 'ods', 'odp', 'odg', 'pages', 'numbers', 'key',
  'epub', 'mobi', 'azw', 'azw3', 'djvu', 'xps',
  // archives / packages / disk images
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'tbz2', 'xz', 'txz', 'lz', 'lzma',
  'zst', 'cab', 'arj', 'lzh', 'iso', 'dmg', 'vhd', 'vhdx', 'vmdk', 'qcow2', 'vdi', 'img',
  'jar', 'war', 'ear', 'apk', 'aab', 'ipa', 'xpi', 'crx', 'deb', 'rpm', 'pkg', 'snap',
  'appimage', 'msi', 'msix', 'appx', 'nupkg',
  // executables / objects / bytecode
  'exe', 'dll', 'so', 'dylib', 'com', 'scr', 'sys', 'ocx', 'cpl', 'o', 'a', 'lib',
  'class', 'pyc', 'pyo', 'pyd', 'wasm', 'elf', 'ko', 'dex',
  // fonts
  'ttf', 'otf', 'ttc', 'woff', 'woff2', 'eot', 'pfb', 'pfm',
  // databases / binary data
  'sqlite', 'sqlite3', 'mdb', 'accdb', 'dbf', 'frm', 'myd', 'myi', 'ibd', 'realm', 'ldb',
  // misc binary media / 3D / CAD
  'swf', 'glb', 'blend', 'dwg', 'dgn', '3ds', 'max', 'c4d', 'skp',
]);

/** Content-sniffed MIME prefixes that always mean "not text". */
const BINARY_MIME_PREFIX = ['image/', 'video/', 'audio/', 'font/'];

/** Content-sniffed MIME types that always mean "not text". */
const BINARY_MIME = new Set([
  'application/pdf', 'application/zip', 'application/gzip', 'application/x-gzip',
  'application/x-tar', 'application/x-bzip2', 'application/x-xz', 'application/x-rar',
  'application/x-rar-compressed', 'application/x-7z-compressed', 'application/wasm',
  'application/x-sqlite3', 'application/msword', 'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint', 'application/x-executable', 'application/x-dosexec',
  'application/x-sharedlib', 'application/x-object', 'application/x-mach-binary',
  'application/x-elf', 'application/x-shockwave-flash',
  'application/vnd.android.package-archive',
]);

const MD_EXT = new Set(['md', 'markdown']);
const INDENT = '  ';

/** Extension of an entry, from its extension field or its name. */
function extOf(entry) {
  const e = String(entry.extension || '').toLowerCase();
  if (e) return e;
  const name = String(entry.name || entry.path || '');
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Should this entry open in the editor?
 *
 * Policy: open it UNLESS we can name a reason not to.
 *
 *   1. a known text extension / bare name  → editor
 *   2. a text MIME                          → editor
 *   3. a known media/binary MIME            → hex preview
 *   4. a known binary extension             → hex preview
 *   5. anything else (unknown extension, or none at all) → editor
 *
 * Rule 5 is the point: the user's rule is that an unrecognised file opens in the
 * editor. The server's NUL sniff is the backstop — if the content turns out to be
 * binary, `openEditor` resolves false and preview.js renders the hex view.
 */
export function isTextEntry(entry) {
  if (!entry || entry.type === 'dir') return false;

  const name = String(entry.name || entry.path || '').toLowerCase();
  const ext = extOf(entry);
  const mime = String(entry.mime || '');

  // 1. explicitly text
  if (TEXT_EXT.has(name) || (ext && TEXT_EXT.has(ext))) return true;

  // 2. a text MIME wins over an unrecognised extension
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') return true;

  // 3./4. named reasons NOT to open the editor
  if (mime && (BINARY_MIME.has(mime) || BINARY_MIME_PREFIX.some((p) => mime.startsWith(p)))) return false;
  if (ext && BINARY_EXT.has(ext)) return false;

  // 5. unknown → try the editor; the server decides for real.
  return true;
}

/**
 * Open the editor for one file.
 *
 * @returns {Promise<boolean>} false when the file turned out not to be text, so
 *          the caller can fall back to the hex preview.
 */
export async function openEditor(entry, mount) {
  const path = entry.path || entry.name;
  const downloadUrl = `/api/fs/${encodeURIComponent(mount)}/download?path=${encodeURIComponent(path)}`;

  let data;
  try {
    data = await api.get(`/api/fs/${encodeURIComponent(mount)}/text?path=${encodeURIComponent(path)}`);
  } catch (err) {
    // 415 = the server sniffed binary content. Not ours to handle.
    if (err && (err.status === 415 || err.code === 'not_text')) return false;
    showNotice(entry, mount, downloadUrl, err);
    return true;
  }

  buildEditor(entry, mount, data, downloadUrl);
  return true;
}

/** Fallback panel when the file cannot be opened as text (too large, etc.). */
function showNotice(entry, mount, downloadUrl, err) {
  const ov = el('div', { class: 'editor-overlay' },
    el('div', { class: 'editor-bar' },
      icon('code', ''),
      el('span', { class: 'name', text: entry.name }),
      el('span', { style: 'flex:1' }),
      el('a', { class: 'btn', href: downloadUrl, download: entry.name, text: 'Download' }),
      el('button', { class: 'btn', text: 'Close (Esc)', onclick: () => ov.remove() }),
    ),
    el('div', { class: 'editor-notice' },
      el('div', { class: 'muted', text: (err && err.message) || 'This file cannot be opened in the editor.' }),
    ),
  );
  document.body.appendChild(ov);
  const onKey = (e) => { if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

function buildEditor(entry, mount, data, downloadUrl) {
  // `path` must be resolved here: buildEditor, save() and reload() all need it,
  // and it is not in openEditor's scope. The server echoes the normalized path.
  const path = data.path || entry.path || entry.name;
  const readOnly = !!data.readOnly;
  const isMd = MD_EXT.has(extOf(entry));

  let dirty = false;
  let wrap = false;
  let previewing = false;
  let hash = data.hash || '';
  let eol = data.eol === 'crlf' ? 'crlf' : 'lf';
  const bom = !!data.bom;

  /* ------------------------------------------------------------- chrome */

  const dirtyDot = el('span', { class: 'editor-dirty', title: 'Unsaved changes', text: '●' });
  const saveBtn = el('button', { class: 'btn primary', disabled: readOnly, onclick: () => save() },
    icon('check', ''), el('span', { class: 'lbl', text: 'Save' }));
  const revertBtn = el('button', { class: 'btn', disabled: readOnly, onclick: () => revert() },
    icon('undo', ''), el('span', { class: 'lbl', text: 'Revert' }));
  const wrapBtn = el('button', { class: 'btn', title: 'Toggle word wrap', onclick: () => setWrap(!wrap) },
    el('span', { class: 'lbl', text: 'Wrap' }));
  const mdBtn = isMd
    ? el('button', { class: 'btn', title: 'Toggle rendered preview', onclick: () => setPreview(!previewing) },
        icon('file', ''), el('span', { class: 'lbl', text: 'Preview' }))
    : null;

  const bar = el('div', { class: 'editor-bar' },
    icon('code', ''),
    el('span', { class: 'name', text: entry.name }),
    dirtyDot,
    el('span', { class: 'muted path', text: path }),
    el('span', { style: 'flex:1' }),
    wrapBtn,
    mdBtn,
    revertBtn,
    saveBtn,
    el('a', { class: 'btn icon', href: downloadUrl, download: entry.name, title: 'Download', 'aria-label': 'Download' }, icon('download')),
    el('button', { class: 'btn icon', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => requestClose() }, icon('close')),
  );

  const tools = el('div', { class: 'editor-tools' },
    readOnly
      ? el('span', { class: 'editor-badge', text: 'Read-only — ' + (data.readOnlyReason || 'not editable') })
      : null,
    el('span', { class: 'muted', text: data.encoding === 'utf-8' ? 'UTF-8' : 'non-UTF-8' }),
  );

  /* --------------------------------------------------------- edit surface */

  const ta = el('textarea', {
    class: 'editor-text',
    spellcheck: 'false',
    autocapitalize: 'off',
    autocomplete: 'off',
    autocorrect: 'off',
    wrap: 'off',
  });
  ta.value = data.content || '';
  ta.readOnly = readOnly;
  if (readOnly) ta.classList.add('readonly');

  const gutter = el('div', { class: 'editor-gutter', 'aria-hidden': 'true' });

  const preview = el('div', { class: 'editor-preview md' });
  preview.hidden = true;

  const main = el('div', { class: 'editor-main' }, gutter, ta, preview);

  const posEl = el('span', { text: 'Ln 1, Col 1' });
  const countEl = el('span', { text: '' });
  const eolEl = el('span', { class: 'editor-eol', text: eol === 'crlf' ? 'CRLF' : 'LF', title: 'Line ending (preserved on save)' });
  const bomEl = bom ? el('span', { text: 'BOM', title: 'UTF-8 BOM (preserved on save)' }) : null;
  const status = el('div', { class: 'editor-status' },
    posEl, el('span', { class: 'sp' }), countEl, eolEl, bomEl,
  );

  const ov = el('div', { class: 'editor-overlay' }, bar, tools, main, status);
  document.body.appendChild(ov);

  /* -------------------------------------------------------------- wiring */

  function setDirty(on) {
    dirty = on;
    dirtyDot.classList.toggle('show', on);
    saveBtn.classList.toggle('armed', on);
  }

  function lineCount() { return ta.value.split('\n').length; }

  let lastLines = -1;
  function renderGutter() {
    const n = lineCount();
    if (n === lastLines) return;
    lastLines = n;
    let s = '';
    for (let i = 1; i <= n; i++) s += i + '\n';
    gutter.textContent = s;
  }

  function renderStatus() {
    const v = ta.value;
    const upto = v.slice(0, ta.selectionStart);
    const line = upto.split('\n').length;
    const col = upto.length - upto.lastIndexOf('\n');
    posEl.textContent = `Ln ${line}, Col ${col}`;
    countEl.textContent = `${lineCount()} lines · ${v.length} chars`;
  }

  let refreshTimer = null;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { renderGutter(); renderStatus(); }, 120);
  }

  function setWrap(on) {
    wrap = on;
    ta.classList.toggle('wrap', on);
    // With wrapping on, one logical line spans several visual rows and the
    // gutter numbers would no longer line up — so hide it rather than lie.
    gutter.classList.toggle('hidden', on);
    wrapBtn.classList.toggle('active', on);
  }

  function setPreview(on) {
    previewing = on;
    preview.hidden = !on;
    ta.hidden = on;
    gutter.classList.toggle('hidden', on || wrap);
    if (on) preview.innerHTML = renderMarkdown(ta.value);
    if (mdBtn) mdBtn.classList.toggle('active', on);
  }

  ta.addEventListener('input', () => { setDirty(true); scheduleRefresh(); });
  ta.addEventListener('keyup', renderStatus);
  ta.addEventListener('click', renderStatus);
  ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); indent(e.shiftKey); return; }
    if (e.key === 'Enter') { e.preventDefault(); newline(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); requestClose(); }
  });

  /** Tab / Shift+Tab: indent or outdent the selected lines (or just insert). */
  function indent(out) {
    if (readOnly) return;
    const v = ta.value;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const multi = v.slice(start, end).includes('\n');
    if (!multi && !out) {
      insertAtCursor(INDENT);
      return;
    }
    const from = v.lastIndexOf('\n', start - 1) + 1;
    let to = v.indexOf('\n', end);
    if (to === -1) to = v.length;
    const block = v.slice(from, to);
    const lines = block.split('\n');
    let deltaFirst = 0;
    const out2 = lines.map((ln, i) => {
      if (out) {
        const m = ln.match(/^[ \t]{1,2}/);
        if (!m) return ln;
        if (i === 0) deltaFirst = -m[0].length;
        return ln.slice(m[0].length);
      }
      if (i === 0) deltaFirst = INDENT.length;
      return INDENT + ln;
    }).join('\n');
    ta.value = v.slice(0, from) + out2 + v.slice(to);
    ta.selectionStart = Math.max(from, start + deltaFirst);
    ta.selectionEnd = end + (out2.length - block.length);
    setDirty(true);
    scheduleRefresh();
  }

  function insertAtCursor(text) {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + text.length;
    setDirty(true);
    scheduleRefresh();
  }

  /** Enter: keep the current indentation, and add one level after an opener. */
  function newline() {
    if (readOnly) return;
    const v = ta.value;
    const start = ta.selectionStart;
    const lineStart = v.lastIndexOf('\n', start - 1) + 1;
    const before = v.slice(lineStart, start);
    const lead = (before.match(/^[ \t]*/) || [''])[0];
    const opens = /[{([]\s*$/.test(before);
    const closes = /^\s*[})\]]/.test(v.slice(start));
    if (opens && closes) {
      // Expand "{|}" into a block with the caret on the middle line.
      const inner = lead + INDENT;
      insertAtCursor('\n' + inner + '\n' + lead);
      ta.selectionStart = ta.selectionEnd = start + 1 + inner.length;
      return;
    }
    insertAtCursor('\n' + lead + (opens ? INDENT : ''));
  }

  /* --------------------------------------------------------------- load */

  async function save() {
    if (readOnly) return;
    const text = ta.value;
    // Put back what the <textarea> stripped: CRLF line endings and the BOM.
    const body = (bom ? '\uFEFF' : '') + (eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text);
    saveBtn.disabled = true;
    try {
      const r = await api.post(`/api/fs/${encodeURIComponent(mount)}/write`, {
        path, content: body, baseHash: hash,
      });
      hash = r.hash || hash;
      setDirty(false);
      renderStatus();
      toastOk('Saved ' + (r.name || entry.name));
    } catch (err) {
      if (err && err.status === 409) conflict();
      else toastErr('Could not save: ' + (err && err.message ? err.message : 'unknown error'));
    } finally {
      saveBtn.disabled = false;
    }
  }

  /** The file changed underneath us — never overwrite silently. */
  function conflict() {
    const { close: closeDlg } = dialog({
      title: 'File changed on disk',
      body: [
        el('p', { text: 'This file was modified after you opened it, so saving would overwrite those changes.' }),
        el('p', { class: 'muted', text: 'Reload to get the current version (your unsaved edits will be lost), or keep editing and copy anything you need first.' }),
      ],
      buttons: [
        { label: 'Keep editing' },
        {
          label: 'Reload',
          kind: 'primary',
          primary: true,
          onClick: () => { closeDlg(); reload(); },
        },
      ],
    });
  }

  async function reload() {
    try {
      const fresh = await api.get(`/api/fs/${encodeURIComponent(mount)}/text?path=${encodeURIComponent(path)}`);
      ta.value = fresh.content || '';
      hash = fresh.hash || '';
      eol = fresh.eol === 'crlf' ? 'crlf' : 'lf';
      eolEl.textContent = eol === 'crlf' ? 'CRLF' : 'LF';
      lastLines = -1;
      setDirty(false);
      renderGutter();
      renderStatus();
      toastOk('Reloaded ' + (fresh.name || entry.name));
    } catch (err) {
      toastErr('Could not reload: ' + (err && err.message ? err.message : 'unknown error'));
    }
  }

  function revert() {
    if (!dirty) { toastOk('No changes to revert'); return; }
    reload();
  }

  /* -------------------------------------------------------------- close */

  async function requestClose() {
    if (dirty && !readOnly) {
      const ok = await confirmDiscard();
      if (!ok) return;
    }
    close();
  }

  function confirmDiscard() {
    return new Promise((resolve) => {
      const { close: closeDlg } = dialog({
        title: 'Discard unsaved changes?',
        body: [el('p', { text: `${entry.name} has unsaved changes. Closing now will lose them.` })],
        buttons: [
          { label: 'Keep editing', onClick: () => resolve(false) },
          { label: 'Discard', kind: 'danger', onClick: () => { closeDlg(); resolve(true); } },
        ],
      });
    });
  }

  function close() {
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('beforeunload', onUnload);
    ov.remove();
  }

  // Esc is captured (not bubbled) so it still works while the textarea has
  // focus. A dialog stacked on top gets to handle its own Esc first.
  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (document.querySelector('.overlay')) return;
    e.preventDefault();
    requestClose();
  }
  document.addEventListener('keydown', onKey, true);

  function onUnload(e) { if (dirty && !readOnly) { e.preventDefault(); e.returnValue = ''; } }
  window.addEventListener('beforeunload', onUnload);

  /* --------------------------------------------------------- first paint */

  setWrap(false);
  renderGutter();
  renderStatus();
  setTimeout(() => {
    ta.focus();
    // Land on the first line rather than wherever the browser left the caret.
    // renderStatus() must follow: setting the range does not fire an event, so
    // without this the status bar keeps showing the pre-focus position.
    ta.setSelectionRange(0, 0);
    ta.scrollTop = 0;
    renderStatus();
  }, 20);
}
