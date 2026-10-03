'use strict';
/**
 * ANSNEW CLOUD WebSocket server.
 *  - /health            health endpoint (compose healthcheck)
 *  - /ws?ticket=...     browser connection (one-time ticket from /api/ws/ticket)
 *  - /internal/notify   PHP worker pushes job progress (X-Internal-Secret)
 *
 * Ticket validation and future internal queries go through the PHP API via
 * the shared X-Internal-Secret (compose network only; never browser-visible).
 */

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.WS_PORT || '3001', 10);
const PHP_API_URL = (process.env.PHP_API_URL || 'http://nginx:8080').replace(/\/+$/, '');

// ---- shared secret (env first; falls back to the generated key file) -------
let INTERNAL_SECRET = process.env.WS_SECRET || '';
const fs = require('fs');
function loadSecret() {
  if (INTERNAL_SECRET) return INTERNAL_SECRET;
  try {
    const fromFile = fs.readFileSync((process.env.ANSNEW_DATA_DIR || '/var/www/data') + '/keys/ws.secret', 'utf8').trim();
    if (fromFile) INTERNAL_SECRET = fromFile;
  } catch (_) { /* retry later */ }
  return INTERNAL_SECRET;
}
loadSecret();
setInterval(loadSecret, 10000);

function phpInternal(path, payload) {
  return new Promise((resolve) => {
    if (!loadSecret()) return resolve(null);
    const body = JSON.stringify(payload || {});
    const url = new URL(PHP_API_URL + path);
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Internal-Secret': INTERNAL_SECRET,
      },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

// ---- state -------------------------------------------------------------------
const rooms = new Map(); // userId -> Set<ws>

function sendTo(userId, payload) {
  const set = rooms.get(userId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === 1) { try { ws.send(data); } catch (_) {} }
  }
}

// ---- HTTP surface --------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()) }));
    return;
  }
  if (req.url === '/internal/notify' && req.method === 'POST') {
    if (!loadSecret() || req.headers['x-internal-secret'] !== INTERNAL_SECRET) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    let body = '';
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 65536) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body || '{}');
        const userIds = Array.isArray(msg.userIds) ? msg.userIds : [];
        for (const id of userIds) sendTo(Number(id), { event: msg.event || 'notify', data: msg.data });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (_) { res.writeHead(400); res.end('bad request'); }
    });
    return;
  }
  res.writeHead(404); res.end();
});

// ---- browser WS ------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const channel = url.searchParams.get('channel') || 'events';
  const ticket = url.searchParams.get('ticket') || '';

  const resp = await phpInternal('/api/internal/ws-ticket', { ticket, channel });
  const info = resp && resp.ok ? resp.data : null;
  if (!info || !info.user_id) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.userId = Number(info.user_id);
    ws.channel = info.channel || channel;
    if (!rooms.has(ws.userId)) rooms.set(ws.userId, new Set());
    rooms.get(ws.userId).add(ws);
    try { ws.send(JSON.stringify({ event: 'hello', data: { channel: ws.channel } })); } catch (_) {}
    ws.on('message', () => {}); // events channel is push-only
    ws.on('close', () => {
      const set = rooms.get(ws.userId);
      if (set) { set.delete(ws); if (set.size === 0) rooms.delete(ws.userId); }
    });
    ws.on('error', () => {});
  });
});

wss.on('error', () => {});

server.listen(PORT, () => {
  console.log('[ansnew-ws] listening on ' + PORT);
});