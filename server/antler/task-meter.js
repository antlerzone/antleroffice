// Classify completed tasks, record local usage, deduct OT credits via ECS or local billing.

const billing = require('./billing');
const ecsSubscriptions = require('./ecs-subscriptions');
const workerEntitlements = require('./worker-entitlements');
const usageStore = require('./agent-usage-store');
const store = require('./store');
const auth = require('./auth');

async function chargeCrossWorkerOt({ agent, classified, ecsToken, officeId }) {
  const amount = classified.otCreditsPerTask || 15;
  if (ecsToken && officeId) {
    const res = await ecsSubscriptions.ecsFetch('/api/usage/cross-worker-ot', {
      ecsToken,
      method: 'POST',
      body: {
        officeId,
        subscriptionId: agent.ecsSubscriptionId || null,
        departmentId: agent.templateId || null,
        amount,
        homeWorkerId: agent.homeWorkerId || agent.role,
        skillIds: agent.skillIds || [],
        mcpIds: agent.mcpIds || [],
        localAgentId: agent.id,
        agentName: agent.name,
      },
    });
    if (res.ok) {
      if (typeof res.creditBalance === 'number') {
        billing.setBalance(res.creditBalance, { reason: 'cross_worker_ot' });
      }
      return { ok: true, amount, source: 'ecs' };
    }
    if (res.code === 'INSUFFICIENT_CREDITS') {
      const err = new Error('Insufficient credits for cross-worker OT.');
      err.code = 'INSUFFICIENT_CREDITS';
      err.balance = res.balance;
      err.required = res.required;
      throw err;
    }
  }

  billing.deductCredits(amount, {
    reason: 'cross_worker_ot',
    agentName: agent.name,
    subscriptionId: agent.ecsSubscriptionId,
    departmentId: agent.templateId,
    period: usageStore.formatPeriod(),
  });
  return { ok: true, amount, source: 'local' };
}

function resolveBillingContext(bossToken) {
  const s = bossToken ? auth.session(String(bossToken)) : null;
  const settings = store.readSettings();
  const officeId = settings.selectedOfficeId || s?.offices?.[0]?.id || null;
  return { ecsToken: s?.ecsAccessToken || null, officeId };
}

/**
 * @param {object} agent registry agent row
 * @param {{ skillIds?: string[], mcpIds?: string[], tokens?: number, bossToken?: string }} opts
 */
async function meterTaskRun(agent, opts = {}) {
  if (!agent?.id) return { scope: 'home', reason: 'no_agent' };

  const homeWorkerId = agent.homeWorkerId || agent.role || agent.templateId;
  const skillIds = opts.skillIds ?? agent.skillIds ?? [];
  const mcpIds = opts.mcpIds ?? agent.mcpIds ?? [];

  const classified = await workerEntitlements.classifyTaskUsage({
    homeWorkerId,
    skillIds,
    mcpIds,
  });

  usageStore.recordTaskRun({
    agentId: agent.id,
    scope: classified.scope === 'ot' ? 'ot' : 'home',
    tokens: opts.tokens || 0,
  });

  if (classified.scope !== 'ot') {
    return { ...classified, charged: false };
  }

  if (agent.payrollStatus === 'suspended') {
    return { ...classified, charged: false, blocked: 'payroll_suspended' };
  }

  const { ecsToken, officeId } = resolveBillingContext(opts.bossToken);
  try {
    const charge = await chargeCrossWorkerOt({ agent, classified, ecsToken, officeId });
    return { ...classified, charged: true, ...charge };
  } catch (e) {
    return { ...classified, charged: false, error: e.message, code: e.code };
  }
}

module.exports = {
  meterTaskRun,
  chargeCrossWorkerOt,
};
