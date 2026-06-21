// Apply OpenClaw gateway permissions for hired office workers (exec.approvals + tools).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const openclaw = require('./openclaw-config');
const registry = require('./registry-store');

const WORKER_EXEC_POLICY = {
  security: 'full',
  ask: 'on-miss',
  askFallback: 'deny',
  autoAllowSkills: true,
  allowlist: [],
};

function execApprovalsPath() {
  return path.join(os.homedir(), '.openclaw', 'exec-approvals.json');
}

function readExecApprovalsFile() {
  const p = execApprovalsPath();
  try {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return {
        version: data.version || 1,
        defaults: data.defaults || {},
        agents: data.agents && typeof data.agents === 'object' ? data.agents : {},
      };
    }
  } catch {
    /* new file */
  }
  return { version: 1, defaults: {}, agents: {} };
}

function writeExecApprovalsFile(file) {
  const p = execApprovalsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(file, null, 2), 'utf8');
}

function seedExecApprovals(openclawAgentId) {
  const id = String(openclawAgentId || '').trim();
  if (!id || id === 'main') return { ok: false, error: 'invalid agent id' };
  const file = readExecApprovalsFile();
  file.agents = file.agents || {};
  file.agents[id] = { ...WORKER_EXEC_POLICY, ...(file.agents[id] || {}) };
  file.agents[id].security = 'full';
  try {
    writeExecApprovalsFile(file);
    return { ok: true, agentId: id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function applyWorkerPermissions(openclawAgentId) {
  const id = String(openclawAgentId || '').trim();
  if (!id) return { ok: false, error: 'missing openclawAgentId' };

  const exec = seedExecApprovals(id);
  let toolsOk = true;
  let toolsError;

  if (await openclaw.isAvailable()) {
    const { config } = await openclaw.getConfig();
    const list = Array.isArray(config?.agents?.list) ? [...config.agents.list] : [];
    const idx = list.findIndex((a) => a && (a.id === id || a.agentId === id));
    const toolsPatch = { profile: 'full' };
    if (idx >= 0) {
      list[idx] = { ...list[idx], tools: { ...(list[idx].tools || {}), ...toolsPatch } };
    } else {
      list.push({ id, tools: toolsPatch });
    }
    const r = await openclaw.setConfig('agents.list', list);
    toolsOk = r.ok;
    toolsError = r.error;
  }

  return {
    ok: exec.ok && toolsOk,
    openclawAgentId: id,
    exec,
    tools: { ok: toolsOk, error: toolsError },
  };
}

async function applyAllHiredWorkerPermissions() {
  const agents = registry.listAgents().filter((a) => a.openclawAgentId && a.runtime === 'openclaw');
  const results = [];
  for (const a of agents) {
    results.push({ agentId: a.id, name: a.name, ...(await applyWorkerPermissions(a.openclawAgentId)) });
  }
  return { ok: true, count: results.length, results };
}

function resolveHireModel({ role, modelOverride } = {}) {
  if (modelOverride && String(modelOverride).trim()) return String(modelOverride).trim();
  const store = require('./store');
  const s = store.readSettings();
  const officeModels = s.office?.models || {};
  const normalized = String(role || '').trim();
  if (normalized === 'coo' || normalized === 'ceo') {
    return officeModels.cooModel || officeModels.ceoModel || '';
  }
  return officeModels.workerModel || '';
}

module.exports = {
  applyWorkerPermissions,
  applyAllHiredWorkerPermissions,
  seedExecApprovals,
  resolveHireModel,
  WORKER_EXEC_POLICY,
};
