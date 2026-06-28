// Notify ECS server on hire / fire / payroll heartbeat.

const auth = require('./auth');
const store = require('./store');
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

function resolveOfficeIdSync({ bossToken, officeId } = {}) {
  if (officeId) return officeId;
  const settings = store.readSettings();
  if (settings.selectedOfficeId) return settings.selectedOfficeId;
  const s = bossToken ? auth.session(bossToken) : null;
  if (s?.selectedOfficeId) return s.selectedOfficeId;
  if (s?.offices?.[0]?.id) return s.offices[0].id;
  return null;
}

async function resolveOfficeId({ bossToken, ecsToken, officeId } = {}) {
  const cached = resolveOfficeIdSync({ bossToken, officeId });
  if (cached) return cached;
  if (!ecsToken) return null;
  const result = await ecsFetch('/api/offices', { ecsToken });
  const id = result.offices?.[0]?.id || null;
  if (id) {
    store.writeSettings({ ...store.readSettings(), selectedOfficeId: id });
    if (bossToken) {
      const s = auth.session(bossToken);
      if (s) {
        s.selectedOfficeId = id;
        if (!s.offices?.length) s.offices = result.offices;
      }
    }
  }
  return id;
}

async function notifyHire({
  ecsToken,
  bossToken,
  officeId,
  departmentId,
  templateId,
  localAgentId,
  agentName,
  desktopId,
  hirePassword,
  billingInterval,
  autoRenew,
} = {}) {
  const resolvedOfficeId = await resolveOfficeId({ bossToken, ecsToken, officeId });
  if (!resolvedOfficeId) {
    return { ok: false, error: 'officeId required', code: 'OFFICE_REQUIRED' };
  }
  return ecsFetch('/api/subscriptions/hire', {
    ecsToken,
    method: 'POST',
    body: {
      officeId: resolvedOfficeId,
      departmentId: departmentId || templateId,
      templateId: templateId || departmentId,
      localAgentId,
      agentName,
      desktopId: desktopId || ecssync.desktopId(),
      hirePassword,
      billingInterval,
      autoRenew: autoRenew !== false,
    },
  });
}

async function notifyFire({ ecsToken, bossToken, officeId, subscriptionId, localAgentId } = {}) {
  const resolvedOfficeId = await resolveOfficeId({ bossToken, ecsToken, officeId });
  if (!resolvedOfficeId) {
    return { ok: false, error: 'officeId required', code: 'OFFICE_REQUIRED' };
  }
  if (subscriptionId) {
    return ecsFetch(`/api/subscriptions/${subscriptionId}/fire`, {
      ecsToken,
      method: 'POST',
      body: { officeId: resolvedOfficeId, localAgentId },
    });
  }
  return ecsFetch('/api/subscriptions/fire', {
    ecsToken,
    method: 'POST',
    body: { officeId: resolvedOfficeId, localAgentId, subscriptionId },
  });
}

async function notifyReactivate({
  ecsToken,
  bossToken,
  officeId,
  subscriptionId,
  localAgentId,
  billingInterval,
} = {}) {
  const resolvedOfficeId = await resolveOfficeId({ bossToken, ecsToken, officeId });
  if (!resolvedOfficeId) {
    return { ok: false, error: 'officeId required', code: 'OFFICE_REQUIRED' };
  }
  if (!subscriptionId) {
    return { ok: false, error: 'subscriptionId required', code: 'SUBSCRIPTION_REQUIRED' };
  }
  return ecsFetch(`/api/subscriptions/${subscriptionId}/reactivate`, {
    ecsToken,
    method: 'POST',
    body: { officeId: resolvedOfficeId, localAgentId, billingInterval, autoRenew: true },
  });
}

async function notifyUpdateBilling({
  ecsToken,
  bossToken,
  officeId,
  subscriptionId,
  localAgentId,
  billingInterval,
} = {}) {
  const resolvedOfficeId = await resolveOfficeId({ bossToken, ecsToken, officeId });
  if (!resolvedOfficeId) {
    return { ok: false, error: 'officeId required', code: 'OFFICE_REQUIRED' };
  }
  if (!subscriptionId) {
    return { ok: false, error: 'subscriptionId required', code: 'SUBSCRIPTION_REQUIRED' };
  }
  return ecsFetch(`/api/subscriptions/${subscriptionId}/billing-interval`, {
    ecsToken,
    method: 'POST',
    body: { officeId: resolvedOfficeId, localAgentId, billingInterval },
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

// ── Paid skins (server-authoritative on ECS) ─────────────────────────────────
async function skinCatalog({ bossToken, ecsToken, officeId } = {}) {
  const token = ecsToken || ecsTokenFromBossToken(bossToken);
  const resolvedOfficeId = await resolveOfficeId({ bossToken, ecsToken: token, officeId });
  if (!resolvedOfficeId) return { ok: false, error: 'officeId required', code: 'OFFICE_REQUIRED' };
  return ecsFetch(`/api/skins/catalog?officeId=${encodeURIComponent(resolvedOfficeId)}`, { ecsToken: token });
}

async function purchaseSkin({ bossToken, ecsToken, officeId, skinId } = {}) {
  const token = ecsToken || ecsTokenFromBossToken(bossToken);
  const resolvedOfficeId = await resolveOfficeId({ bossToken, ecsToken: token, officeId });
  if (!resolvedOfficeId) return { ok: false, error: 'officeId required', code: 'OFFICE_REQUIRED' };
  return ecsFetch(`/api/skins/${encodeURIComponent(skinId)}/purchase`, {
    ecsToken: token,
    method: 'POST',
    body: { officeId: resolvedOfficeId },
  });
}

async function createSkin({ bossToken, ecsToken, officeId, name, priceCredits, previewUrl, assetUrl } = {}) {
  const token = ecsToken || ecsTokenFromBossToken(bossToken);
  const resolvedOfficeId = await resolveOfficeId({ bossToken, ecsToken: token, officeId });
  if (!resolvedOfficeId) return { ok: false, error: 'officeId required', code: 'OFFICE_REQUIRED' };
  return ecsFetch('/api/skins', {
    ecsToken: token,
    method: 'POST',
    body: { officeId: resolvedOfficeId, name, priceCredits, previewUrl, assetUrl },
  });
}

module.exports = {
  ecsBaseUrl,
  ecsFetch,
  notifyHire,
  notifyFire,
  notifyReactivate,
  notifyUpdateBilling,
  payrollHeartbeat,
  ecsTokenFromBossToken,
  isEcsBillingEnabled,
  skinCatalog,
  purchaseSkin,
  createSkin,
};
