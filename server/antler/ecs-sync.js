// Mirror local office state to the ECS/website backend so the boss can view it
// from a phone/browser. This is a ONE-WAY read-only mirror: execution always
// stays on the local desktop; we only push a snapshot. No-op while sync is off
// or auth.baseUrl is empty, so it's safe by default.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const office = require('./office-state');
const registry = require('./registry-store');
const auth = require('./auth');

let timer = null;
const status = { enabled: false, target: '', lastPushAt: 0, lastOk: null, lastError: '', desktopId: '' };

// Stable per-machine id so the website can group desktops.
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

function buildPayload() {
  const snap = office.snapshot();
  const deliverables = registry.listDeliverables();
  return {
    desktopId: status.desktopId,
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

async function pushOnce() {
  const url = target();
  if (!url) {
    status.lastOk = null;
    status.lastError = 'no baseUrl';
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload()),
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

function refresh() {
  const s = store.readSettings();
  status.desktopId = desktopId();
  status.enabled = !!s.sync?.enabled;
  status.target = target();
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (status.enabled && status.target) {
    const ms = Math.max(5000, s.sync?.intervalMs || 30000);
    timer = setInterval(pushOnce, ms);
    timer.unref?.();
    pushOnce();
  }
}

function getStatus() {
  return { ...status };
}

module.exports = { refresh, pushOnce, getStatus, desktopId };
