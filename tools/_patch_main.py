#!/usr/bin/env python3
"""One-shot patcher for public/assets/js/main.js — part 3 (helpers, cleanup)."""
import io

p = 'public/assets/js/main.js'
s = io.open(p, encoding='utf-8').read()


def sub(old, new, count=1):
    global s
    assert old in s, 'MISSING ANCHOR:\n' + old[:300]
    s = s.replace(old, new, count)


# ------------------------------------------------------------------- imports
sub("  triggerDownload, fsList,\n", "  fsList,\n")

# ------------------------------------------------- drop the dead token poller
sub("let watchTimers = new Map();\n", "")

start = s.index("/**\n * Fallback path for when a push arrives without the job's result.")
end = s.index("function globalKeys(e) {")
s = s[:start] + s[end:]

# ---------------------------------------------------------- history dialog
sub(
    """function globalKeys(e) {""",
    """/**
 * The full undo/redo stack.
 *
 * Ctrl+Z and Ctrl+Y cover the common case; this is for when someone wants a
 * specific step back — the server keeps the last 100 operations.
 */
async function historyDialog() {
  const { entries } = await refreshHistory();
  if (!entries.length) { toast('No operations recorded yet.', 'info'); return; }

  const list = el('div', { class: 'history-list' });
  for (const e of entries) {
    const row = el('div', { class: 'history-row' + (e.undone ? ' undone' : '') },
      el('span', { class: 'hi-op', text: historyLabel(e) }),
      el('span', { class: 'muted', text: e.undone ? 'reversed' : 'applied' }),
      el('span', { style: 'flex:1' }),
      el('button', {
        class: 'btn sm', text: e.undone ? 'Redo' : 'Undo',
        onclick: async () => {
          if (e.undone) await redoStep(e.id); else await undoStep(e.id);
          await afterHistoryChange();
          historyDialog();
        },
      }),
    );
    list.appendChild(row);
  }

  dialog({
    title: 'Undo history',
    body: [el('p', { class: 'muted', text: 'Operations are kept on the server, so this list survives a reload. Doing something new clears the redo branch.' }), list],
    buttons: [
      {
        label: 'Clear history', danger: true,
        onClick: async () => { await clearHistory(); },
      },
      { label: 'Close' },
    ],
  });
}

/* ------------------------------------------------------- This PC / drives */

/** Back / forward through the active tab's history (Alt+Left, Alt+Right). */
function goHistory(delta) {
  const tab = currentTab();
  if (!tab || !tab.history || !tab.history.length) return;
  const i = tab.histIdx + delta;
  if (i < 0 || i > tab.history.length - 1) return;
  const loc = tab.history[i];
  tab.histIdx = i;
  if (pane) pane.navigate(loc.mount, loc.path, false);
  renderTabs();
}

/** Properties for one file or folder. */
async function entryProperties(inst, entry) {
  let stat = entry;
  try {
    stat = await api.get(
      `/api/fs/${encodeURIComponent(inst.loc.mount)}/stat?path=${encodeURIComponent(entry.path)}`,
    ) || entry;
  } catch (_) { /* the listing row is good enough */ }

  const row = (k, v) => el('div', { class: 'prop-row' },
    el('span', { class: 'prop-k muted', text: k }),
    el('span', { class: 'prop-v', text: v === null || v === undefined || v === '' ? '—' : String(v) }));

  dialog({
    title: entry.name + ' Properties',
    body: [
      row('Name', entry.name),
      row('Type', entry.type === 'dir' ? 'Folder' : (stat.mime || (entry.extension ? entry.extension.toUpperCase() + ' file' : 'File'))),
      row('Size', entry.type === 'dir' ? '—' : fmtSize(stat.size ?? entry.size)),
      row('Modified', fmtDate(stat.mtime ?? entry.mtime)),
      row('Location', `${inst.mountInfo?.label || inst.loc.mount}:${dirOf(entry.path)}`),
      row('Permissions', stat.mode || stat.perms || '—'),
      row('Owner', stat.owner || '—'),
    ],
    buttons: [{ label: 'Close' }],
  });
}

/** Drive report for whatever drive a pane is currently showing. */
async function openDriveProperties(mountName) {
  const drives = (state.drivesInfo && state.drivesInfo.length)
    ? state.drivesInfo
    : await loadDrives();
  const d = (drives || []).find((x) => x.mount === mountName);
  if (d) propertiesDialog(d);
  else toastWarn('No drive information available for ' + mountName);
}

async function renameDriveFromPc(d) {
  const label = await promptDialog('New name for this drive', d.label, { title: 'Rename drive', okLabel: 'Rename' });
  if (!label || label === d.label) return;
  try {
    await api.post(`/api/drives/${encodeURIComponent(d.id)}/rename`, { label });
    toastOk('Drive renamed');
    await onDrivesChanged();
    await loadDrives(true);
    showView('thispc');
  } catch (e) { toastErr(e.message); }
}

async function scanDriveFromPc(d) {
  try {
    await api.post(`/api/usage/${encodeURIComponent(d.mount)}/scan`, {});
    toast('Scanning storage in the background…', 'info');
    openJobs();
  } catch (e) { toastErr(e.message); }
}

async function disconnectDriveFromPc(d) {
  const ok = await confirmDialog(
    `Disconnect "${d.label}"? Nothing is deleted — the files stay where they are, and the drive can be added back later.`,
    { title: 'Disconnect drive', danger: true, okLabel: 'Disconnect' },
  );
  if (!ok) return;
  const res = await withSensitive('drive.disconnect', () => api.delete(`/api/drives/${encodeURIComponent(d.id)}`));
  if (!res) return;
  toastOk('Drive disconnected — data kept');
  await onDrivesChanged();
  await loadDrives(true);
  showView('thispc');
}

function globalKeys(e) {""",
)

# ------------------------------------------------------ "more" menu addition
sub(
    """      { label: 'Background jobs', icon: 'job', onClick: () => jobsBtn.click() },""",
    """      { label: 'Background jobs', icon: 'job', onClick: () => jobsBtn.click() },
      { label: 'Downloads', icon: 'download', onClick: () => openTray() },
      { label: 'Undo history…', icon: 'undo', onClick: () => historyDialog() },""",
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('main.js patched (part 3)')
