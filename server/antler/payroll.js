// NPC salary: deduct credits on hire anniversary (and on hire for first period).

const billing = require('./billing');
const registry = require('./registry-store');
const office = require('./office-state');
const billingIntervalMod = require('./billing-interval');
const ceoPricing = require('./ceo-pricing');
const orgRoles = require('./org-roles');

function officeNpcId(agent) {
  if (!agent?.id) return null;
  if (orgRoles.isCooRole(agent.role)) return 'coo';
  return `user:${agent.id}`;
}
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
  const npcId = officeNpcId(agent);
  if (!npcId) return;
  if (agent.payrollStatus === 'suspended') {
    office.setAgent(npcId, {
      npcState: 'resting',
      bubbleText: '老子不干了 · No money no work',
    });
  }
}

function syncOfficeLeaving(agent) {
  if (!agent?.id || !agent.fireAt) return;
  const npcId = officeNpcId(agent);
  if (!npcId) return;
  office.setAgent(npcId, {
    bubbleText: `Leaving ${formatLeaveDate(agent.fireAt)}`,
  });
}

async function terminateAgent(agent, { openclaw } = {}) {
  if (!agent?.id) return null;
  if (agent.openclawAgentId && openclaw) {
    await openclaw.agentsDelete(agent.openclawAgentId);
  }
  registry.removeAgent(agent.id);
  if (orgRoles.isCooRole(agent.role)) {
    office.clearRoleStation('coo');
  } else {
    ceoPricing.syncHiredCeoAgent();
  }
  office.removeAgent(`user:${agent.id}`);
  return agent;
}

function requestFire(agent) {
  if (!agent?.id) throw new Error('Agent not found');
  if (agent.payrollStatus === 'pending_termination') throw new Error('Already scheduled to leave');

  const hasPayroll =
    agent.templateId &&
    Number.isFinite(agent.salaryCreditsPerMonth) &&
    agent.salaryCreditsPerMonth > 0 &&
    !billingIntervalMod.isPaygo(agent.billingInterval);
  const fireAt = hasPayroll && typeof agent.nextSalaryDueAt === 'number' ? agent.nextSalaryDueAt : Date.now();

  if (fireAt <= Date.now()) {
    return { immediate: true, fireAt };
  }

  const updated = registry.updateAgent(agent.id, {
    payrollStatus: 'pending_termination',
    fireAt,
    autoRenew: false,
  });
  syncOfficeLeaving(updated);
  return { immediate: false, fireAt, agent: updated };
}

function cancelFire(agent, { billingInterval } = {}) {
  if (!agent?.id) throw new Error('Agent not found');
  if (agent.payrollStatus !== 'pending_termination') {
    throw new Error('Agent is not scheduled to leave');
  }

  const patch = {
    payrollStatus: 'active',
    fireAt: null,
    autoRenew: true,
  };
  if (billingInterval) {
    patch.billingInterval = billingIntervalMod.normalizeBillingInterval(billingInterval);
  }

  const updated = registry.updateAgent(agent.id, patch);
  const npcId = officeNpcId(updated);
  if (npcId) office.setAgent(npcId, { bubbleText: '' });
  return updated;
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
  if (orgRoles.isCooRole(agent?.role)) {
    ceoPricing.syncHiredCeoAgent();
    agent = registry.getAgent(agent.id) || agent;
  }
  const monthly = agent.salaryCreditsPerMonth;
  if (!Number.isFinite(monthly) || monthly <= 0) return { ok: true, skipped: true };

  const bill = billingIntervalMod.normalizeBillingInterval(agent.billingInterval);
  if (billingIntervalMod.isPaygo(bill)) return { ok: true, skipped: true, reason: 'paygo' };
  const billingCredits = agent.billingCreditsByInterval || null;
  const salary = billingIntervalMod.creditsPerPeriod(monthly, bill, billingCredits);

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

  const nextSalaryDueAt = orgRoles.isCooRole(agent.role)
    ? ceoPricing.nextLocalMidnightMs(Date.now())
    : billingIntervalMod.addBillingPeriod(
      agent.nextSalaryDueAt || agent.hiredAt || Date.now(),
      bill,
    );
  const updated = registry.updateAgent(agent.id, {
    payrollStatus: 'active',
    nextSalaryDueAt,
    lastSalaryPaidAt: Date.now(),
  });
  syncOfficePayroll(updated);
  return { ok: true, agent: updated, nextSalaryDueAt };
}

function runCeoDailyPayroll() {
  ceoPricing.syncHiredCeoAgent();
  const ceo = ceoPricing.findHiredCeoAgent();
  if (!ceo) return { processed: 0, results: [] };

  const now = Date.now();
  const active =
    ceo.templateId
    && !ceo.ecsSubscriptionId
    && ceo.payrollStatus === 'active'
    && ceo.autoRenew !== false
    && Number.isFinite(ceo.salaryCreditsPerMonth)
    && ceo.salaryCreditsPerMonth > 0
    && typeof ceo.nextSalaryDueAt === 'number'
    && ceo.nextSalaryDueAt <= now;

  if (!active) return { processed: 0, results: [] };

  const fresh = registry.getAgent(ceo.id) || ceo;
  const result = payAgentSalary(fresh, { reason: 'daily', periodAt: fresh.nextSalaryDueAt });
  return { processed: 1, results: [{ agentId: ceo.id, ...result }] };
}

function runPayrollDue() {
  const now = Date.now();
  const due = registry.listAgents().filter(
    (a) =>
      a.templateId &&
      !a.ecsSubscriptionId &&
      a.payrollStatus === 'active' &&
      a.autoRenew !== false &&
      !billingIntervalMod.isPaygo(a.billingInterval) &&
      Number.isFinite(a.salaryCreditsPerMonth) &&
      a.salaryCreditsPerMonth > 0 &&
      typeof a.nextSalaryDueAt === 'number' &&
      a.nextSalaryDueAt <= now,
  );

  const results = [];
  for (const agent of due) {
    const reason = orgRoles.isCooRole(agent.role) ? 'daily' : 'monthly';
    results.push({ agentId: agent.id, ...payAgentSalary(agent, { reason, periodAt: agent.nextSalaryDueAt }) });
  }
  return { processed: results.length, results };
}

function updateContractBilling(agent, { billingInterval } = {}) {
  if (!agent?.id) throw new Error('Agent not found');
  if (orgRoles.isCooRole(agent.role)) {
    throw new Error('CEO salary is daily only and recalculates automatically at midnight.');
  }
  if (!billingInterval) throw new Error('billingInterval required');
  const bill = billingIntervalMod.normalizeBillingInterval(billingInterval);
  return registry.updateAgent(agent.id, { billingInterval: bill });
}

module.exports = {
  addOneMonth,
  payAgentSalary,
  runPayrollDue,
  runCeoDailyPayroll,
  syncOfficePayroll,
  cancelFire,
  requestFire,
  updateContractBilling,
  terminateAgent,
  processPendingFires,
};
