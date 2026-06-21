// Serializes dev-pipeline runs per git project root (same repo → queue, different repos → parallel).

const queues = new Map();

function normalizeRoot(projectRoot) {
  return String(projectRoot || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function runExclusive(projectRoot, fn) {
  const key = normalizeRoot(projectRoot);
  if (!key) return Promise.resolve(fn());

  return new Promise((resolve, reject) => {
    const execute = () => {
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          const q = queues.get(key);
          if (!q) return;
          q.running = false;
          const next = q.waiters.shift();
          if (next) {
            q.running = true;
            next();
          } else {
            queues.delete(key);
          }
        });
    };

    let q = queues.get(key);
    if (!q) {
      q = { running: true, waiters: [] };
      queues.set(key, q);
      execute();
      return;
    }

    q.waiters.push(execute);
  });
}

function getQueueStatus() {
  const active = [];
  for (const [projectRoot, q] of queues.entries()) {
    active.push({
      projectRoot,
      running: q.running,
      waiting: q.waiters.length,
    });
  }
  return active;
}

module.exports = {
  runExclusive,
  getQueueStatus,
  normalizeRoot,
};
