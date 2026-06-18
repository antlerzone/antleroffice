// Local per-agent usage (~/.antleroffice2/agent-usage.json). Not synced to ECS.

const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');
const { formatPeriod, periodToRangeMs } = require('./period-sg.cjs');

function usagePath() {
  return path.join(getDataDir(), 'agent-usage.json');
}

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(usagePath(), 'utf8'));
    return raw?.agents && typeof raw.agents === 'object' ? raw : { agents: {} };
  } catch {
    return { agents: {} };
  }
}

function writeStore(data) {
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(usagePath(), JSON.stringify(data, null, 2), 'utf8');
}

function ensureAgentPeriod(store, agentId, period) {
  if (!store.agents[agentId]) store.agents[agentId] = { periods: {} };
  if (!store.agents[agentId].periods[period]) {
    store.agents[agentId].periods[period] = { homeTasks: 0, otTasks: 0, tokens: 0 };
  }
  return store.agents[agentId].periods[period];
}

function recordTaskRun({ agentId, scope, tokens = 0, at = Date.now() }) {
  if (!agentId) return null;
  const period = formatPeriod(at);
  const store = readStore();
  const bucket = ensureAgentPeriod(store, agentId, period);
  if (scope === 'ot') bucket.otTasks += 1;
  else bucket.homeTasks += 1;
  if (Number.isFinite(tokens) && tokens > 0) bucket.tokens += tokens;
  writeStore(store);
  return bucket;
}

function getAgentUsage(agentId, period) {
  const store = readStore();
  const p = period || formatPeriod();
  return store.agents[agentId]?.periods?.[p] || { homeTasks: 0, otTasks: 0, tokens: 0 };
}

function listAgentUsageForPeriod(period) {
  const store = readStore();
  const out = {};
  for (const [agentId, data] of Object.entries(store.agents || {})) {
    const bucket = data.periods?.[period];
    if (bucket) out[agentId] = { ...bucket };
  }
  return out;
}

module.exports = {
  recordTaskRun,
  getAgentUsage,
  listAgentUsageForPeriod,
  formatPeriod,
};
