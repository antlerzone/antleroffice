// ECS OAuth client for desktop boss login (Plan 3).

const crypto = require('node:crypto');
const store = require('./store');

const oauthStates = new Map();

function ecsBaseUrl() {
  return (process.env.ECS_BASE_URL || process.env.ECS_SERVER_URL || store.readSettings().auth?.baseUrl || '')
    .replace(/\/+$/, '');
}

function isEcsEnabled() {
  if (process.env.ANTLEROFFICE_AUTH_MOCK === '1') return false;
  return !!ecsBaseUrl();
}

function desktopRedirectUri() {
  const port = process.env.PORT || 3020;
  return (
    process.env.ECS_OAUTH_REDIRECT_URI ||
    `http://127.0.0.1:${port}/api/boss/auth/oauth/callback`
  );
}

function startDesktopOAuth() {
  const base = ecsBaseUrl();
  if (!base) return { ok: false, error: 'ECS_BASE_URL not configured' };

  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { expiresAt: Date.now() + 10 * 60 * 1000 });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.ECS_OAUTH_CLIENT_ID || 'antleroffice-desktop',
    redirect_uri: desktopRedirectUri(),
    state,
  });

  return {
    ok: true,
    state,
    authorizeUrl: `${base}/oauth/authorize?${params.toString()}`,
    redirectUri: desktopRedirectUri(),
  };
}

function consumeState(state) {
  const entry = oauthStates.get(state);
  oauthStates.delete(state);
  if (!entry || entry.expiresAt < Date.now()) return false;
  return true;
}

async function exchangeCode(code, state) {
  if (!consumeState(state)) {
    throw new Error('Invalid or expired OAuth state');
  }
  const base = ecsBaseUrl();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(code),
    client_id: process.env.ECS_OAUTH_CLIENT_ID || 'antleroffice-desktop',
    redirect_uri: desktopRedirectUri(),
  });
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Token exchange failed (${res.status})`);
  }
  return data;
}

module.exports = {
  ecsBaseUrl,
  isEcsEnabled,
  desktopRedirectUri,
  startDesktopOAuth,
  exchangeCode,
};
