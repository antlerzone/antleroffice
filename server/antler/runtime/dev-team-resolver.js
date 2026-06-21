// Resolve office dev team: writer + reviewers from settings + hired IT NPCs.

const store = require('../store');
const registry = require('../registry-store');

const DEV_TEMPLATE_IDS = new Set([
  'cursor_developer',
  'claude_developer',
  'codex_developer',
  'it_guys',
]);

const DEV_ENGINES = new Set(['cursor', 'claude', 'codex']);

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
  for (const id of reviewerAgentIds || []) {
    if (writerAgentId && id === writerAgentId) {
      errors.push('Writer cannot also be a reviewer when multiple IT NPCs are hired');
      continue;
    }
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
  }

  const hiredCount = devAgents.length;
  if (hiredCount === 1 && writer && reviewers.length === 0 && writer.devScope.canReview) {
    reviewers.push(writer);
  } else if (reviewers.length === 0 && hiredCount > 0) {
    errors.push('At least one reviewer is required (or hire only one NPC with review scope for self-review)');
  }

  return { ok: errors.length === 0, errors, writer, reviewers, devAgents };
}

function resolveDevTeam(overrides = {}) {
  const settings = getDevTeamSettings();
  const writerAgentId = overrides.writerAgentId ?? settings.writerAgentId;
  let reviewerAgentIds = overrides.reviewerAgentIds ?? settings.reviewerAgentIds;

  const devAgents = listDevAgents();
  if (!writerAgentId && devAgents.length === 1) {
    const only = devAgents[0];
    if (only.devScope.canWrite) {
      return validateDevTeam({
        writerAgentId: only.id,
        reviewerAgentIds: only.devScope.canReview ? [] : reviewerAgentIds,
      });
    }
  }

  if (!writerAgentId && devAgents.length > 1) {
    const firstWriter = devAgents.find((a) => a.devScope.canWrite);
    if (firstWriter) {
      return validateDevTeam({
        writerAgentId: firstWriter.id,
        reviewerAgentIds,
      });
    }
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
