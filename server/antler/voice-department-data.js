const registry = require('./registry-store');
const { matchesParticipant } = require('./standup-deliverable-context');

const MAX_ITEMS = 12;

function officeAgentRole(agentId) {
  try {
    const office = require('./office-state');
    return office.getAgent(agentId)?.role || null;
  } catch {
    return null;
  }
}

function listDepartmentItems(participant, reportPeriod) {
  if (!participant || !reportPeriod) return [];
  const from = reportPeriod.from;
  const to = reportPeriod.to;
  return registry
    .listDeliverables()
    .filter((d) => {
      if (d.kind === 'daily_report' && d.standupSections?.length > 1) return false;
      if (d.createdAt < from || d.createdAt > to) return false;
      return matchesParticipant(d, participant);
    })
    .slice(0, MAX_ITEMS)
    .map((d) => ({
      kind: d.kind || 'task',
      summary: String(d.summary || d.task || 'item').slice(0, 200),
      task: d.task ? String(d.task).slice(0, 120) : '',
      status: d.status || 'unknown',
      progressPercent: d.progressPercent != null ? d.progressPercent : null,
      agentLabel: d.agentLabel || '',
      createdAt: d.createdAt || null,
    }));
}

/** Structured activity fetch for one department (no LLM, no RAG). */
function fetchDepartmentActivity(participant, reportPeriod) {
  const items = listDepartmentItems(participant, reportPeriod);
  const contextLines = items.map((d) => {
    const progress = d.progressPercent != null && d.status === 'in_progress' ? ` (${d.progressPercent}%)` : '';
    const task = d.task ? ` — ${d.task}` : '';
    return `- [${d.kind}] ${d.summary}${progress}${task}`;
  });
  return {
    agentId: participant.agentId,
    role: participant.role,
    label: participant.label,
    items,
    itemCount: items.length,
    contextText: contextLines.length
      ? `Complete Job entries:\n${contextLines.join('\n')}`
      : '',
  };
}

/** Parallel structured fetch for all participants. */
async function fetchAllDepartmentsParallel(participants, reportPeriod) {
  return Promise.all(
    participants.map(async (participant) => fetchDepartmentActivity(participant, reportPeriod)),
  );
}

module.exports = {
  fetchDepartmentActivity,
  fetchAllDepartmentsParallel,
  listDepartmentItems,
};
