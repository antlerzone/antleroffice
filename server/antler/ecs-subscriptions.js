// Notify ECS server on hire / fire / payroll heartbeat.

const auth = require('./auth');
const ecssync = require('./ecs-sync');

function ecsBaseUrl() {
  return auth.ecsBaseUrl();
}

async function ecsFetch(path, { ecsToken, method = 'GET', body } = {}) {
  const base = ecsBaseUrl();
  if (!base || !ecsToken) return { ok: false, skipped: true, reason: 'no_ecs' };
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${ecsToken}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: data.error || `HTTP ${res.status}`,
        code: data.code,
        balance: data.balance,
        required: data.required,
      };
    }
    return { ok: true, ...data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function notifyHire({
  ecsToken,
  departmentId,
  templateId,
  localAgentId,
  agentName,
  desktopId,
  hirePassword,
} = {}) {
  return ecsFetch('/api/subscriptions/hire', {
    ecsToken,
    method: 'POST',
    body: {
      departmentId: departmentId || templateId,
      templateId: templateId || departmentId,
      localAgentId,
      agentName,
      desktopId: desktopId || ecssync.desktopId(),
      hirePassword,
    },
  });
}

async function notifyFire({ ecsToken, subscriptionId, localAgentId } = {}) {
  if (subscriptionId) {
    return ecsFetch(`/api/subscriptions/${subscriptionId}/fire`, {
      ecsToken,
      method: 'POST',
      body: { localAgentId },
    });
  }
  return ecsFetch('/api/subscriptions/fire', {
    ecsToken,
    method: 'POST',
    body: { localAgentId, subscriptionId },
  });
}

async function payrollHeartbeat({
  ecsToken,
  officeId,
  agents = [],
  gatewayWsUrl,
  gatewayAuthToken,
  gatewayAuthPassword,
  displayName,
  hostname,
  platform,
  antlerVersion,
} = {}) {
  return ecsFetch('/api/desktop/payroll-heartbeat', {
    ecsToken,
    method: 'POST',
    body: {
      officeId,
      desktopId: ecssync.desktopId(),
      agents,
      gatewayWsUrl,
      gatewayAuthToken,
      gatewayAuthPassword,
      displayName,
      hostname,
      platform,
      antlerVersion,
    },
  });
}

function ecsTokenFromBossToken(bossToken) {
  return auth.getEcsAccessToken(bossToken) || null;
}

function isEcsBillingEnabled(bossToken) {
  return !!(ecsBaseUrl() && ecsTokenFromBossToken(bossToken));
}

module.exports = {
  ecsBaseUrl,
  ecsFetch,
  notifyHire,
  notifyFire,
  payrollHeartbeat,
  ecsTokenFromBossToken,
  isEcsBillingEnabled,
};
