// Durable paygo state: carry ms, pending ECS charges, monotonic local totals (never decreases).

const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');

const MAX_PENDING = 500;

function storePath() {
  return path.join(getDataDir(), 'paygo-pending.json');
}

function emptyTotals() {
  return { totalDurationMs: 0, totalCreditsAccrued: 0 };
}

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    return {
      carryMsByAgent:
        raw.carryMsByAgent && typeof raw.carryMsByAgent === 'object' ? raw.carryMsByAgent : {},
      pendingCharges: Array.isArray(raw.pendingCharges) ? raw.pendingCharges : [],
      localTotalsByAgent:
        raw.localTotalsByAgent && typeof raw.localTotalsByAgent === 'object' ? raw.localTotalsByAgent : {},
    };
  } catch {
    return { carryMsByAgent: {}, pendingCharges: [], localTotalsByAgent: {} };
  }
}

function writeStore(data) {
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf8');
}

function getCarryMs(agentId) {
  const n = Number(readStore().carryMsByAgent[agentId]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function setCarryMs(agentId, ms) {
  const store = readStore();
  const n = Math.max(0, Math.floor(Number(ms) || 0));
  if (n > 0) store.carryMsByAgent[agentId] = n;
  else delete store.carryMsByAgent[agentId];
  writeStore(store);
}

function getLocalTotals(agentId) {
  const row = readStore().localTotalsByAgent[agentId];
  if (!row || typeof row !== 'object') return emptyTotals();
  return {
    totalDurationMs: Math.max(0, Math.floor(Number(row.totalDurationMs) || 0)),
    totalCreditsAccrued: Math.max(0, Math.floor(Number(row.totalCreditsAccrued) || 0)),
  };
}

/** Add usage locally — totals only ever increase. */
function addLocalUsage(agentId, { durationMs = 0, credits = 0 } = {}) {
  const store = readStore();
  const prev = store.localTotalsByAgent[agentId] || emptyTotals();
  const addMs = Math.max(0, Math.floor(Number(durationMs) || 0));
  const addCr = Math.max(0, Math.floor(Number(credits) || 0));
  store.localTotalsByAgent[agentId] = {
    totalDurationMs: prev.totalDurationMs + addMs,
    totalCreditsAccrued: prev.totalCreditsAccrued + addCr,
  };
  writeStore(store);
  return store.localTotalsByAgent[agentId];
}

function listLocalTotals() {
  return { ...readStore().localTotalsByAgent };
}

function enqueuePending(entry) {
  const store = readStore();
  const row = {
    id: `pq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
    attempts: 0,
    ...entry,
  };
  store.pendingCharges.unshift(row);
  if (store.pendingCharges.length > MAX_PENDING) store.pendingCharges.length = MAX_PENDING;
  writeStore(store);
  return row;
}

function listPending() {
  return readStore().pendingCharges;
}

function removePending(id) {
  const store = readStore();
  store.pendingCharges = store.pendingCharges.filter((r) => r.id !== id);
  writeStore(store);
}

function bumpPendingAttempt(id) {
  const store = readStore();
  const row = store.pendingCharges.find((r) => r.id === id);
  if (row) row.attempts = (row.attempts || 0) + 1;
  writeStore(store);
}

module.exports = {
  getCarryMs,
  setCarryMs,
  getLocalTotals,
  addLocalUsage,
  listLocalTotals,
  enqueuePending,
  listPending,
  removePending,
  bumpPendingAttempt,
};
