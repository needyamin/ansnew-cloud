'use strict';
/*
 * Bulk rename — rename a whole selection with one rule.
 *
 * The rule is computed here and sent as an explicit old->new list. That keeps
 * the server dumb (it validates each name and moves the file) and lets the user
 * see exactly what will happen before anything is touched.
 */
import { el, clear } from './util.js';
import { dialog, toastOk, toastErr } from './ui.js';
import { fsRenameBatch } from './fsops.js';

/**
 * Split into base + extension. A leading dot is part of the name, not an
 * extension, so ".gitignore" has no extension and "archive.tar.gz" ends at the
 * last dot.
 */
export function splitName(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  if (i <= 0) return { base: s, ext: '' };
  return { base: s.slice(0, i), ext: s.slice(i) };
}

const MODES = [
  { id: 'replace', label: 'Find and replace' },
  { id: 'prefix', label: 'Add prefix' },
  { id: 'suffix', label: 'Add suffix' },
  { id: 'number', label: 'Number sequentially' },
  { id: 'case', label: 'Change case' },
];

const CASES = [
  { id: 'lower', label: 'lowercase' },
  { id: 'upper', label: 'UPPERCASE' },
  { id: 'title', label: 'Title Case' },
];

function titleCase(s) {
  return s.replace(/(^|[\s_\-.])(\w)/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/** Apply the current rule to one name. */
export function applyRule(name, rule, index) {
  const { base, ext } = splitName(name);
  const target = rule.affectExtension ? String(name || '') : base;
  let out = target;

  switch (rule.mode) {
    case 'replace': {
      const find = rule.find || '';
      if (find === '') { out = target; break; }
      if (rule.caseSensitive) out = target.split(find).join(rule.replaceWith ?? '');
      else {
        // Case-insensitive replace without a regex: escape the needle and use
        // the 'gi' flags, so user input can never act as a pattern.
        const esc = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = target.replace(new RegExp(esc, 'gi'), rule.replaceWith ?? '');
      }
      break;
    }
    case 'prefix': out = (rule.prefix || '') + target; break;
    case 'suffix': out = target + (rule.suffix || ''); break;
    case 'number': {
      const n = (rule.start ?? 1) + index * (rule.step ?? 1);
      const pad = Math.max(1, Math.min(6, rule.pad || 1));
      const digits = String(n).padStart(pad, '0');
      // {n} is substituted; without it the number is appended.
      out = (rule.pattern && rule.pattern.includes('{n}'))
        ? rule.pattern.replace(/\{n\}/g, digits)
        : target + digits;
      break;
    }
    case 'case':
      if (rule.caseMode === 'lower') out = target.toLowerCase();
      else if (rule.caseMode === 'upper') out = target.toUpperCase();
      else out = titleCase(target);
      break;
    default: out = target;
  }

  return rule.affectExtension ? out : out + ext;
}

/**
 * Open the bulk-rename dialog.
 *
 * @param {object} opts
 * @param {string} opts.mount
 * @param {Array}  opts.entries     selected entries (must share one directory)
 * @param {Array<string>} opts.siblingNames  every other name in that directory
 * @param {Function} opts.onDone    () => void
 */
export function bulkRenameDialog({ mount, entries, siblingNames = [], onDone }) {
  if (!entries || entries.length < 2) {
    toastErr('Select at least two items to rename');
    return;
  }

  const dir = entries[0].path.slice(0, entries[0].path.lastIndexOf('/')) || '/';
  if (entries.some((e) => (e.path.slice(0, e.path.lastIndexOf('/')) || '/') !== dir)) {
    toastErr('Bulk rename works on items in the same folder');
    return;
  }

  const rule = {
    mode: 'replace',
    affectExtension: false,
    find: '', replaceWith: '',
    prefix: '', suffix: '',
    pattern: '{n}', start: 1, step: 1, pad: 2,
    caseMode: 'lower',
    caseSensitive: false,
  };

  const preview = el('div', { class: 'rename-preview' });
  const warn = el('div', { class: 'err', style: 'color:var(--warn);font-size:12.5px;min-height:16px' });

  const sel = (opts, value, onChange, cls = '') => {
    const s = el('select', { class: cls }, ...opts.map((o) => el('option', { value: o.id, text: o.label })));
    s.value = value;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  };
  const txt = (value, placeholder, onChange) => {
    const i = el('input', { type: 'text', value, placeholder, style: 'width:100%' });
    i.addEventListener('input', () => onChange(i.value));
    return i;
  };
  const num = (value, onChange) => {
    const i = el('input', { type: 'number', value, style: 'width:90px' });
    i.addEventListener('input', () => onChange(parseInt(i.value, 10)));
    return i;
  };
  const check = (label, value, onChange) => {
    const c = el('input', { type: 'checkbox' });
    c.checked = !!value;
    c.addEventListener('change', () => onChange(c.checked));
    return el('label', { class: 'checkbox' }, c, el('span', { text: label }));
  };

  const modeSel = sel(MODES, rule.mode, (v) => { rule.mode = v; refresh(); });

  // One row per mode; only the active one is shown, so the dialog never
  // presents five sets of controls at once.
  const rows = {
    replace: el('div', { class: 'field-grid' },
      el('label', { class: 'field' }, 'Find', txt(rule.find, 'text to find', (v) => { rule.find = v; refresh(); })),
      el('label', { class: 'field' }, 'Replace with', txt(rule.replaceWith, 'replacement', (v) => { rule.replaceWith = v; refresh(); })),
      check('Case sensitive', rule.caseSensitive, (v) => { rule.caseSensitive = v; refresh(); }),
    ),
    prefix: el('div', { class: 'field-grid' },
      el('label', { class: 'field' }, 'Prefix', txt(rule.prefix, 'e.g. 2026-', (v) => { rule.prefix = v; refresh(); })),
    ),
    suffix: el('div', { class: 'field-grid' },
      el('label', { class: 'field' }, 'Suffix', txt(rule.suffix, 'e.g. -final', (v) => { rule.suffix = v; refresh(); })),
    ),
    number: el('div', { class: 'field-grid' },
      el('label', { class: 'field' }, 'Pattern (use {n})', txt(rule.pattern, '{n}', (v) => { rule.pattern = v; refresh(); })),
      el('label', { class: 'field' }, 'Start at', num(rule.start, (v) => { rule.start = Number.isFinite(v) ? v : 1; refresh(); })),
      el('label', { class: 'field' }, 'Step', num(rule.step, (v) => { rule.step = Number.isFinite(v) ? v : 1; refresh(); })),
      el('label', { class: 'field' }, 'Min digits', num(rule.pad, (v) => { rule.pad = Number.isFinite(v) ? v : 1; refresh(); })),
    ),
    case: el('div', { class: 'field-grid' },
      el('label', { class: 'field' }, 'Convert to', sel(CASES, rule.caseMode, (v) => { rule.caseMode = v; refresh(); })),
    ),
  };
  for (const k of Object.keys(rows)) rows[k].hidden = k !== rule.mode;

  const extCheck = check('Apply to the extension too', rule.affectExtension,
    (v) => { rule.affectExtension = v; refresh(); });

  function compute() {
    return entries.map((e, i) => ({ entry: e, from: e.name, to: applyRule(e.name, rule, i) }));
  }

  function refresh() {
    modeSel.value = rule.mode;
    for (const k of Object.keys(rows)) rows[k].hidden = k !== rule.mode;

    const plan = compute();
    const sources = new Set(plan.map((p) => p.from));
    const taken = new Set(siblingNames);

    let clashes = 0;
    let noops = 0;
    clear(preview);
    for (const p of plan) {
      let problem = '';
      if (p.to === p.from) { noops++; }
      else if (plan.filter((x) => x.to === p.to).length > 1) {
        problem = 'Another item renames to the same name'; clashes++;
      } else if (taken.has(p.to) && !sources.has(p.to)) {
        problem = 'Name already used in this folder'; clashes++;
      } else if (sources.has(p.to)) {
        problem = 'Renaming over another item in this batch'; clashes++;
      }
      preview.appendChild(el('div', { class: 'rename-row' + (problem ? ' bad' : '') },
        el('span', { class: 'rn-from', text: p.from, title: p.from }),
        el('span', { class: 'rn-arrow muted', text: '→' }),
        el('span', { class: 'rn-to', text: p.to, title: p.to }),
        problem ? el('span', { class: 'rn-err', text: problem }) : null,
      ));
    }

    const willChange = plan.filter((p) => p.to !== p.from).length;
    if (clashes) warn.textContent = `${clashes} name(s) cannot be renamed — fix them or deselect those items.`;
    else if (!willChange) warn.textContent = 'No names would change with this rule.';
    else warn.textContent = `${willChange} of ${plan.length} item(s) will be renamed${noops ? `, ${noops} unchanged` : ''}.`;

    okBtn.disabled = willChange === 0 || clashes > 0;
  }

  // Disabling the confirm button needs a handle on the node dialog() builds.
  let okBtn = null;

  const { dlg } = dialog({
    title: `Rename ${entries.length} items`,
    body: [
      el('label', { class: 'field' }, 'Rule', modeSel),
      ...Object.values(rows),
      extCheck,
      el('div', { class: 'muted', style: 'font-size:12.5px', text: 'Preview — nothing changes until you confirm.' }),
      preview,
      warn,
    ],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Rename', kind: 'primary', primary: true,
        onClick: async () => {
          const plan = compute().filter((p) => p.to !== p.from);
          if (!plan.length) return false;
          try {
            const r = await fsRenameBatch(mount, plan.map((p) => ({ path: p.entry.path, name: p.to })));
            const failed = (r && r.failed) || [];
            if (failed.length) toastErr(`${failed.length} item(s) could not be renamed: ${failed[0].error}`);
            const done = (r && r.done) || [];
            if (done.length) toastOk(`Renamed ${done.length} item(s)`);
            if (onDone) onDone();
            return true;
          } catch (e) {
            toastErr(e.message);
            return false;
          }
        },
      },
    ],
  });

  okBtn = dlg.querySelector('footer .btn.primary');
  refresh();
  return dlg;
}
