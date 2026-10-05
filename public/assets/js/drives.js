'use strict';
/*
 * Drives view — the user-facing storage manager.
 *
 * A drive has a display name (renameable) and an immutable slug used by the API
 * and the on-disk directory, so renaming never breaks a path, a share link or a
 * recent entry. Disconnecting removes only the registration: the local folder or
 * remote bucket is left exactly as it is.
 */
import { el, clear } from './util.js';
import { api, invalidate } from './api.js';
import { state } from './state.js';
import { icon } from './icons.js';
import { dialog, confirmDialog, toast, toastOk, toastErr } from './ui.js';
import { ensureSensitive } from './sensitive.js';

const TYPE_LABEL = {
  local: 'Local storage',
  s3: 'S3-compatible object storage',
  ftp: 'FTP',
  ftps: 'FTPS',
  sftp: 'SFTP',
  smb: 'SMB / Windows share',
  http: 'WebDAV (HTTP)',
};

/** Provider presets — they only differ by endpoint and path-style default. */
const PROVIDERS = [
  { id: 'aws', label: 'Amazon S3', endpoint: 's3.amazonaws.com', pathStyle: false, regionHint: 'us-east-1' },
  { id: 'r2', label: 'Cloudflare R2', endpoint: '<account-id>.r2.cloudflarestorage.com', pathStyle: true, regionHint: 'auto' },
  { id: 'minio', label: 'MinIO / self-hosted', endpoint: 'https://minio.example.com', pathStyle: true, regionHint: 'us-east-1' },
  { id: 'other', label: 'Other S3-compatible', endpoint: '', pathStyle: true, regionHint: 'us-east-1' },
];

export async function renderDrivesView(container, { onChanged }) {
  const page = el('div', { class: 'admin-page' }, el('h2', {}, 'Drives'));
  page.appendChild(el('p', { class: 'muted', text:
    'Drives are the storage locations shown in the sidebar. Renaming a drive changes only its display name; disconnecting one never deletes the files behind it.' }));

  const toolbar = el('div', { class: 'admin-toolbar' });
  const addBtn = el('button', { class: 'btn primary' }, icon('plus'), 'Add drive');
  addBtn.addEventListener('click', () => addDriveDialog(onChanged));
  toolbar.appendChild(addBtn);
  page.appendChild(toolbar);

  let drives = [];
  try {
    const r = await api.get('/api/drives', { cacheKey: 'drives', ttl: 10000 });
    drives = r.drives || [];
  } catch (e) {
    toastErr(e.message);
  }

  if (!drives.length) {
    page.appendChild(el('div', { class: 'empty-state' },
      icon('drive', 'empty-ico'),
      el('div', { class: 'empty-title', text: 'No drives yet' }),
      el('div', { class: 'empty-sub muted', text: 'Add a local folder or connect an S3-compatible bucket.' }),
    ));
    container.appendChild(page);
    return;
  }

  const table = el('table', { class: 'table' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Name'),
      el('th', {}, 'Type'),
      el('th', {}, 'Identifier'),
      el('th', {}, 'Access'),
      el('th', {}, 'Actions'),
    )),
  );
  const tbody = el('tbody');
  for (const d of drives) {
    const actions = el('td', { class: 'row-actions-cell' });
    if (d.manageable) {
      const rename = el('button', { class: 'btn sm', title: 'Rename drive' }, icon('edit'), 'Rename');
      rename.addEventListener('click', () => renameDrive(d, onChanged));
      actions.appendChild(rename);

      const del = el('button', { class: 'btn sm danger', title: 'Disconnect this drive' }, icon('plug'), 'Disconnect');
      del.addEventListener('click', () => disconnectDrive(d, onChanged));
      actions.appendChild(del);
    } else {
      actions.appendChild(el('span', { class: 'muted', text: 'Shared with you' }));
    }

    tbody.appendChild(el('tr', {},
      el('td', {}, el('strong', { text: d.label || d.name })),
      el('td', { class: 'muted', text: TYPE_LABEL[d.adapter] || d.adapter }),
      el('td', {}, el('code', { class: 'muted', text: d.name })),
      el('td', { class: 'muted', text: d.canWrite ? 'Read & write' : 'Read only' }),
      actions,
    ));
  }
  table.appendChild(tbody);
  page.appendChild(table);
  container.appendChild(page);
}

async function renameDrive(drive, onChanged) {
  const input = el('input', { type: 'text', value: drive.label || drive.name, maxlength: '120' });
  const ok = await new Promise((resolve) => {
    dialog({
      title: 'Rename drive',
      body: [
        el('label', { class: 'field' }, 'Display name', input),
        el('p', { class: 'muted', text: 'The identifier stays "' + drive.name + '", so existing links and paths keep working.' }),
      ],
      buttons: [
        { label: 'Cancel', onClick: () => { resolve(false); } },
        {
          label: 'Save', kind: 'primary', primary: true,
          onClick: async () => {
            const label = input.value.trim();
            if (!label) { toastErr('A drive name is required'); return false; }
            try {
              await api.post(`/api/drives/${drive.id}/rename`, { label });
              invalidate('drives');
              invalidate('mounts');
              toastOk('Drive renamed');
              resolve(true);
              return true;
            } catch (e) { toastErr(e.message); return false; }
          },
        },
      ],
    });
  });
  if (ok && onChanged) onChanged();
}

