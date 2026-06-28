// Pay-as-you-go billing: 1 credit/hour while subagents work.
// Local desktop keeps a monotonic usage ledger; ECS reconciles on recovery (only increases, never decreases).

const billing = require('./billing');
const registry = require('./registry-store');
const payroll = require('./payroll');
const ecsSubscriptions = require('./ecs-subscriptions');
const paygoUsageStore = require('./paygo-usage-store');
const paygoPendingStore = require('./paygo-pending-store');
const auth = require('./auth');
const store = require('./store');
const { PAYGO_CREDITS_PER_HOUR, isPaygo } = require('./billing-interval');

const MS_PER_CREDIT = 3_600_000 / PAYGO_CREDITS_PER_HOUR;
const SUBAGENT_TOOLS = new Set(['task', 'agent', 'sessions_spawn', 'subagents']);
const SETTLE_INTERVAL_MS = 60_000;

/** @type {Map<string, { registryAgentId: string, sessionKey: string, lastSettleAt: number }>} */
const activeSessions = new Map();
let ecsReachable = true;
let flushInFlight = false;

function ecsBillingRequired() {
  return !!ecsSubscriptions.ecsBaseUrl();
}

function parseSessionKey(sessionKey) {
  const raw = String(sessionKey || '').trim();
  const parts = raw.split(':').filter(Boolean);
  if (parts[0] === 'agent' && parts.length >= 3) {
    const agent = parts[1] || 'main';
    const head = (parts[2] || '').toLowerCase();
    if (!head || head === 'main' || head === 'direct') return { agent, channel: 'main' };
    if (head === 'subagent' || head === 'cron' || head === 'acp') return { agent, channel: head };
    return { agent, channel: head };
  }
  return { agent: 'main', channel: 'main' };
}

function isSubagentTool(toolName) {
  return SUBAGENT_TOOLS.has(String(toolName || '').trim().toLowerCase());
}

function resolvePaygoAgent(openclawId) {
  const id = String(openclawId || 'main');
  const agent = registry.listAgents().find(
    (a) =>
      a.openclawAgentId === id &&
      isPaygo(a.billingInterval) &&
      a.payrollStatus === 'active' &&
      a.templateId,
  );
  if (!agent) return null;
  if (ecsBillingRequired() && !agent.ecsSubscriptionId) return null;
  return agent;
}

function resolveBillingContext() {
  const settings = store.readSettings();
  return {
    ecsToken: settings._lastEcsAccessToken || null,
    officeId: settings.selectedOfficeId || null,
  };
}

function ecsOk(res) {
  return !!(res && res.ok && !res.skipped);
}

function recordLocalUsage(agent, { credits, durationMs, sessionKey }) {
  paygoUsageStore.recordPaygoUsage({
    agentId: agent.id,
    agentName: agent.name,
    templateId: agent.templateId,
    subscriptionId: agent.ecsSubscriptionId,
    sessionKey,
    durationMs,
    credits,
  });
  paygoPendingStore.addLocalUsage(agent.id, { durationMs, credits });
}

async function pingEcsPaygo(agent) {
  if (!ecsBillingRequired()) {
    // No ECS configured = no MySQL billing source; block instead of fake-allow.
    ecsReachable = false;
    return false;
  }

  const { ecsToken, officeId } = resolveBillingContext();
  if (!ecsToken || !officeId || !agent?.ecsSubscriptionId) {
    ecsReachable = false;
    return false;
  }

  const qs = new URLSearchParams({ officeId, localAgentId: agent.id });
  if (agent.ecsSubscriptionId) qs.set('subscriptionId', agent.ecsSubscriptionId);

  const res = await ecsSubscriptions.ecsFetch(`/api/usage/paygo/preflight?${qs}`, { ecsToken });
  if (!ecsOk(res)) {
    ecsReachable = false;
    return false;
  }

  ecsReachable = true;
  if (typeof res.balance === 'number') {
    billing.setBalance(res.balance, { reason: 'paygo_preflight' });
  }
  if (res.canRun) return true;

  if (res.reason === 'insufficient_credits' || res.reason === 'subscription_suspended') {
    suspendAgent(agent.id, res.reason);
  }
  return false;
}

