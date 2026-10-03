// ANSNEW CLOUD WebSocket end-to-end check:
//   login -> POST /api/ws/ticket -> connect ws://.../ws?ticket=... -> expect "hello"
const BASE = 'http://127.0.0.1:8081';
const WS_BASE = 'ws://127.0.0.1:8081';
const PW = process.env.ANSNEW_PW;
if (!PW) { console.error('set ANSNEW_PW'); process.exit(2); }

// Cookie jar: replace per-name, because the session id is rotated on login and
// a stale duplicate would win the lookup server-side.
const jar = new Map();
function saveCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const H = () => ({ 'Content-Type': 'application/json', Cookie: cookieHeader() });

const boot = await fetch(`${BASE}/api/bootstrap`);
saveCookies(boot);
const bootJson = await boot.json();
let csrf = bootJson.data.csrf;

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { ...H(), 'X-CSRF-Token': csrf },
  body: JSON.stringify({ username: 'admin', password: PW }),
});
saveCookies(login);
const loginJson = await login.json();
if (!loginJson.ok) { console.error('login failed', loginJson); process.exit(1); }
csrf = loginJson.data.csrf;
console.log('  login: ok');

const t = await fetch(`${BASE}/api/ws/ticket`, {
  method: 'POST',
  headers: { ...H(), 'X-CSRF-Token': csrf },
  body: JSON.stringify({ channel: 'events' }),
});
const tJson = await t.json();
if (!tJson.ok) { console.error('  ticket failed', tJson); process.exit(1); }
const ticket = tJson.data.ticket;
console.log('  ticket: ok');

// unauthenticated connection must be rejected
await new Promise((resolve) => {
  const bad = new WebSocket(`${WS_BASE}/ws?ticket=invalid`);
  bad.onopen = () => { console.error('  FAIL: bogus ticket was accepted'); process.exit(1); };
  bad.onerror = () => { console.log('  bogus ticket rejected: ok'); resolve(); };
  bad.onclose = () => { console.log('  bogus ticket rejected: ok'); resolve(); };
});

// valid ticket must yield a "hello" frame
await new Promise((resolve, reject) => {
  const ws = new WebSocket(`${WS_BASE}/ws?ticket=${encodeURIComponent(ticket)}&channel=events`);
  const timer = setTimeout(() => reject(new Error('  FAIL: no hello frame within 8s')), 8000);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    clearTimeout(timer);
    if (msg.event === 'hello') { console.log('  hello frame received: ok'); ws.close(); resolve(); }
    else reject(new Error('  FAIL: unexpected frame ' + ev.data));
  };
  ws.onerror = () => { clearTimeout(timer); reject(new Error('  FAIL: ws error')); };
});

console.log('WEBSOCKET: all checks passed');
