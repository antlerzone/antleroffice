// Login + subscription gate.
//
// AntlerOffice asks the user to log in on launch and reads back their
// subscription + credit balance. Real deployments point `settings.auth.baseUrl`
// at the ECS / website backend; when unset we run in MOCK mode so local dev and
// the demo exe work without any backend. Replace `verifyRemote` wiring when the
// real endpoints are provided.

const store = require('./store');
const billing = require('./billing');

const sessions = new Map(); // token -> session

function newToken() {
  return 'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function authConfig() {
  return store.readSettings().auth || {};
}

function ecsAuthUrl() {
  return (
    process.env.ECS_AUTH_URL ||
    process.env.VITE_OFFICE_WEB_URL ||
    ''
  ).replace(/\/+$/, '');
}

function isLoopbackUrl(base) {
  try {
    const host = new URL(base).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
}

function ecsBaseUrl() {
  const authUrl = ecsAuthUrl();
  const direct = (
    process.env.ECS_BASE_URL ||
    process.env.ECS_SERVER_URL ||
    authConfig().baseUrl ||
    ''
  ).replace(/\/+$/, '');
  // Local Antlermarket/server (:3030) is optional; cloud login tokens use ECS_AUTH_URL.
  if (authUrl && direct && isLoopbackUrl(direct) && authUrl !== direct) return authUrl;
  return direct || authUrl;
}

function isMock() {
  if (process.env.ANTLEROFFICE_AUTH_MOCK === '1') return true;
  return !ecsBaseUrl();
}

// Mock account: accept any credentials, hand out a generous credit balance so
// the office is fully usable while billing is stubbed.
function mockSession(username) {
  const email = username?.includes('@') ? username : `${username || 'boss'}@antleroffice.local`;
  return {
    token: newToken(),
    mock: true,
    user: {
      id: `mock-${email}`,
      name: username || 'Boss',
      email,
    },
    subscription: { plan: 'Pro (mock)', status: 'active' },
    creditBalance: billing.getBalance(),
    currency: billing.getCurrency(),
  };
}

function syncSessionCredits(s) {
  if (!s) return s;
  s.creditBalance = billing.getBalance();
  s.currency = billing.getCurrency();
  return s;
}

function refreshAllSessionCredits() {
  for (const s of sessions.values()) syncSessionCredits(s);
}

async function login({ username, password } = {}) {
  if (isMock()) {
    const s = mockSession(username);
    sessions.set(s.token, s);
    return s;
  }
  // Real mode (Phase 2): POST to the ECS/website login endpoint and read back
  // { user, subscription, creditBalance }. Endpoint shape TBD by ECS.
  const cfg = authConfig();
  const base = ecsBaseUrl();
  const res = await fetch(`${base}${cfg.loginPath || '/api/auth/login'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`auth ${res.status}`);
  const data = await res.json();
  const s = {
    token: data.token || newToken(),
    user: data.user || { name: username },
    subscription: data.subscription || { plan: 'unknown', status: 'active' },
    creditBalance: typeof data.creditBalance === 'number' ? data.creditBalance : 0,
    currency: data.currency || 'credits',
  };
  sessions.set(s.token, s);
  return s;
}

async function loginWithEcsToken(ecsData = {}) {
  const offices = ecsData.offices || [];
  const selectedOfficeId =
    ecsData.selectedOfficeId || offices[0]?.id || null;
  const s = {
    token: newToken(),
    ecsAccessToken: ecsData.access_token || '',
    user: ecsData.user || { name: 'Boss', email: '' },
    offices,
    selectedOfficeId,
    subscription:
      ecsData.subscription || ecsData.user?.subscription || { plan: 'Pro', status: 'active' },
    creditBalance:
      typeof ecsData.creditBalance === 'number'
        ? ecsData.creditBalance
        : ecsData.user?.creditBalance || 0,
    currency: 'credits',
  };
  sessions.set(s.token, s);
  return s;
}

function getEcsAccessToken(token) {
  const s = sessions.get(token);
  return s?.ecsAccessToken || null;
}

async function refreshSessionFromEcs(s) {
  if (!s?.ecsAccessToken) return s;
  const base = ecsBaseUrl();
  if (!base) return s;
  try {
    const res = await fetch(`${base}/api/auth/me`, {
      headers: { Authorization: `Bearer ${s.ecsAccessToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return s;
    const data = await res.json();
    if (data.user) {
      s.user = data.user;
      s.subscription = data.user.subscription || s.subscription;
    }
    if (typeof data.creditBalance === 'number') s.creditBalance = data.creditBalance;
  } catch {
    /* keep cached session */
  }
  return s;
}

function session(token) {
  return sessions.get(token) || null;
}

function logout(token) {
  sessions.delete(token);
}

// Public view of a session (safe to send to the browser).
function publicView(s) {
  if (!s) return null;
  return {
    user: s.user,
    subscription: s.subscription,
    creditBalance: s.creditBalance,
    currency: s.currency,
    mock: !!s.mock,
    ecs: !!s.ecsAccessToken,
  };
}

module.exports = {
  login,
  loginWithEcsToken,
  getEcsAccessToken,
  refreshSessionFromEcs,
  session,
  logout,
  publicView,
  isMock,
  ecsBaseUrl,
  ecsAuthUrl,
  syncSessionCredits,
  refreshAllSessionCredits,
};