async function disconnectDrive(drive, onChanged) {
  const ok = await confirmDialog(
    `Disconnect "${drive.label || drive.name}"? The files are NOT deleted — only this drive's registration is removed, so you can add it again later.`,
    { title: 'Disconnect drive', danger: true, okLabel: 'Disconnect' },
  );
  if (!ok) return;
  // Password gate, enforced server-side by SensitiveGate (scope drive.disconnect).
  const granted = await ensureSensitive('drive.disconnect');
  if (!granted) return;
  try {
    const r = await api.delete(`/api/drives/${drive.id}`);
    invalidate('drives');
    invalidate('mounts');
    invalidate('list:' + drive.name);
    toastOk('Drive disconnected — its data was left untouched');
    if (r && r.dataKept === false) toast('Warning: underlying data may have been affected', 'warn');
    if (onChanged) onChanged();
  } catch (e) { toastErr(e.message); }
}

/** Add-drive dialog: local, or an S3-compatible bucket with credentials. */
function addDriveDialog(onChanged) {
  const name = el('input', { type: 'text', placeholder: 'e.g. Work Drive', maxlength: '120' });
  const typeSel = el('select', {},
    el('option', { value: 'local', text: 'Local storage' }),
    el('option', { value: 's3', text: 'S3-compatible object storage' }),
  );

  const providerSel = el('select', {}, ...PROVIDERS.map(p => el('option', { value: p.id, text: p.label })));
  const endpoint = el('input', { type: 'text', placeholder: 'https://s3.amazonaws.com' });
  const region = el('input', { type: 'text', placeholder: 'us-east-1' });
  const bucket = el('input', { type: 'text', placeholder: 'my-bucket' });
  const accessKey = el('input', { type: 'text', placeholder: 'Access Key ID', autocomplete: 'off' });
  const secretKey = el('input', { type: 'password', placeholder: 'Secret Access Key', autocomplete: 'new-password' });
  const pathStyle = el('input', { type: 'checkbox' });

  const s3Fields = el('div', { class: 'field-grid' },
    el('label', { class: 'field' }, 'Provider', providerSel),
    el('label', { class: 'field' }, 'Endpoint', endpoint),
    el('label', { class: 'field' }, 'Region', region),
    el('label', { class: 'field' }, 'Bucket', bucket),
    el('label', { class: 'field' }, 'Access Key ID', accessKey),
    el('label', { class: 'field' }, 'Secret Access Key', secretKey),
    el('label', { class: 'checkbox' }, pathStyle, el('span', { text: 'Use path-style requests (R2, MinIO)' })),
    el('p', { class: 'muted', text: 'The secret key is encrypted at rest and is never sent back to the browser, written to a URL, or logged.' }),
  );
  s3Fields.hidden = true;

  const syncType = () => {
    const isS3 = typeSel.value === 's3';
    s3Fields.hidden = !isS3;
    if (isS3 && endpoint.value === '') applyProvider();
  };
  typeSel.addEventListener('change', syncType);

  const applyProvider = () => {
    const p = PROVIDERS.find(x => x.id === providerSel.value) || PROVIDERS[0];
    endpoint.value = p.endpoint;
    region.value = p.regionHint;
    pathStyle.checked = p.pathStyle;
  };
  providerSel.addEventListener('change', applyProvider);

  const testBtn = el('button', { class: 'btn' }, 'Test connection');
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testBtn.textContent = 'Testing…';
    try {
      const r = await api.post('/api/connections/test', {
        protocol: 's3',
        endpoint: endpoint.value.trim(),
        region: region.value.trim(),
        bucket: bucket.value.trim(),
        accessKeyId: accessKey.value.trim(),
        secretAccessKey: secretKey.value,
        pathStyle: pathStyle.checked,
      });
      if (r && r.reachable) toastOk('Connection successful');
      else toastErr('Connection failed: ' + ((r && r.error) || 'unknown error'));
    } catch (e) { toastErr(e.message); }
    finally { testBtn.disabled = false; testBtn.textContent = 'Test connection'; }
  });
  s3Fields.appendChild(testBtn);

  dialog({
    title: 'Add drive',
    body: [
      el('label', { class: 'field' }, 'Drive name', name),
      el('label', { class: 'field' }, 'Type', typeSel),
      s3Fields,
    ],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Add drive', kind: 'primary', primary: true,
        onClick: async () => {
          const label = name.value.trim();
          if (!label) { toastErr('A drive name is required'); return false; }
          try {
            if (typeSel.value === 's3') {
              if (!endpoint.value.trim() || !bucket.value.trim()
                  || !accessKey.value.trim() || !secretKey.value) {
                toastErr('Endpoint, bucket and both keys are required');
                return false;
              }
              const conn = await api.post('/api/connections', {
                name: label,
                protocol: 's3',
                endpoint: endpoint.value.trim(),
                region: region.value.trim(),
                bucket: bucket.value.trim(),
                accessKeyId: accessKey.value.trim(),
                secretAccessKey: secretKey.value,
                pathStyle: pathStyle.checked,
              });
              await api.post('/api/drives', { label, adapter: 's3', connectionId: conn.id });
            } else {
              await api.post('/api/drives', { label, adapter: 'local' });
            }
            invalidate('drives');
            invalidate('mounts');
            invalidate('connections');
            toastOk('Drive added');
            if (onChanged) onChanged();
            return true;
          } catch (e) { toastErr(e.message); return false; }
        },
      },
    ],
  });

  setTimeout(() => name.focus(), 40);
}