async function ensurePaygoAllowed(agent) {
  if (!agent?.id || agent.payrollStatus === 'suspended') return false;
  if (!ecsBillingRequired()) {
    return false;
  }

  const allowed = await pingEcsPaygo(agent);
  if (allowed) return true;

  // ECS temporarily unreachable — keep metering locally; resume sync when back.
  if (!ecsReachable) return false; // ECS/MySQL unreachable: block, no offline spend

  return false;
}

async function postPaygoCharge(agent, { amount, durationMs, sessionKey, pendingId }) {
  const { ecsToken, officeId } = resolveBillingContext();
  if (!ecsToken || !officeId || !agent.ecsSubscriptionId) {
    ecsReachable = false;
    return { ok: false, reason: 'ecs_billing_context_missing' };
  }

  const res = await ecsSubscriptions.ecsFetch('/api/usage/paygo', {
    ecsToken,
    method: 'POST',
    body: {
      officeId,
      subscriptionId: agent.ecsSubscriptionId,
      departmentId: agent.templateId || null,
      amount,
      durationMs,
      sessionKey,
      localAgentId: agent.id,
      agentName: agent.name,
      pendingId: pendingId || null,
    },
  });

  if (ecsOk(res)) {
    ecsReachable = true;
    if (typeof res.creditBalance === 'number') {
      billing.setBalance(res.creditBalance, { reason: 'paygo_subagent' });
    }
    auth.refreshAllSessionCredits();
    return { ok: true, res };
  }

  ecsReachable = false;
  return { ok: false, reason: res.code || res.error || 'paygo_charge_failed', res };
}

async function postPaygoReconcile(agent) {
  const { ecsToken, officeId } = resolveBillingContext();
  if (!ecsToken || !officeId || !agent.ecsSubscriptionId) return { ok: false };

  const local = paygoPendingStore.getLocalTotals(agent.id);
  const res = await ecsSubscriptions.ecsFetch('/api/usage/paygo/reconcile', {
    ecsToken,
    method: 'POST',
    body: {
      officeId,
      subscriptionId: agent.ecsSubscriptionId,
      localAgentId: agent.id,
      agentName: agent.name,
      localTotalDurationMs: local.totalDurationMs,
      localTotalCredits: local.totalCreditsAccrued,
    },
  });

  if (ecsOk(res)) {
    ecsReachable = true;
    if (typeof res.creditBalance === 'number') {
      billing.setBalance(res.creditBalance, { reason: 'paygo_reconcile' });
    }
    if (res.code === 'INSUFFICIENT_CREDITS') {
      suspendAgent(agent.id, 'insufficient_credits');
    }
    auth.refreshAllSessionCredits();
    return { ok: true, res };
  }

  ecsReachable = false;
  return { ok: false, res };
}

async function chargeCredits(registryAgentId, amount, ctx = {}) {
  const agent = registry.getAgent(registryAgentId);
  if (!agent || amount <= 0) return { ok: false };

  const durationMs = Math.max(0, Math.floor(Number(ctx.durationMs) || amount * MS_PER_CREDIT));
  const sessionKey = ctx.sessionKey || null;

  recordLocalUsage(agent, { credits: amount, durationMs, sessionKey });

  if (ecsBillingRequired()) {
    const posted = await postPaygoCharge(agent, { amount, durationMs, sessionKey });
    if (posted.ok) return { ok: true };

    const pending = paygoPendingStore.enqueuePending({
      agentId: agent.id,
      subscriptionId: agent.ecsSubscriptionId,
      departmentId: agent.templateId,
      amount,
      durationMs,
      sessionKey,
      reason: posted.reason,
    });

    if (posted.res?.code === 'INSUFFICIENT_CREDITS') {
      suspendAgent(agent.id, 'insufficient_credits');
    }

    return { ok: false, queued: true, pendingId: pending.id };
  }

  try {
    billing.deductCredits(amount, {
      reason: 'paygo_subagent',
      agentId: agent.id,
      agentName: agent.name,
      templateId: agent.templateId,
      sessionKey,
      durationMs,
    });
    auth.refreshAllSessionCredits();
    return { ok: true };
  } catch (e) {
    if (e.code === 'INSUFFICIENT_CREDITS') suspendAgent(agent.id, 'insufficient_credits');
    return { ok: false };
  }
}

