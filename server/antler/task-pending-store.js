// Persist worker tasks awaiting boss clarification (P2 resume after needs_input).

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');

const pendingByThread = new Map();
let saveTimer = null;

function storePath() {
  return path.join(store.getDataDir(), 'task-pending.json');
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
  return String(threadId || '').trim();
}

function get(threadId) {
  const k = key(threadId);
  return k ? pendingByThread.get(k) || null : null;
}

function set(threadId, data) {
  const k = key(threadId);
  if (!k) return null;
  pendingByThread.set(k, { ...data, updatedAt: Date.now() });
  scheduleSave();
  return pendingByThread.get(k);
}

function clear(threadId) {
  const k = key(threadId);
  if (!k) return;
  pendingByThread.delete(k);
  scheduleSave();
}

function listAll() {
  return [...pendingByThread.entries()].map(([threadId, data]) => ({ threadId, ...(data || {}) }));
}

module.exports = { get, set, clear, listAll, loadFromDisk };
