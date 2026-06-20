// Pending CEO / dev pipeline state (plan approval, push approval, project path).

const pendingByThread = new Map();

function key(threadId) {
  return String(threadId || 'default');
}

function get(threadId) {
  return pendingByThread.get(key(threadId)) || null;
}

function set(threadId, data) {
  pendingByThread.set(key(threadId), { ...data, updatedAt: Date.now() });
  return pendingByThread.get(key(threadId));
}

function patch(threadId, data) {
  const cur = get(threadId) || {};
  return set(threadId, { ...cur, ...data });
}

function clear(threadId) {
  pendingByThread.delete(key(threadId));
}

module.exports = { get, set, patch, clear };
