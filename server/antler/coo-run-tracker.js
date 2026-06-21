// Tracks in-flight COO pipeline runs so heartbeat can continue other work while one thread awaits CEO.

const activeRuns = new Map(); // threadId -> { startedAt, shortTask }

function start(threadId, meta = {}) {
  const key = String(threadId || 'default');
  activeRuns.set(key, { startedAt: Date.now(), ...meta });
}

function end(threadId) {
  activeRuns.delete(String(threadId || 'default'));
}

function isActive() {
  return activeRuns.size > 0;
}

function listActive() {
  return [...activeRuns.entries()].map(([threadId, meta]) => ({ threadId, ...meta }));
}

module.exports = {
  start,
  end,
  isActive,
  listActive,
};