async function reconcileAllPaygoAgents() {
  const agents = registry.listAgents().filter(
    (a) => a.templateId && isPaygo(a.billingInterval) && a.ecsSubscriptionId,
  );
  let reconciled = 0;
  for (const agent of agents) {
    const result = await postPaygoReconcile(agent);
    if (result.ok && Number(result.res?.charged) > 0) reconciled += 1;
  }
  return { reconciled };
}

async function flushPendingCharges() {
  if (flushInFlight || !ecsBillingRequired()) return { flushed: 0 };

  flushInFlight = true;
  let flushed = 0;
  try {
    await reconcileAllPaygoAgents();

    const pending = paygoPendingStore.listPending();
    for (const row of [...pending].reverse()) {
      const agent = registry.getAgent(row.agentId);
      if (!agent) {
        paygoPendingStore.removePending(row.id);
        continue;
      }

      const posted = await postPaygoCharge(agent, {
        amount: row.amount,
        durationMs: row.durationMs,
        sessionKey: row.sessionKey,
        pendingId: row.id,
      });
      if (!posted.ok) {
        paygoPendingStore.bumpPendingAttempt(row.id);
        if (posted.res?.code === 'INSUFFICIENT_CREDITS') {
          suspendAgent(agent.id, 'insufficient_credits');
        }
        break;
      }

      paygoPendingStore.removePending(row.id);
      flushed += 1;
    }
  } finally {
    flushInFlight = false;
  }
  return { flushed };
}

function suspendAgent(registryAgentId, reason = 'paygo_suspended') {
  const updated = registry.updateAgent(registryAgentId, { payrollStatus: 'suspended' });
  if (updated) payroll.syncOfficePayroll(updated);
  for (const [key, sess] of activeSessions) {
    if (sess.registryAgentId === registryAgentId) activeSessions.delete(key);
  }
  try {
    require('./debug-log').logWarn('paygo', `agent ${registryAgentId} suspended: ${reason}`);
  } catch {
    /* optional */
  }
}

function settleMs(registryAgentId, ms, ctx = {}) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const prev = paygoPendingStore.getCarryMs(registryAgentId);
  const total = prev + ms;
  const credits = Math.floor(total / MS_PER_CREDIT);
  paygoPendingStore.setCarryMs(registryAgentId, total % MS_PER_CREDIT);
  if (credits > 0) {
    void chargeCredits(registryAgentId, credits, { durationMs: ms, sessionKey: ctx.sessionKey || null });
  } else {
    const agent = registry.getAgent(registryAgentId);
    if (agent) paygoPendingStore.addLocalUsage(agent.id, { durationMs: ms, credits: 0 });
  }
}

async function startSession(sessionKey, openclawId) {
  const agent = resolvePaygoAgent(openclawId);
  if (!agent) return;

  const allowed = await ensurePaygoAllowed(agent);
  if (!allowed) return;

  if (ecsReachable) await flushPendingCharges();

  const now = Date.now();
  if (!activeSessions.has(sessionKey)) {
    activeSessions.set(sessionKey, {
      registryAgentId: agent.id,
      sessionKey,
      lastSettleAt: now,
    });
  }
}

