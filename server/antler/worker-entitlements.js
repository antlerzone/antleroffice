const path = require('node:path');
const fs = require('node:fs');
const auth = require('./auth');

let cache = null;
let cacheAt = 0;
const CACHE_MS = 60_000;

function localEntitlementsPath() {
  return path.join(__dirname, '..', '..', '..', 'server', 'data', 'worker-entitlements.json');
}

function loadLocal() {
  try {
    return JSON.parse(fs.readFileSync(localEntitlementsPath(), 'utf8'));
  } catch {
    return { workers: [], skills: {} };
  }
}

async function fetchFromEcs() {
  const base = auth.ecsBaseUrl();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/catalog/worker-entitlements`, {
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.workers) return data;
  } catch {
    /* fallback local */
  }
  return null;
}

async function loadEntitlements() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
  const remote = await fetchFromEcs();
  cache = remote || loadLocal();
  cacheAt = Date.now();
  return cache;
}

function getWorker(data, workerId) {
  return data.workers.find((w) => w.workerId === workerId) || null;
}

async function classifyTaskUsage({ homeWorkerId, skillIds = [], mcpIds = [] }) {
  const data = await loadEntitlements();
  const home = getWorker(data, homeWorkerId);
  if (!home) return { scope: 'home', reason: 'unknown_home_worker' };

  for (const skillId of skillIds) {
    const meta = data.skills[skillId];
    if (!meta) continue;
    if (meta.homeWorkerId === homeWorkerId) continue;
    if (meta.skillFamily && home.skillFamilies?.[meta.skillFamily]?.includes(skillId)) {
      continue;
    }
    const otWorker = getWorker(data, meta.homeWorkerId);
    return {
      scope: 'ot',
      reason: 'cross_worker_skill',
      otWorkerId: meta.homeWorkerId,
      otCreditsPerTask: otWorker?.otCreditsPerTask ?? 15,
    };
  }

  for (const mcpId of mcpIds) {
    const prefix = String(mcpId).split(':')[0];
    if (prefix && prefix !== homeWorkerId && prefix !== home.departmentId) {
      const otWorker = getWorker(data, prefix);
      return {
        scope: 'ot',
        reason: 'cross_worker_mcp',
        otWorkerId: prefix,
        otCreditsPerTask: otWorker?.otCreditsPerTask ?? 20,
      };
    }
  }

  return { scope: 'home', reason: 'in_scope' };
}

async function checkBindingWarnings({ homeWorkerId, skillIds = [], mcpIds = [] }) {
  const warnings = [];
  const combined = [...skillIds, ...mcpIds.map((m) => `mcp:${m}`)];
  for (const item of combined) {
    const isMcp = String(item).startsWith('mcp:');
    const classified = await classifyTaskUsage({
      homeWorkerId,
      skillIds: isMcp ? [] : [item],
      mcpIds: isMcp ? [String(item).slice(4)] : [],
    });
    if (classified.scope === 'ot') {
      warnings.push({ item, ...classified });
    }
  }
  return warnings;
}

module.exports = {
  loadEntitlements,
  classifyTaskUsage,
  checkBindingWarnings,
  getWorker: async (id) => getWorker(await loadEntitlements(), id),
};
