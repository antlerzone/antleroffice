// Pending COO / dev pipeline state (plan approval, push approval, project path).
// Persisted to disk so server restarts can resume gates.

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');

const pendingByThread = new Map();
let saveTimer = null;

function storePath() {
  return path.join(store.getDataDir(), 'pipeline-pending.json');
}

function loadFromDisk() {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      pendingByThread.clear();
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object') pendingByThread.set(k, v);
      }
    }
  } catch {
    /* fresh */
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const obj = Object.fromEntries(pendingByThread.entries());
      fs.mkdirSync(path.dirname(storePath()), { recursive: true });
      fs.writeFileSync(storePath(), JSON.stringify(obj, null, 2), 'utf8');
    } catch {
      /* best-effort */
    }
  }, 200);
}

loadFromDisk();

function key(threadId) {
  return String(threadId || 'default');
}

function get(threadId) {
  return pendingByThread.get(key(threadId)) || null;
}

function set(threadId, data) {
  pendingByThread.set(key(threadId), { ...data, updatedAt: Date.now() });
  scheduleSave();
  return pendingByThread.get(key(threadId));
}

function patch(threadId, data) {
  const cur = get(threadId) || {};
  return set(threadId, { ...cur, ...data });
}

function clear(threadId) {
  pendingByThread.delete(key(threadId));
  scheduleSave();
}

function listAll() {
  return [...pendingByThread.entries()].map(([threadId, data]) => ({
    threadId,
    ...(data || {}),
  }));
}

module.exports = { get, set, patch, clear, loadFromDisk, listAll };
