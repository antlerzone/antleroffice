// Monthly NPC salary: deduct credits on hire anniversary (and on hire for first month).

const billing = require('./billing');
const registry = require('./registry-store');
const office = require('./office-state');

function addOneMonth(fromMs) {
  const d = new Date(fromMs);
  const day = d.getDate();
  d.setMonth(d.getMonth() + 1);
  if (d.getDate() < day) d.setDate(0);
  return d.getTime();
}

function formatPeriod(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatLeaveDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function syncOfficePayroll(agent) {
  if (!agent?.id) return;
  const npcId = `user:${agent.id}`;
  if (agent.payrollStatus === 'suspended') {
    office.setAgent(npcId, {
      npcState: 'resting',
      bubbleText: 'Salary unpaid — recharge credits to resume.',
    });
  }
}

function syncOfficeLeaving(agent) {
  if (!agent?.id || !agent.fireAt) return;
  office.setAgent(`user:${agent.id}`, {
    bubbleText: `Leaving ${formatLeaveDate(agent.fireAt)}`,
  });
}

async function terminateAgent(agent, { openclaw } = {}) {
  if (!agent?.id) return null;
  if (agent.openclawAgentId && openclaw) {
    await openclaw.agentsDelete(agent.openclawAgentId);
  }
  registry.removeAgent(agent.id);
  office.removeAgent(`user:${agent.id}`);
  return agent;
}

function requestFire(agent) {
  if (!agent?.id) throw new Error('Agent not found');
  if (agent.payrollStatus === 'pending_termination') throw new Error('Already scheduled to leave');

  const hasPayroll =
    agent.templateId && Number.isFinite(agent.salaryCreditsPerMonth) && agent.salaryCreditsPerMonth > 0;
  const fireAt = hasPayroll && typeof agent.nextSalaryDueAt === 'number' ? agent.nextSalaryDueAt : Date.now();

  if (fireAt <= Date.now()) {
    return { immediate: true, fireAt };
  }

  const updated = registry.updateAgent(agent.id, {
    payrollStatus: 'pending_termination',
    fireAt,
  });
  syncOfficeLeaving(updated);
  return { immediate: false, fireAt, agent: updated };
}

async function processPendingFires(openclaw) {
  const now = Date.now();
  const due = registry.listAgents().filter(
    (a) =>
      a.payrollStatus === 'pending_termination' && typeof a.fireAt === 'number' && a.fireAt <= now,
  );
  for (const agent of due) {
    await terminateAgent(agent, { openclaw });
  }
  return { removed: due.length };
}

function payAgentSalary(agent, { reason = 'monthly', periodAt } = {}) {
  const salary = agent.salaryCreditsPerMonth;
  if (!Number.isFinite(salary) || salary <= 0) return { ok: true, skipped: true };

  try {
    billing.deductCredits(salary, {
      reason,
      agentId: agent.id,
      agentName: agent.name,
      templateId: agent.templateId || null,
      period: formatPeriod(periodAt || Date.now()),
    });
  } catch (e) {
    if (e.code === 'INSUFFICIENT_CREDITS') {
      const updated = registry.updateAgent(agent.id, { payrollStatus: 'suspended' });
      syncOfficePayroll(updated);
      return { ok: false, error: 'INSUFFICIENT_CREDITS', balance: e.balance, required: e.required };
    }
    throw e;
  }

  const nextSalaryDueAt = addOneMonth(agent.nextSalaryDueAt || agent.hiredAt || Date.now());
  const updated = registry.updateAgent(agent.id, {
    payrollStatus: 'active',
    nextSalaryDueAt,
    lastSalaryPaidAt: Date.now(),
  });
  syncOfficePayroll(updated);
  return { ok: true, agent: updated, nextSalaryDueAt };
}

function runPayrollDue() {
  const now = Date.now();
  const due = registry.listAgents().filter(
    (a) =>
      a.templateId &&
      !a.ecsSubscriptionId &&
      a.payrollStatus === 'active' &&
      Number.isFinite(a.salaryCreditsPerMonth) &&
      a.salaryCreditsPerMonth > 0 &&
      typeof a.nextSalaryDueAt === 'number' &&
      a.nextSalaryDueAt <= now,
  );

  const results = [];
  for (const agent of due) {
    results.push({ agentId: agent.id, ...payAgentSalary(agent, { reason: 'monthly', periodAt: agent.nextSalaryDueAt }) });
  }
  return { processed: results.length, results };
}

module.exports = {
  addOneMonth,
  payAgentSalary,
  runPayrollDue,
  syncOfficePayroll,
  requestFire,
  terminateAgent,
  processPendingFires,
};
