// Inbound direct-connect gateway (Phase 2 / A1).
//
// Lets a friend (viewer) connect DIRECTLY to this desktop — data does NOT go
// through ECS. ECS is only an occasional "phonebook":
//   - Each share has a unique access_token (issued by ECS in Phase 1).
//   - This module keeps a LOCAL allowlist of valid tokens, refreshed every 30s
//     from ECS GET /api/desktops/<id>/shares.
//   - A friend connects to  ws://<your-public-host>:<port>?token=<theirToken>.
//   - We validate the token against the LOCAL allowlist (no per-connection ECS
//     call), then pipe the socket to the local OpenClaw gateway.
//   - When you delete the friend on the website, ECS drops the token; on the
//     next 30s refresh this desktop drops that live session.
//
// Requires the desktop to be publicly reachable (port-forward + public IP, or a
// tunnel). Configure via settings: gatewayPublicHost + gatewayPublicPort, or
// env ANTLER_GATEWAY_PUBLIC_HOST / ANTLER_GATEWAY_PORT.

const http = require('http');
const { URL } = require('url');
const WebSocket = require('ws');
const auth = require('./auth');
const ecssync = require('./ecs-sync');
const store = require('./store');

let httpServer = null;
let wss = null;
let syncTimer = null;
let allow = new Map(); // token -> { email }
const sessions = new Set(); // { ws, token }

function readGatewayTokenFromFile() {
  try {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openclaw', 'openclaw.json'), 'utf8'));
    const token = cfg?.gateway?.auth?.token;
    return typeof token === 'string' ? token.trim() : '';
  } catch {
    return '';
  }
}

function localOpenClawUrl() {
  const raw = process.env.OPENCLAW_WS_URL || 'ws://127.0.0.1:18789';
  const envToken = String(process.env.OPENCLAW_AUTH_TOKEN || '').trim();
  const placeholders = new Set(['1212', 'changeme', 'token', 'test']);
  const fileToken = readGatewayTokenFromFile();
  const token =
    fileToken && (!envToken || placeholders.has(envToken.toLowerCase()))
      ? fileToken
      : envToken || process.env.OPENCLAW_AUTH_PASSWORD || '';
  if (!token) return raw;
  return `${raw}${raw.includes('?') ? '&' : '?'}auth=${encodeURIComponent(token)}`;
}

function listenPort() {
  const s = store.readSettings();
  return Number(process.env.ANTLER_GATEWAY_PORT || s.gatewayPublicPort || 0) || 0;
}

function publicHost() {
  const s = store.readSettings();
  return String(process.env.ANTLER_GATEWAY_PUBLIC_HOST || s.gatewayPublicHost || '').trim();
}

// The URL to report to ECS so a friend can connect directly.
function publicGatewayUrl() {
  const host = publicHost();
  const port = listenPort();
  if (!host || !port) return '';
  return `ws://${host}:${port}`;
}

async function fetchShares() {
  const base = auth.ecsBaseUrl();
  const s = store.readSettings();
  const ecsToken = s._lastEcsAccessToken;
  const desktopId = ecssync.desktopId();
  if (!base || !ecsToken || !desktopId) return null;
  try {
    const res = await fetch(`${base}/api/desktops/${encodeURIComponent(desktopId)}/shares`, {
      headers: { Authorization: `Bearer ${ecsToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data.shares) ? data.shares : [];
  } catch {
    return null;
  }
}

async function refreshAllowlist() {
  const shares = await fetchShares();
  if (!shares) return; // keep the last known list on transient failure
  const next = new Map();
  for (const sh of shares) {
    if (sh.accessToken) next.set(String(sh.accessToken), { email: sh.invitedEmail });
  }
  allow = next;
  // Enforce revocation: drop live sessions whose token is gone.
  for (const sess of [...sessions]) {
    if (!allow.has(sess.token)) {
      try { sess.ws.close(4403, 'access revoked'); } catch { /* */ }
      sessions.delete(sess);
    }
  }
}

function pipe(a, b) {
  const cleanup = [];
  const attach = (from, to) => {
    const fn = (data, isBinary) => {
      if (to.readyState === WebSocket.OPEN) to.send(data, { binary: isBinary });
    };
    from.on('message', fn);
    cleanup.push(() => from.removeListener('message', fn));
  };
  attach(a, b);
  attach(b, a);
  const onDone = () => {
    cleanup.forEach((f) => f());
    try { if (b.readyState === WebSocket.OPEN) b.close(); } catch { /* */ }
  };
  a.once('close', onDone);
  a.once('error', onDone);
}

function handleConnection(ws, req) {
  let token = '';
  try {
    const u = new URL(req.url, 'http://x');
    token = String(u.searchParams.get('token') || '').trim();
  } catch { /* */ }

  if (!token || !allow.has(token)) {
    try { ws.close(4401, 'invalid or revoked token'); } catch { /* */ }
    return;
  }

  const sess = { ws, token };
  sessions.add(sess);

  const upstream = new WebSocket(localOpenClawUrl());
  upstream.on('open', () => pipe(ws, upstream));
  upstream.on('error', () => { try { ws.close(1011, 'upstream error'); } catch { /* */ } });

  const done = () => {
    sessions.delete(sess);
    try { if (upstream.readyState === WebSocket.OPEN) upstream.close(); } catch { /* */ }
  };
  ws.once('close', done);
  ws.once('error', done);
}

function start() {
  const port = listenPort();
  if (!port) {
    console.log('[InboundGW] gatewayPublicPort not set — direct-connect sharing disabled.');
    return { ok: false, reason: 'no-port' };
  }
  if (httpServer) return { ok: true, alreadyRunning: true };

  httpServer = http.createServer();
  wss = new WebSocket.Server({ server: httpServer });
  wss.on('connection', handleConnection);
  httpServer.on('error', (e) => console.log('[InboundGW] listen error:', e.message));
  httpServer.listen(port, () => console.log('[InboundGW] listening on port', port, '→', publicGatewayUrl()));

  refreshAllowlist().catch(() => {});
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => refreshAllowlist().catch(() => {}), 30000);
  syncTimer.unref?.();
  return { ok: true };
}

function stop() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  for (const sess of [...sessions]) { try { sess.ws.close(); } catch { /* */ } }
  sessions.clear();
  if (wss) { try { wss.close(); } catch { /* */ } wss = null; }
  if (httpServer) { try { httpServer.close(); } catch { /* */ } httpServer = null; }
}

module.exports = { start, stop, publicGatewayUrl, refreshAllowlist };
