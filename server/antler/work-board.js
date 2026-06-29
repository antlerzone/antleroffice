// Work board helpers — CEO Inbox cards and COO planning lifecycle on deliverables index.

const registry = require('./registry-store');
const ceoPending = require('./ceo-pipeline-pending');

const CEO_DECISION_PHASE_LABELS = {
  plan_approval: 'Plan approval',
  push_approval: 'Push approval',
  it_scan_ceo_gate: 'IT security scan',
  project_path: 'Project path',
  needs_input: 'COO needs input',
};

function findByThread(threadId, kinds = null) {
  const tid = String(threadId || '').trim();
  if (!tid) return null;
  const allowed = kinds ? new Set(kinds) : null;
  return (
    registry.listDeliverables().find((d) => {
      if (d.threadId !== tid) return false;
      if (allowed && !allowed.has(d.kind)) return false;
      return d.status !== 'complete';
    }) || null
  );
}

function findCeoDecisionCard(threadId) {
  const tid = String(threadId || '').trim();
  if (!tid) return null;
  return (
    registry.listDeliverables().find(
      (d) => d.kind === 'ceo_decision' && d.threadId === tid && d.status !== 'complete',
    ) || null
  );
}

function clip(text, max = 100) {
  const s = String(text || '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function emitDeliverablesUpdate() {
  try {
    require('./office-events').emit('deliverables', { at: Date.now() });
  } catch {
    /* optional */
  }
}

function createCeoInboxCard({ task, threadId, shortTask, ownerKey } = {}) {
  const tid = String(threadId || '').trim();
  const existing = findByThread(tid, ['ceo_inbox', 'coo_planning']);
  if (existing) return existing;

  return registry.addDeliverable({
    kind: 'ceo_inbox',
    status: 'pending',
    task: task || shortTask || '',
    summary: `CEO instruction: ${clip(shortTask || task || 'New task')}`,
    departmentLabel: 'CEO Inbox',
    agentLabel: 'Secretary',
    threadId: tid || null,
    ownerKey: ownerKey || null,
  });
}

function markCooPlanning(threadId) {
  const item = findByThread(threadId, ['ceo_inbox', 'coo_planning']);
  if (!item) return null;
  return registry.updateDeliverableProgress(item.id, {
    kind: 'coo_planning',
    status: 'in_progress',
    summary: item.summary.replace(/^CEO instruction:/, 'COO planning:'),
    departmentLabel: 'COO',
    agentLabel: 'COO',
  });
}

function markPlanAwaitingApproval(threadId) {
  let item = findByThread(threadId, ['ceo_inbox', 'coo_planning', 'plan_complete']);
  if (!item) {
    item = createCeoInboxCard({ threadId, task: '', shortTask: 'Plan approval' });
  }
  return registry.updateDeliverableProgress(item.id, {
    kind: 'plan_complete',
    status: 'pending',
    summary: item.summary.replace(/^CEO instruction:/, 'Plan awaiting CEO:').replace(/^COO planning:/, 'Plan awaiting CEO:'),
    departmentLabel: 'COO',
  });
}

function upsertCeoDecisionCard({ threadId, phase, shortTask, rawTask, ownerKey } = {}) {
  const tid = String(threadId || '').trim();
  if (!tid) return null;

  const phaseLabel = CEO_DECISION_PHASE_LABELS[phase] || String(phase || 'Decision');
  const summary = `${phaseLabel}: ${clip(shortTask || rawTask || 'Decision needed')}`;

  const planCard = findByThread(tid, ['plan_complete']);
  if (planCard && planCard.status === 'pending') {
    registry.updateDeliverableProgress(planCard.id, {
      status: 'complete',
      summary: `${planCard.summary} → moved to CEO decision`,
    });
  }

  let item = findCeoDecisionCard(tid);
  if (item) {
    item = registry.updateDeliverableProgress(item.id, {
      kind: 'ceo_decision',
      status: 'pending',
      summary,
      task: rawTask || shortTask || item.task || '',
      departmentLabel: 'Pending CEO Decision',
      agentLabel: 'COO',
      ceoDecisionPhase: phase || item.ceoDecisionPhase || null,
      ceoNotifiedAt: Date.now(),
      ceoAcknowledged: false,
      ceoAcknowledgedAt: null,
    });
  } else {
    item = registry.addDeliverable({
      kind: 'ceo_decision',
      status: 'pending',
      task: rawTask || shortTask || '',
      summary,
      departmentLabel: 'Pending CEO Decision',
      agentLabel: 'COO',
      threadId: tid,
      ownerKey: ownerKey || null,
      ceoDecisionPhase: phase || null,
      ceoAcknowledged: false,
      ceoNotifiedAt: Date.now(),
    });
  }

  ceoPending.patch(tid, { boardDecisionId: item.id });
  emitDeliverablesUpdate();
  return item;
}

function markCeoDecisionAcknowledged({ threadId, deliverableId } = {}) {
  let item = null;
  if (deliverableId) {
    item = registry.listDeliverables().find((d) => d.id === deliverableId && d.kind === 'ceo_decision');
  } else if (threadId) {
    item = findCeoDecisionCard(threadId);
  }
  if (!item || item.status === 'complete') return null;
  const updated = registry.updateDeliverableProgress(item.id, {
    ceoAcknowledged: true,
    ceoAcknowledgedAt: Date.now(),
  });
  emitDeliverablesUpdate();
  return updated;
}

function completeCeoDecisionCard(threadId) {
  const item = findCeoDecisionCard(threadId);
  if (!item) return null;
  const updated = registry.updateDeliverableProgress(item.id, {
    status: 'complete',
    summary: `${item.summary} → CEO decided`,
  });
  emitDeliverablesUpdate();
  return updated;
}

function linkExecutionJob(threadId, jobDeliverableId) {
  const inbox = findByThread(threadId, ['ceo_inbox', 'coo_planning', 'plan_complete']);
  if (!inbox) return null;
  if (inbox.id === jobDeliverableId) return inbox;
  registry.updateDeliverableProgress(inbox.id, {
    status: 'complete',
    summary: `${inbox.summary} → execution`,
  });
  ceoPending.patch(threadId, { boardInboxId: inbox.id, deliverableId: jobDeliverableId });
  return inbox;
}

function syncPipelineGatesToBoard() {
  const synced = [];
  for (const pending of ceoPending.listAll()) {
    const tid = pending.threadId;
    if (!tid) continue;
    const card = upsertCeoDecisionCard({
      threadId: tid,
      phase: pending.phase,
      shortTask: pending.shortTask,
      rawTask: pending.rawTask || pending.instruction,
      ownerKey: pending.ownerKey,
    });
    if (card) synced.push(card.id);
  }
  return synced;
}

function findActiveTaskJob(threadId) {
  const tid = String(threadId || "").trim();
  if (!tid) return null;
  return (
    registry.listDeliverables().find(
      (d) =>
        d.kind === "job" &&
        d.threadId === tid &&
        d.status !== "complete" &&
        d.status !== "failed",
    ) || null
  );
}

function ensureTaskJob({ threadId, agentId, agentLabel, task, shortTask, ownerKey, departmentLabel } = {}) {
  const existing = findActiveTaskJob(threadId);
  if (existing) return existing;
  const item = registry.addDeliverable({
    kind: "job",
    status: "pending",
    threadId: threadId || null,
    agentId: agentId || null,
    agentLabel: agentLabel || "Agent",
    task: task || shortTask || "",
    summary: shortTask || clip(task || "Task", 100) || "Task",
    ownerKey: ownerKey || null,
    departmentLabel: departmentLabel || agentLabel || "Office",
  });
  emitDeliverablesUpdate();
  return item;
}

function markTaskInProgress(deliverableId) {
  const updated = registry.updateDeliverableProgress(deliverableId, { status: "in_progress" });
  emitDeliverablesUpdate();
  return updated;
}

module.exports = {
  createCeoInboxCard,
  markCooPlanning,
  markPlanAwaitingApproval,
  upsertCeoDecisionCard,
  markCeoDecisionAcknowledged,
  completeCeoDecisionCard,
  linkExecutionJob,
  syncPipelineGatesToBoard,
  findByThread,
  findCeoDecisionCard,
  CEO_DECISION_PHASE_LABELS,
  findActiveTaskJob,
  ensureTaskJob,
  markTaskInProgress,
};
