'use strict';
/*
 * "This PC": the Windows Explorer landing page.
 *
 * One card per drive with everything Explorer shows — letter, name, type, a
 * usage bar and "x free of y" — plus the disk-health line a web UI normally
 * leaves out. Health comes straight from the server's probe; whatever the
 * platform cannot measure is rendered as "Information unavailable" rather than
 * a plausible-looking number.
 */
import { el, clear, fmtSize, fmtDate } from './util.js';
import { api, invalidate } from './api.js';
import { icon } from './icons.js';
import { toast, toastErr, dialog, confirmDialog, promptDialog } from './ui.js';
import { state } from './state.js';

/** Cache key for the drive report. */
const KEY = 'drives-info';

const HEALTH_TONE = {
  ok: 'ok',
  warning: 'warn',
  failed: 'err',
  unknown: 'muted',
};
const UNAVAILABLE = 'Information unavailable';

/** Reload the drive report. `force` re-probes instead of using the cache. */
export async function loadDrives(force = false) {
  try {
    const r = await api.get('/api/drives/info' + (force ? '?refresh=1' : ''), {
      cacheKey: KEY, ttl: 60000, force,
    });
    state.drivesInfo = r.drives || [];
    return state.drivesInfo;
  } catch (e) {
    toastErr(e.message);
    return state.drivesInfo || [];
  }
}

/**
 * @param {HTMLElement} c
 * @param {{onOpenDrive:Function,onChanged:Function}} opts
 */
export async function renderThisPcView(c, opts = {}) {
  const { onOpenDrive } = opts;
  clear(c);

  const page = el('div', { class: 'thispc' });
  const bar = el('div', { class: 'admin-toolbar' });
  page.appendChild(bar);

  const refresh = el('button', { class: 'btn' }, icon('refresh'), el('span', { text: 'Refresh' }));
  refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    await loadDrives(true);
    renderThisPcView(c, opts);
  });
  const scan = el('button', { class: 'btn' }, icon('info'), el('span', { text: 'Scan usage' }));
  scan.addEventListener('click', async () => {
    for (const d of state.drivesInfo || []) {
      try { await api.post(`/api/usage/${encodeURIComponent(d.mount)}/scan`, {}); } catch (_) { /* skip */ }
    }
    toast('Scanning storage in the background…', 'info');
  });
  bar.append(refresh, scan);

  const grid = el('div', { class: 'drive-grid' });
  page.appendChild(grid);
  c.appendChild(page);

  if (!state.drivesInfo) await loadDrives();
  const drives = state.drivesInfo || [];

  if (!drives.length) {
    grid.appendChild(el('div', { class: 'empty-state' },
      icon('drive', 'empty-ico'),
      el('div', { class: 'empty-title', text: 'No drives' }),
      el('div', { class: 'empty-sub muted', text: 'Add a drive to start browsing.' }),
    ));
    return;
  }

  for (const d of drives) {
    grid.appendChild(driveCard(d, opts));
  }
}

/* ----------------------------------------------------------------- cards */

function driveCard(d, opts) {
  const cap = d.capacity || {};
  const usage = d.usage || {};
  const health = d.health || {};

  const pct = cap.available && cap.percent !== null ? cap.percent : null;
  const tone = pct === null ? 'muted' : pct >= 90 ? 'err' : pct >= 75 ? 'warn' : 'ok';

  const card = el('div', { class: 'drive-card', tabindex: '0', title: `${d.label} — ${d.type}` },
    el('div', { class: 'dc-head' },
      icon(driveIcon(d), 'dc-ico'),
      el('div', { class: 'dc-title' },
        el('div', { class: 'dc-name' },
          el('span', { text: d.label }),
          d.letter ? el('span', { class: 'dc-letter', text: d.letter }) : null,
        ),
        el('div', { class: 'dc-type muted', text: d.type }),
      ),
      d.readOnly ? el('span', { class: 'badge off', text: 'Read-only' }) : null,
    ),
    el('div', { class: 'dc-bar' + (pct === null ? ' unknown' : '') },
      el('i', { class: 'fill ' + tone, style: 'width:' + (pct === null ? 0 : pct) + '%' }),
    ),
    el('div', { class: 'dc-cap' },
      cap.available
        ? el('span', { text: `${fmtSize(cap.free)} free of ${fmtSize(cap.total)}` })
        : el('span', { class: 'muted', text: cap.reason || UNAVAILABLE }),
      el('span', { class: 'muted', text: pct === null ? '' : Math.round(pct) + '% used' }),
    ),
    el('div', { class: 'dc-usage muted', text: usageText(d) }),
    el('div', { class: 'dc-health' },
      el('span', { class: 'badge ' + (HEALTH_TONE[health.status] || 'muted'),
        text: health.available ? (health.statusLabel || 'Health OK') : UNAVAILABLE }),
      health.temperatureC !== null && health.temperatureC !== undefined
        ? el('span', { class: 'muted', text: `${Math.round(health.temperatureC)}°C` })
        : null,
    ),
  );

  card.addEventListener('dblclick', () => opts.onOpenDrive && opts.onOpenDrive(d));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); opts.onOpenDrive && opts.onOpenDrive(d); }
  });
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    driveMenu(e.clientX, e.clientY, d, opts);
  });
  return card;
}

function usageText(d) {
  const usage = d.usage || {};
  if (usage.available) {
    const when = usage.scannedAt ? ' · scanned ' + fmtDate(Math.floor(Date.parse(usage.scannedAt) / 1000)) : '';
    return `${fmtSize(usage.used)} in ${usage.files} file(s)${when}`;
  }
  return 'Usage: not scanned yet — press “Scan usage”';
}

