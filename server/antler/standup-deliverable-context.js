const registry = require('./registry-store');

const MAX_ITEMS = 12;

function matchesParticipant(d, participant) {
  if (participant.agentId && d.agentId === participant.agentId) return true;
  if (participant.role && d.department === participant.role) return true;
  if (participant.role && d.agentId && officeAgentRole(d.agentId) === participant.role) return true;
  if (participant.label && d.departmentLabel === participant.label) return true;
  if (participant.label && d.agentLabel === participant.label) return true;
  return false;
}

function officeAgentRole(agentId) {
  try {
    const office = require('./office-state');
    const agent = office.getAgent(agentId);
    return agent?.role || null;
  } catch {
    return null;
  }
}

function deliverablesContextForParticipant(participant, reportPeriod) {
  if (!participant || !reportPeriod) return '';
  const from = reportPeriod.from;
  const to = reportPeriod.to;
  const hits = registry
    .listDeliverables()
    .filter((d) => {
      if (d.kind === 'daily_report' && d.standupSections?.length > 1) return false;
      if (d.createdAt < from || d.createdAt > to) return false;
      return matchesParticipant(d, participant);
    })
    .slice(0, MAX_ITEMS);

  if (!hits.length) return '';

  const lines = hits.map((d) => {
    const progress =
      d.progressPercent != null && d.status === 'in_progress' ? ` (${d.progressPercent}%)` : '';
    const task = d.task ? ` — ${String(d.task).slice(0, 120)}` : '';
    return `- [${d.kind}] ${d.summary || d.task || 'item'}${progress}${task}`;
  });

  return (
    `Complete Job entries for this department in the report period:\n${lines.join('\n')}\n\n` +
    `Use these as factual context when writing the standup. If none apply, say so briefly.`
  );
}

module.exports = {
  deliverablesContextForParticipant,
  matchesParticipant,
};
