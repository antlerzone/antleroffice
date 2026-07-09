// Resolve office dev team: writer + reviewers from settings + hired IT NPCs.

const store = require('../store');
const registry = require('../registry-store');

const DEV_TEMPLATE_IDS = new Set([
  'cursor_developer',
  'claude_developer',
  'codex_developer',
  'it_guys',
  'it_allrounder',
  'it_reviewer',
  'cto',
  'it_engineer_dept',
  'it_reviewer_dept',
  'cto_dept',
]);

const DEV_ENGINES = new Set(['cursor', 'claude', 'codex']);

// Leads (e.g. CTO) deploy & advise; they are not auto-assigned as routine code reviewers.
const LEAD_TEMPLATE_IDS = new Set(['cto']);

const TEMPLATE_ENGINE = {
  cursor_developer: 'cursor',
  claude_developer: 'claude',
  codex_developer: 'codex',
  it_guys: 'cursor',
};

function normalizeDevScope(scope) {
  const s = scope && typeof scope === 'object' ? scope : {};
  return {
    canWrite: s.canWrite !== false,
    canReview: s.canReview !== false,
  };
}

function engineForTemplate(templateId) {
  return TEMPLATE_ENGINE[templateId] || null;
}

function isDevTemplate(templateId) {
  return DEV_TEMPLATE_IDS.has(templateId);
}

function isDevAgent(agent) {
  if (!agent) return false;
  if (agent.devEngine && DEV_ENGINES.has(agent.devEngine)) return true;
  if (isDevTemplate(agent.templateId)) return true;
  return agent.role === 'it';
}

function resolveAgentEngine(agent) {
  if (agent?.devEngine && DEV_ENGINES.has(agent.devEngine)) return agent.devEngine;
  const fromTpl = engineForTemplate(agent?.templateId);
  if (fromTpl) return fromTpl;
  if (agent?.templateId === 'it_guys' || agent?.role === 'it') return 'cursor';
  return null;
}

function listDevAgents() {
  return registry.listAgents().filter(isDevAgent).map((a) => ({
    id: a.id,
    name: a.name,
    templateId: a.templateId,
    role: a.role,
    devEngine: resolveAgentEngine(a),
    devScope: normalizeDevScope(a.devScope),
    isLead: LEAD_TEMPLATE_IDS.has(a.templateId) || a.isLead === true,
  }));
}

function getDevTeamSettings() {
  const dev = store.readSettings().dev || {};
  return {
    writerAgentId: dev.devTeam?.writerAgentId || null,
    reviewerAgentIds: Array.isArray(dev.devTeam?.reviewerAgentIds)
      ? dev.devTeam.reviewerAgentIds.filter(Boolean)
      : [],
  };
}

function validateDevTeam({ writerAgentId, reviewerAgentIds }) {
  const devAgents = listDevAgents();
  const byId = new Map(devAgents.map((a) => [a.id, a]));
  const errors = [];

  const writer = writerAgentId ? byId.get(writerAgentId) : null;
  if (!writerAgentId) {
    errors.push('Writer not configured');
  } else if (!writer) {
    errors.push('Writer agent not found');
  } else if (!writer.devScope.canWrite) {
    errors.push(`${writer.name} is not allowed to write code`);
  }

  const reviewers = [];
  const seenReviewer = new Set();

  // The writer self-reviews FIRST (first pass) whenever it has review scope.
  // This makes the IT Engineer a write+review developer; extra reviewers run after.
  if (writer && writer.devScope.canReview) {
    reviewers.push(writer);
    seenReviewer.add(writer.id);
  }

  // Additional reviewers (e.g. the junior-manager checker/tester) run as later passes.
  for (const id of reviewerAgentIds || []) {
    if (seenReviewer.has(id)) continue; // writer already self-reviews — skip duplicate
    const r = byId.get(id);
    if (!r) {
      errors.push(`Reviewer ${id} not found`);
      continue;
    }
    if (!r.devScope.canReview) {
      errors.push(`${r.name} is not allowed to review code`);
      continue;
    }
    reviewers.push(r);
    seenReviewer.add(id);
  }

  const hiredCount = devAgents.length;
  if (reviewers.length === 0 && hiredCount > 0) {
    errors.push('At least one reviewer is required: hire an IT Engineer with review scope (self-review) or add a reviewer.');
  }

  return { ok: errors.length === 0, errors, writer, reviewers, devAgents };
}

function resolveDevTeam(overrides = {}) {
  const settings = getDevTeamSettings();
  const devAgents = listDevAgents();

  let writerAgentId = overrides.writerAgentId ?? settings.writerAgentId;
  let reviewerAgentIds = overrides.reviewerAgentIds ?? settings.reviewerAgentIds;

  // Auto-pick the writer when not configured: first non-lead agent that can write.
  if (!writerAgentId) {
    const firstWriter =
      devAgents.find((a) => a.devScope.canWrite && !a.isLead) ||
      devAgents.find((a) => a.devScope.canWrite);
    if (firstWriter) writerAgentId = firstWriter.id;
  }

  // Auto-pick reviewers when not configured: every OTHER hired non-lead agent that
  // can review (e.g. the junior-manager checker/tester). The writer self-reviews on
  // its own as the first pass, and leads (CTO) deploy rather than routinely review.
  if (!reviewerAgentIds || reviewerAgentIds.length === 0) {
    reviewerAgentIds = devAgents
      .filter((a) => a.id !== writerAgentId && a.devScope.canReview && !a.isLead)
      .map((a) => a.id);
  }

  return validateDevTeam({ writerAgentId, reviewerAgentIds });
}

function officeAgentFromRegistry(agentId) {
  const office = require('../office-state');
  const reg = registry.getAgent(agentId);
  if (!reg) return null;
  const orgRoles = require('../org-roles');
  const officeId = orgRoles.isCooRole(reg.role) ? null : `user:${reg.id}`;
  if (officeId) {
    const oa = office.getAgent(officeId);
    if (oa) {
      return {
        ...oa,
        devEngine: resolveAgentEngine(reg),
        devScope: normalizeDevScope(reg.devScope),
        registryId: reg.id,
        templateId: reg.templateId,
      };
    }
  }
  return {
    id: officeId || `user:${reg.id}`,
    label: reg.name,
    role: reg.role,
    devEngine: resolveAgentEngine(reg),
    devScope: normalizeDevScope(reg.devScope),
    registryId: reg.id,
    templateId: reg.templateId,
  };
}

function resolveOfficeDevTeam(overrides = {}) {
  const resolved = resolveDevTeam(overrides);
  if (!resolved.ok) return resolved;
  return {
    ...resolved,
    writerOffice: resolved.writer ? officeAgentFromRegistry(resolved.writer.id) : null,
    reviewerOffices: (resolved.reviewers || []).map((r) => officeAgentFromRegistry(r.id)),
  };
}

module.exports = {
  DEV_TEMPLATE_IDS,
  DEV_ENGINES,
  TEMPLATE_ENGINE,
  engineForTemplate,
  isDevTemplate,
  isDevAgent,
  resolveAgentEngine,
  normalizeDevScope,
  listDevAgents,
  getDevTeamSettings,
  validateDevTeam,
  resolveDevTeam,
  resolveOfficeDevTeam,
  officeAgentFromRegistry,
};
