'use strict';
/* Small DOM + formatting helpers shared across the SPA. */

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v; // only with trusted, sanitized content
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

export function fmtSize(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { bytes /= 1024; i++; } while (bytes >= 1024 && i < units.length - 1);
  return bytes.toFixed(bytes >= 100 ? 0 : 1) + ' ' + units[i];
}

export function fmtDate(unix) {
  const t = Number(unix);
  if (!t) return '—';
  const d = new Date(t * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const opts = sameDay ? { hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  return d.toLocaleString(undefined, opts);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Very small, safe Markdown subset renderer: headings, bold, italic, code, links, lists, breaks. */
export function renderMarkdown(src) {
  const lines = String(src).split(/\r?\n/);
  const out = [];
  let inList = false;
  const inline = (s) => escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const li = line.match(/^\s*[-*]\s+(.*)/);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push('<li>' + inline(li[1]) + '</li>');
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { out.push(`<h${h[1].length}>` + inline(h[2]) + `</h${h[1].length}>`); continue; }
    if (line.trim() === '') { out.push('<p></p>'); continue; }
    out.push('<p>' + inline(line) + '</p>');
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

/** Simple debounce. */
export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
