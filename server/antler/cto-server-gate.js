// CTO server-access gate (SSH / ECS). Double-gated for safety:
//   Gate 1 (opt-in):   boss must enable SSH in Settings -> Dev tools (default OFF).
//   Gate 2 (per-act):  every server action still needs explicit boss approval.
//
// This module enforces the policy ONLY. It intentionally does NOT open a live
// SSH session yet — an approved action is recorded and handed back to the boss
// as a manual step. When a real executor is added later, plug it into
// fulfilServerAction(); the gates above it stay unchanged.

const store = require('./store');
const pending = require('./ceo-pipeline-pending');

// Roles whose template grants server scope at all (gate 0 = capability).
const SERVER_ROLE_TEMPLATES = new Set(['cto']);

function readServerAccess() {
  const dev = (store.readSettings() || {}).dev || {};
  const sa = dev.serverAccess || {};
  return {
    sshEnabled: sa.sshEnabled === true,
    host: sa.host || '',
    user: sa.user || '',
    requireApprovalPerAction: sa.requireApprovalPerAction !== false,
  };
}

// Gate 1: has the boss turned SSH on?
function isEnabled() {
  return readServerAccess().sshEnabled === true;
}

// Gate 0: does this agent's ROLE grant server scope? (CTO only)
function agentHasServerScope(agent) {
  if (!agent) return false;
  if (SERVER_ROLE_TEMPLATES.has(agent.templateId)) return true;
  const sa = agent.serverAccess;
  if (sa && (sa.enabled === true || sa.scope)) return true;
  return false;
}

// Top-level guard combining gate 0 + gate 1. Returns { ok, code?, reason? }.
function checkAccess(agent) {
  if (!agentHasServerScope(agent)) {
    return {
      ok: false,
      code: 'NOT_CTO',
      reason:
        'Only the CTO can access the server. The IT Engineer and Reviewer work locally and hold no server keys.',
    };
  }
  if (!isEnabled()) {
    return {
      ok: false,
      code: 'SSH_DISABLED',
      reason:
        'Server access is off. The boss must enable SSH in Settings -> Dev tools before the CTO can connect (gate 1).',
    };
  }
  return { ok: true };
}

// Gate 2: stage a server action for boss approval. Never executes here.
function requestServerAction({ agent, action, command, threadId, summary } = {}) {
  const access = checkAccess(agent);
  if (!access.ok) return { status: 'denied', ...access };

  const sa = readServerAccess();
  const serverAction = {
    action: action || 'run',
    command: String(command || ''),
    host: sa.host || '',
    user: sa.user || '',
    agentId: (agent && (agent.id || agent.registryId)) || null,
    agentLabel: (agent && (agent.label || agent.name)) || 'CTO',
    summary: summary || '',
    requestedAt: Date.now(),
    approved: false,
  };
  pending.set(threadId, { phase: 'server_action_approval', serverAction });

  return {
    status: 'awaiting_approval',
    message:
      `CTO wants to run on the server (${sa.host || 'ECS'}):\n  ${serverAction.command}\n` +
      'Nothing runs until the boss replies APPROVED (gate 2).',
    pending: serverAction,
  };
}

// Called after the boss approves. In gates-only scope we do NOT open a live SSH
// session — we re-check gate 1, mark approved, and return a manual-step result.
function fulfilServerAction({ threadId } = {}) {
  const cur = pending.get(threadId);
  if (!cur || cur.phase !== 'server_action_approval' || !cur.serverAction) {
    return { ok: false, reason: 'No server action awaiting approval on this thread.' };
  }
  // Re-check gate 1 at execution time in case the boss disabled SSH meanwhile.
  const access = checkAccess({ templateId: 'cto' });
  if (!access.ok) return { ok: false, ...access };

  const act = { ...cur.serverAction, approved: true, approvedAt: Date.now() };
  pending.clear(threadId);

  return {
    ok: true,
    executed: false, // live SSH not wired in this build (gates-only scope)
    manual: true,
    command: act.command,
    host: act.host,
    user: act.user,
    message:
      'Approved. Live SSH execution is not enabled in this build — run it manually:\n' +
      `  ssh ${act.user ? act.user + '@' : ''}${act.host || '<host>'}\n  ${act.command}`,
  };
}

module.exports = {
  SERVER_ROLE_TEMPLATES,
  readServerAccess,
  isEnabled,
  agentHasServerScope,
  checkAccess,
  requestServerAction,
  fulfilServerAction,
};
