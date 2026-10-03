'use strict';
/* Real-time layer: ticket-authenticated WebSocket with auto-reconnect. */

let ws = null;
let reconnectTimer = null;
let closedByUs = false;
const listeners = new Map();

async function mintTicket(channel) {
  const { api } = await import('./api.js');
  const r = await api.post('/api/ws/ticket', { channel });
  return r.ticket;
}

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

function emit(event, data) {
  const set = listeners.get(event);
  if (set) for (const fn of set) { try { fn(data); } catch (e) { console.error(e); } }
}

export async function connect() {
  clearTimeout(reconnectTimer);
  closedByUs = false;
  try {
    const ticket = await mintTicket('events');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?channel=events&ticket=${encodeURIComponent(ticket)}`);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.event) emit(msg.event, msg.data);
    } catch (_) { /* ignore */ }
  };
  ws.onclose = () => { if (!closedByUs) scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}

function scheduleReconnect() {
  reconnectTimer = setTimeout(connect, 5000 + Math.random() * 3000);
}

export function disconnect() {
  closedByUs = true;
  clearTimeout(reconnectTimer);
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
}
