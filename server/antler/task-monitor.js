// P2 task monitor ? watches deliverable job status changes and reports via COO.

const registry = require('./registry-store');
const orgRoles = require('./org-roles');
const workBoard = require('./work-board');
const taskPending = require('./task-pending-store');
const ceoDecisionNotify = require('./ceo-decision-notify');
const { TASK_STATUS, clip } = require('./task-status');

const COMPLETE_BATCH_MS = 3000;
const completionBuffer = [];
let flushTimer = null;

function emitDeliverablesUpdate() {
  try {
    require('./office-events').emit('deliverables', { at: Date.now() });
  } catch {
    /* optional */
  }
}

function cooLabel() {
  const coo = orgRoles.cooAgentOrFallback();
  return coo?.label || 'COO';
}

function postCooChat(threadId, text) {
  try {
    const office = require('./office-state');
    office.addChat('coo', text, threadId, { authorName: cooLabel() });
  } catch {
    /* optional */
  }
  try {
    const coo = orgRoles.cooAgentOrFallback();
    const bossChat = require('./boss-chat-store');
    const tid = bossChat.resolveThreadId(coo?.id, threadId, 'local:boss', 'Boss');
    if (tid) bossChat.addMessage(tid, coo?.id || 'coo', text, { authorName: cooLabel() });
  } catch {
    /* optional */
  }
}

function transition(deliverableId, nextStatus, meta = {}) {
  const id = String(deliverableId || '').trim();
  if (!id) return null;
  const prev = registry.getDeliverable(id);
  if (!prev) return null;
  const prevStatus = prev.status;
  if (prevStatus === nextStatus) return prev;

  const patch = { status: nextStatus };
  if (meta.question !== undefined) patch.taskQuestion = String(meta.question || '');
  if (meta.result !== undefined) patch.taskResult = String(meta.result || '');
  if (meta.error !== undefined) patch.taskError = String(meta.error || '');
  if (meta.summary) patch.summary = meta.summary;

  const updated = registry.updateDeliverableProgress(id, patch);
  emitDeliverablesUpdate();
  dispatchTransition(updated, prevStatus, nextStatus, meta);
  return updated;
}

function dispatchTransition(task, prevStatus, nextStatus, meta) {
  if (!task) return;
  if (nextStatus === TASK_STATUS.NEEDS_INPUT) {
    notifyNeedsInput(task, meta);
  } else if (nextStatus === TASK_STATUS.FAILED) {
    notifyFailure(task, meta);
  } else if (nextStatus === TASK_STATUS.COMPLETE) {
    queueCompletion(task, meta);
  }
}

function notifyNeedsInput(task, meta = {}) {
  const threadId = meta.threadId || task.threadId;
  const agent = meta.agent || {};
  const question = meta.question || task.taskQuestion || task.summary || '';
  const agentLabel = agent.label || task.agentLabel || 'Agent';

  if (meta.agent?.id && !orgRoles.isCooRole(meta.agent.role)) {
    taskPending.set(threadId, {
      phase: 'needs_input',
      deliverableId: task.id,
      agentId: meta.agent.id,
      instruction: meta.instruction || task.task || '',
      rawTask: meta.rawTask || task.task || '',
      shortTask: meta.shortTask || task.summary || '',
      partialText: question,
      ownerKey: meta.ownerKey || task.ownerKey || null,
    });
  }

  ceoDecisionNotify.notifyCeoDecisionRequired({
    threadId,
    phase: 'needs_input',
    shortTask: meta.shortTask || `${agentLabel} needs input`,
    rawTask: question,
    ownerKey: meta.ownerKey || task.ownerKey,
    chatPreview: String(question).slice(0, 400),
  });

  postCooChat(
    threadId,
    `**${cooLabel()}** ${agentLabel} needs your input:\n\n${clip(question, 800)}\n\nReply here and I'll pass it back ? work already done is kept.`,
  );
}

function notifyFailure(task, meta = {}) {
  const threadId = meta.threadId || task.threadId;
  const agentLabel = meta.agent?.label || task.agentLabel || 'Agent';
  const err = meta.error || task.taskError || 'Unknown error';
  postCooChat(threadId, `**${cooLabel()}** Task failed ? ${agentLabel}: ${clip(err, 500)}`);
}

function queueCompletion(task, meta = {}) {
  completionBuffer.push({ task, meta, at: Date.now() });
  if (!flushTimer) {
    flushTimer = setTimeout(flushCompletions, COMPLETE_BATCH_MS);
  }
}

function flushCompletions() {
  flushTimer = null;
  const batch = completionBuffer.splice(0);
  if (!batch.length) return;

  if (batch.length === 1) {
    const { task, meta } = batch[0];
    const agentLabel = meta.agent?.label || task.agentLabel || 'Agent';
    const result = clip(meta.result || task.taskResult || task.summary, 200);
    postCooChat(
      meta.threadId || task.threadId,
      `**${cooLabel()}** ${agentLabel} finished: ${result}`,
    );
    return;
  }

  const lines = [`**${cooLabel()}** ${batch.length} tasks completed:`];
  for (const { task, meta } of batch) {
    const agentLabel = meta.agent?.label || task.agentLabel || 'Agent';
    const result = clip(meta.result || task.taskResult || task.summary, 120);
    lines.push(`- ${agentLabel}: ${result}`);
  }
  const threadId = batch.find((b) => b.meta.threadId || b.task.threadId)?.meta.threadId ||
    batch[0].task.threadId ||
    null;
  postCooChat(threadId, lines.join('\n'));
}

function handleNeedsInput({ deliverableId, agent, threadId, question, instruction, rawTask, shortTask, ownerKey }) {
  return transition(deliverableId, TASK_STATUS.NEEDS_INPUT, {
    agent,
    threadId,
    question,
    instruction,
    rawTask,
    shortTask,
    ownerKey,
    summary: `${agent?.label || 'Agent'} awaiting input`,
  });
}

function handleComplete({ deliverableId, agent, threadId, result }) {
  taskPending.clear(threadId);
  try {
    workBoard.completeCeoDecisionCard(threadId);
  } catch {
    /* optional */
  }
  return transition(deliverableId, TASK_STATUS.COMPLETE, {
    agent,
    threadId,
    result,
    summary: `${agent?.label || 'Agent'} completed`,
  });
}

function handleFailed({ deliverableId, agent, threadId, error }) {
  taskPending.clear(threadId);
  return transition(deliverableId, TASK_STATUS.FAILED, {
    agent,
    threadId,
    error,
    summary: `${agent?.label || 'Agent'} failed`,
  });
}

module.exports = {
  transition,
  handleNeedsInput,
  handleComplete,
  handleFailed,
  flushCompletions,
  notifyNeedsInput,
  notifyFailure,
  queueCompletion,
};