function driveIcon(d) {
  if (d.adapter === 's3') return 'cloud';
  if (d.adapter === 'local') return 'drive';
  return 'plug';
}

/* ------------------------------------------------------------ context menu */

function driveMenu(x, y, d, opts) {
  const menu = el('div', { class: 'ctxmenu' });
  const item = (label, ico, fn, danger = false) => {
    const b = el('button', { class: danger ? 'danger' : '' }, icon(ico), el('span', { text: label }));
    b.addEventListener('click', () => { menu.remove(); fn(); });
    menu.appendChild(b);
  };

  item('Open', 'folder', () => opts.onOpenDrive && opts.onOpenDrive(d));
  item('Back up this drive…', 'shield', () => opts.onBackupDrive && opts.onBackupDrive(d));
  item('Properties', 'info', () => propertiesDialog(d));
  menu.appendChild(el('div', { class: 'sep' }));
  if (opts.onRenameDrive) item('Rename', 'edit', () => opts.onRenameDrive(d));
  if (opts.onScanDrive) item('Scan usage', 'info', () => opts.onScanDrive(d));
  if (opts.onDisconnectDrive) {
    menu.appendChild(el('div', { class: 'sep' }));
    item('Disconnect', 'trash', () => opts.onDisconnectDrive(d), true);
  }

  menu.style.left = Math.max(6, Math.min(x, window.innerWidth - 220)) + 'px';
  menu.style.top = Math.max(6, Math.min(y, window.innerHeight - menu.childElementCount * 34 - 20)) + 'px';
  document.body.appendChild(menu);
  const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); cleanup(); } };
  const onEsc = (e) => { if (e.key === 'Escape') { menu.remove(); cleanup(); } };
  function cleanup() {
    document.removeEventListener('mousedown', close, true);
    document.removeEventListener('keydown', onEsc);
  }
  setTimeout(() => {
    document.addEventListener('mousedown', close, true);
    document.addEventListener('keydown', onEsc);
  }, 0);
}

/* -------------------------------------------------------------- properties */

/** Row helper: label + value, where a missing value says so explicitly. */
function row(label, value, unit = '') {
  const missing = value === null || value === undefined || value === '';
  return el('div', { class: 'prop-row' },
    el('span', { class: 'prop-k muted', text: label }),
    el('span', { class: 'prop-v' + (missing ? ' muted' : ''), text: missing ? UNAVAILABLE : String(value) + unit }),
  );
}

export function propertiesDialog(d) {
  const cap = d.capacity || {};
  const usage = d.usage || {};
  const h = d.health || {};

  const general = el('div', { class: 'prop-group' },
    el('h4', { text: 'General' }),
    row('Name', d.label),
    row('Drive', d.letter || d.mount),
    row('Type', d.type),
    row('Location', d.root || d.mountPoint || d.mount),
    row('File system', d.fileSystem),
    row('Device', d.device),
    d.quotaBytes ? row('Quota', fmtSize(d.quotaBytes)) : null,
  );

  const capacity = el('div', { class: 'prop-group' },
    el('h4', { text: 'Capacity' }),
    row('Total', cap.available ? fmtSize(cap.total) : null),
    row('Used', cap.available ? fmtSize(cap.used) : null),
    row('Free', cap.available ? fmtSize(cap.free) : null),
    row('Used %', cap.available && cap.percent !== null ? String(Math.round(cap.percent)) : null, '%'),
    row('Data on this drive', usage.available ? fmtSize(usage.used) : null),
    row('Files on this drive', usage.available ? String(usage.files) : null),
    cap.available && cap.scope === 'filesystem'
      ? el('p', { class: 'muted', style: 'font-size:12px;margin:6px 0 0',
          text: 'Capacity is measured for the whole filesystem, which may hold more than this drive.' })
      : null,
  );

  const health = el('div', { class: 'prop-group' },
    el('h4', { text: 'Disk health' }),
    row('Status', h.available ? h.statusLabel : null),
    row('SMART overall', h.smartPassed === null || h.smartPassed === undefined ? null : (h.smartPassed ? 'Passing' : 'Failing')),
    row('Temperature', h.temperatureC, '°C'),
    row('Wear (used)', h.wearPercent, '%'),
    row('Life remaining', h.lifeRemainingPercent, '%'),
    row('Read errors', h.readErrors),
    row('Write errors', h.writeErrors),
    row('Reallocated sectors', h.reallocatedSectors),
    row('Power-on hours', h.powerOnHours),
    row('Model', h.model),
    row('Serial', h.serial),
  );

  if (h.reason) {
    health.appendChild(el('p', { class: 'muted', style: 'font-size:12px;margin:6px 0 0', text: h.reason }));
  }
  for (const n of h.notes || []) {
    health.appendChild(el('p', { class: 'muted', style: 'font-size:12px;margin:4px 0 0', text: '· ' + n }));
  }

  dialog({
    title: d.label + ' Properties',
    body: [general, capacity, health],
    buttons: [
      { label: 'Close' },
      {
        label: 'Re-scan', kind: 'primary', primary: true,
        onClick: async () => {
          try {
            const r = await api.get(`/api/drives/${encodeURIComponent(d.mount)}/health?refresh=1`);
            invalidate('drives-info');
            await loadDrives(true);
            propertiesDialog(r.drive || d);
          } catch (e) { toastErr(e.message); return false; }
        },
      },
    ],
  });
}
