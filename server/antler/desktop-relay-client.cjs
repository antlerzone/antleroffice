const WebSocket = require('ws');
const auth = require('./auth');
const ecssync = require('./ecs-sync');

let registerWs = null;
let openclawWs = null;
let reconnectTimer = null;
let relayConnected = false;
let started = false;

function httpToWs(base) {
  return String(base || '').replace(/\/+$/, '').replace(/^http/i, 'ws');
}

function registerUrl(ecsToken) {
  const base = auth.ecsBaseUrl();
  if (!base || !ecsToken) return null;
  const desktopId = ecssync.desktopId();
  return `${httpToWs(base)}/relay/desktop/register?desktopId=${encodeURIComponent(desktopId)}`;
}

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

function resolveLocalOpenClawToken() {
  const envToken = String(process.env.OPENCLAW_AUTH_TOKEN || '').trim();
  const placeholders = new Set(['1212', 'changeme', 'token', 'test']);
  const fileToken = readGatewayTokenFromFile();
  if (fileToken && (!envToken || placeholders.has(envToken.toLowerCase()))) return fileToken;
  return envToken || process.env.OPENCLAW_AUTH_PASSWORD || '';
}

function localOpenClawUrl() {
  const raw = process.env.OPENCLAW_WS_URL || 'ws://127.0.0.1:18789';
  const token = resolveLocalOpenClawToken();
  if (!token) return raw;
  return `${raw}${raw.includes('?') ? '&' : '?'}auth=${encodeURIComponent(token)}`;
}

function getPublicGatewayUrl() {
  if (!relayConnected) return null;
  const base = auth.ecsBaseUrl();
  if (!base) return null;
  const desktopId = ecssync.desktopId();
  return `${httpToWs(base)}/relay/desktop/${encodeURIComponent(desktopId)}/gateway`;
}

function pipeSockets(a, b) {
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

function connectOpenClawBridge() {
  if (openclawWs) {
    try { openclawWs.close(); } catch { /* */ }
    openclawWs = null;
  }
  const target = localOpenClawUrl();
  openclawWs = new WebSocket(target);
  openclawWs.on('open', () => {
    console.log('[Relay] Bridged to local OpenClaw');
    if (registerWs?.readyState === WebSocket.OPEN) pipeSockets(registerWs, openclawWs);
  });
  openclawWs.on('error', (err) => {
    console.log('[Relay] OpenClaw bridge error:', err.message);
  });
  openclawWs.on('close', () => {
    openclawWs = null;
    if (registerWs?.readyState === WebSocket.OPEN) connectOpenClawBridge();
  });
}

function disconnect() {
  started = false;
  relayConnected = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (openclawWs) {
    try { openclawWs.close(); } catch { /* */ }
    openclawWs = null;
  }
  if (registerWs) {
    try { registerWs.close(); } catch { /* */ }
    registerWs = null;
  }
}

function scheduleReconnect(ecsToken, delayMs = 5000) {
  if (!started) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(ecsToken), delayMs);
}

function connect(ecsToken) {
  const url = registerUrl(ecsToken);
  if (!url) return { ok: false, error: 'ECS not configured' };

  if (registerWs) {
    try { registerWs.close(); } catch { /* */ }
    registerWs = null;
  }
  started = true;
  relayConnected = false;

  let fatal = false;
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${ecsToken}` },
  });
  registerWs = ws;

  ws.on('open', () => {
    relayConnected = true;
    console.log('[Relay] Registered with ECS for desktop', ecssync.desktopId());
    connectOpenClawBridge();
  });

  ws.on('close', () => {
    relayConnected = false;
    registerWs = null;
    if (openclawWs) {
      try { openclawWs.close(); } catch { /* */ }
      openclawWs = null;
    }
    // 404/401/403 这类「端点不存在/没权限」的错误，重连也没用，停掉别刷屏（不影响本地语音）。
    if (started && !fatal) scheduleReconnect(ecsToken);
    if (fatal) started = false;
  });

  ws.on('error', (err) => {
    const msg = String((err && err.message) || '');
    if (/Unexpected server response: 4\d\d/.test(msg)) {
      fatal = true;
      console.log(`[Relay] 远程中转端点不可用(${msg})，已停止重连。本地语音/COO 不受影响。`);
    } else {
      console.log('[Relay] Connection error:', msg);
    }
    relayConnected = false;
  });

  return { ok: true };
}

function startFromBossSession(session) {
  const token = session?.ecsAccessToken;
  if (!token || !auth.ecsBaseUrl()) return;
  connect(token);
}

function stop() {
  disconnect();
}

module.exports = {
  connect,
  startFromBossSession,
  stop,
  getPublicGatewayUrl,
  isRelayConnected: () => relayConnected,
};