async function endSession(sessionKey) {
  const sess = activeSessions.get(sessionKey);
  if (!sess) return;

  const now = Date.now();
  const delta = now - sess.lastSettleAt;
  activeSessions.delete(sessionKey);

  settleMs(sess.registryAgentId, delta, { sessionKey: sess.sessionKey });
  await flushPendingCharges();
}

async function tickActiveSessions() {
  const now = Date.now();
  for (const [sessionKey, sess] of [...activeSessions.entries()]) {
    if (!registry.getAgent(sess.registryAgentId)) {
      activeSessions.delete(sessionKey);
      continue;
    }

    const delta = now - sess.lastSettleAt;
    if (delta >= SETTLE_INTERVAL_MS) {
      settleMs(sess.registryAgentId, delta, { sessionKey: sess.sessionKey });
      sess.lastSettleAt = now;
    }
  }

  await flushPendingCharges();
}

function toolSessionKey(openclawId, data) {
  const toolId = data.toolCallId || data.id || data.callId || `${Date.now()}`;
  return `paygo-tool:${openclawId}:${toolId}`;
}

function handleGatewayEvent(event, payload) {
  const ev = String(event || '').toLowerCase();
  if (!ev) return;

  const row = payload && typeof payload === 'object' ? payload : {};
  const sessionKey = String(row.sessionKey || row.session || '');
  const parsed = parseSessionKey(sessionKey);
  const openclawId = parsed.agent;

  if (ev !== 'agent' && !ev.startsWith('agent.')) return;

  if (ev === 'agent') {
    const stream = String(row.stream || '').toLowerCase();
    const data = row.data && typeof row.data === 'object' ? row.data : {};

    if (stream === 'lifecycle' && parsed.channel === 'subagent') {
      const phase = String(data.phase || '').toLowerCase();
      if (phase === 'start') void startSession(sessionKey, openclawId);
      else if (phase === 'end' || phase === 'error') void endSession(sessionKey);
      return;
    }

    if (stream === 'tool' && parsed.channel === 'main') {
      const toolName = String(data.name || data.tool || data.toolName || '');
      const phase = String(data.phase || data.state || '').toLowerCase();
      if (!isSubagentTool(toolName)) return;

      const key = toolSessionKey(openclawId, data);
      if (phase === 'start' || phase === 'update') void startSession(key, openclawId);
      else if (phase === 'result' || phase === 'end' || phase === 'error') void endSession(key);
    }
  }
}

function listUsage(opts = {}) {
  return paygoUsageStore.listPaygoUsage(opts);
}

function syncAgentFromEcsSubscription(sub) {
  if (!sub?.localAgentId) return;
  const agent = registry.getAgent(sub.localAgentId);
  if (!agent) return;

  const patch = {
    ecsSubscriptionId: sub.id || agent.ecsSubscriptionId,
    billingInterval: sub.billingInterval || agent.billingInterval,
  };

  if (sub.status === 'suspended') patch.payrollStatus = 'suspended';
  else if (sub.status === 'active') patch.payrollStatus = 'active';
  else if (sub.status === 'pending_termination') {
    patch.payrollStatus = 'pending_termination';
    patch.fireAt = sub.fireAt ?? agent.fireAt;
  }

  registry.updateAgent(agent.id, patch);

  const updated = registry.getAgent(agent.id);
  if (updated?.payrollStatus === 'suspended') payroll.syncOfficePayroll(updated);
  else if (updated?.payrollStatus === 'pending_termination') payroll.syncOfficeLeaving(updated);
}

function syncAgentsFromEcsSubscriptions(subscriptions = []) {
  for (const sub of subscriptions) syncAgentFromEcsSubscription(sub);
}

module.exports = {
  handleGatewayEvent,
  tickActiveSessions,
  flushPendingCharges,
  reconcileAllPaygoAgents,
  settleMs,
  startSession,
  endSession,
  parseSessionKey,
  isSubagentTool,
  listUsage,
  syncAgentsFromEcsSubscriptions,
  ecsBillingRequired,
  ensurePaygoAllowed,
};
