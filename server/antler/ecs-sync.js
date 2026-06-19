// On-demand ECS mirror: push snapshot only when website requests via /api/sync/pending.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const store = require('./store');
const office = require('./office-state');
const registry = require('./registry-store');
const auth = require('./auth');

let pollTimer = null;
const status = {
  enabled: false,
  target: '',
  lastPushAt: 0,
  lastOk: null,
  lastError: '',
  desktopId: '',
  mode: 'on-demand',
};

function desktopId() {
  const file = path.join(store.getDataDir(), 'desktop-id');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const id = 'desk-' + crypto.randomBytes(6).toString('hex');
    try {
      fs.writeFileSync(file, id, 'utf8');
    } catch {
      /* ignore */
    }
    return id;
  }
}

function target() {
  const base = auth.ecsBaseUrl();
  return base ? `${base}/sync/office` : '';
}

function ecsApi(pathname, ecsToken, init = {}) {
  const base = auth.ecsBaseUrl();
  if (!base || !ecsToken) return Promise.resolve(null);
  return fetch(`${base}${pathname}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${ecsToken}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(12000),
  }).catch(() => null);
}

function buildPayload(officeId) {
  const snap = office.snapshot();
  const deliverables = registry.listDeliverables();
  return {
    desktopId: status.desktopId,
    officeId: officeId || store.readSettings().selectedOfficeId || '',
    at: Date.now(),
    office: {
      agents: snap.agents.map((a) => ({
        id: a.id,
        label: a.label,
        role: a.role,
        npcState: a.npcState,
        external: !!a.external,
      })),
      working: snap.agents.filter((a) => a.npcState === 'working').length,
    },
    deliverables: deliverables.slice(0, 50).map((d) => ({
      id: d.id,
      agentLabel: d.agentLabel,
      task: d.task,
      createdAt: d.createdAt,
      forwarded: d.forwarded,
    })),
    stats: {
      agents: snap.agents.length,
      deliverables: deliverables.length,
    },
  };
}

async function pushOnce(officeId) {
  const url = target();
  if (!url) {
    status.lastOk = null;
    status.lastError = 'no baseUrl';
    return { ok: false, skipped: true };
  }
  const payload = buildPayload(officeId);
  if (!payload.officeId) {
    status.lastError = 'no officeId';
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    status.lastPushAt = Date.now();
    status.lastOk = res.ok;
    status.lastError = res.ok ? '' : `HTTP ${res.status}`;
    return { ok: res.ok };
  } catch (e) {
    status.lastPushAt = Date.now();
    status.lastOk = false;
    status.lastError = e.message;
    return { ok: false, error: e.message };
  }
}

async function pollSyncRequests() {
  const base = auth.ecsBaseUrl();
  if (!base) return;
  const s = store.readSettings();
  const ecsToken = s._lastEcsAccessToken;
  if (!ecsToken) return;

  const res = await ecsApi(`/api/sync/pending?desktopId=${encodeURIComponent(status.desktopId)}`, ecsToken);
  if (!res || !res.ok) return;
  const data = await res.json().catch(() => ({}));
  if (data.pending) {
    await pushOnce(s.selectedOfficeId);
  }
}

function refresh() {
  status.desktopId = desktopId();
  status.enabled = !!auth.ecsBaseUrl();
  status.target = target();
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (status.enabled) {
    pollTimer = setInterval(() => {
      pollSyncRequests().catch(() => {});
    }, 5000);
    pollTimer.unref?.();
  }
}

function rememberEcsToken(token) {
  if (!token) return;
  const s = store.readSettings();
  if (s._lastEcsAccessToken === token) return;
  store.writeSettings({ ...s, _lastEcsAccessToken: token });
}

function resetDesktopId() {
  const file = path.join(store.getDataDir(), 'desktop-id');
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
  status.desktopId = desktopId();
  return status.desktopId;
}

function getStatus() {
  return { ...status };
}

module.exports = { refresh, pushOnce, getStatus, desktopId, resetDesktopId, rememberEcsToken, pollSyncRequests };
