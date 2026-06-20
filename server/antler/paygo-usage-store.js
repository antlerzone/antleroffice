// Local pay-as-you-go usage log (~/.antleroffice2/paygo-usage.json).

const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');

const MAX_ENTRIES = 2000;

function usagePath() {
  return path.join(getDataDir(), 'paygo-usage.json');
}

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(usagePath(), 'utf8'));
    return Array.isArray(raw.entries) ? raw : { entries: [] };
  } catch {
    return { entries: [] };
  }
}

function writeStore(data) {
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(usagePath(), JSON.stringify(data, null, 2), 'utf8');
}

function recordPaygoUsage({
  agentId,
  agentName,
  templateId,
  subscriptionId,
  sessionKey,
  durationMs,
  credits,
  at = Date.now(),
} = {}) {
  const n = Number(credits);
  if (!Number.isFinite(n) || n <= 0) return null;
  const store = readStore();
  const row = {
    id: `pgo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    agentId: agentId || null,
    agentName: agentName || null,
    templateId: templateId || null,
    subscriptionId: subscriptionId || null,
    sessionKey: sessionKey || null,
    durationMs: Math.max(0, Math.floor(Number(durationMs) || 0)),
    credits: n,
    at,
  };
  store.entries.unshift(row);
  if (store.entries.length > MAX_ENTRIES) store.entries.length = MAX_ENTRIES;
  writeStore(store);
  return row;
}

function listPaygoUsage({ agentId, limit = 100 } = {}) {
  let rows = readStore().entries;
  if (agentId) rows = rows.filter((r) => r.agentId === agentId);
  return rows.slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
}

module.exports = {
  recordPaygoUsage,
  listPaygoUsage,
};
