// MCP OAuth: state storage, authorize URL builder, code exchange, callback HTML.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');

const STATE_TTL_MS = 10 * 60 * 1000;
const STATES_FILE = 'oauth-states.json';

function getRedirectBase() {
  const base =
    process.env.OAUTH_REDIRECT_BASE ||
    process.env.ANTLER_API_BASE ||
    `http://localhost:${process.env.PORT || 3020}`;
  return String(base).replace(/\/+$/, '');
}

function callbackUrl() {
  return `${getRedirectBase()}/api/config/mcps/oauth/callback`;
}

function defaultFrontendOrigin() {
  return (
    process.env.OAUTH_FRONTEND_ORIGIN ||
    process.env.DEV_FRONTEND_URL ||
    'http://127.0.0.1:3020'
  ).replace(/\/+$/, '');
}

function statesPath() {
  return path.join(getDataDir(), STATES_FILE);
}

function readStatesRaw() {
  try {
    const data = JSON.parse(fs.readFileSync(statesPath(), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeStates(states) {
  fs.writeFileSync(statesPath(), JSON.stringify(states, null, 2), 'utf8');
}

function purgeExpired(states) {
  const now = Date.now();
  return states.filter((s) => s && typeof s.expiresAt === 'number' && s.expiresAt > now);
}

function createState({ mcpId, accountId, frontendOrigin }) {
  const states = purgeExpired(readStatesRaw());
  const state = crypto.randomBytes(24).toString('hex');
  const entry = {
    state,
    mcpId,
    accountId,
    redirectUri: callbackUrl(),
    frontendOrigin: frontendOrigin || defaultFrontendOrigin(),
    expiresAt: Date.now() + STATE_TTL_MS,
  };
  states.push(entry);
  writeStates(states);
  return entry;
}

function consumeState(state) {
  if (!state) return null;
  const states = purgeExpired(readStatesRaw());
  const idx = states.findIndex((s) => s.state === state);
  if (idx < 0) return null;
  const entry = states[idx];
  states.splice(idx, 1);
  writeStates(states);
  return entry;
}

function buildAuthorizeUrl({ authorizeUrl, clientId, scopes, state, redirectUri }) {
  const u = new URL(authorizeUrl);
  if (!u.searchParams.has('response_type')) u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  if (scopes && !u.searchParams.has('scope')) u.searchParams.set('scope', scopes);
  return u.toString();
}

async function exchangeCodeForToken({ tokenUrl, code, clientId, clientSecret, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(code),
    client_id: clientId,
    redirect_uri: redirectUri,
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });

  let data = {};
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg =
      (data && (data.error_description || data.error)) ||
      `Token exchange failed (HTTP ${res.status})`;
    throw new Error(typeof msg === 'string' ? msg : 'Token exchange failed');
  }

  return data;
}

function resolveFrontendOrigin(req, body) {
  if (body && typeof body.frontendOrigin === 'string' && body.frontendOrigin.trim()) {
    return body.frontendOrigin.trim().replace(/\/+$/, '');
  }
  const referer = req?.headers?.referer || req?.headers?.origin;
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      /* ignore */
    }
  }
  return defaultFrontendOrigin();
}

function startOAuth({ mcpId, accountId, account, frontendOrigin }) {
  const oauth = account?.auth?.oauth || {};
  const clientId = oauth.clientId?.trim();
  const authorizeUrl = oauth.authorizeUrl?.trim();
  const tokenUrl = oauth.tokenUrl?.trim();
  const scopes = oauth.scopes?.trim() || '';

  if (!clientId) return { ok: false, error: 'OAuth client ID is required' };
  if (!authorizeUrl) return { ok: false, error: 'OAuth authorize URL is required' };
  if (!tokenUrl) return { ok: false, error: 'OAuth token URL is required' };

  const stateEntry = createState({ mcpId, accountId, frontendOrigin });
  const fullAuthorizeUrl = buildAuthorizeUrl({
    authorizeUrl,
    clientId,
    scopes,
    state: stateEntry.state,
    redirectUri: stateEntry.redirectUri,
  });

  return {
    ok: true,
    state: stateEntry.state,
    authorizeUrl: fullAuthorizeUrl,
    redirectUri: stateEntry.redirectUri,
  };
}

async function handleCallback({ code, state, registry }) {
  if (!code || !state) {
    return { ok: false, error: 'Missing authorization code or state' };
  }

  const stateEntry = consumeState(String(state));
  if (!stateEntry) {
    return { ok: false, error: 'Invalid or expired OAuth state — start login again' };
  }

  const account = registry.getMcpAccount(stateEntry.mcpId, stateEntry.accountId);
  if (!account) {
    return { ok: false, error: 'MCP account not found' };
  }

  const oauth = account.auth?.oauth || {};
  try {
    const tokenData = await exchangeCodeForToken({
      tokenUrl: oauth.tokenUrl,
      code: String(code),
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      redirectUri: stateEntry.redirectUri,
    });

    const patch = {
      authType: 'oauth',
      auth: {
        oauth: {
          accessToken: tokenData.access_token || '',
          refreshToken: tokenData.refresh_token || oauth.refreshToken || '',
        },
      },
    };
    if (tokenData.scope && !oauth.scopes) {
      patch.auth.oauth.scopes = tokenData.scope;
    }

    const result = registry.connectMcpAccountAuth(
      stateEntry.mcpId,
      stateEntry.accountId,
      patch,
    );
    if (!result) {
      return { ok: false, error: 'Could not save OAuth tokens' };
    }

    return {
      ok: true,
      mcpId: stateEntry.mcpId,
      accountId: stateEntry.accountId,
      frontendOrigin: stateEntry.frontendOrigin,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'OAuth callback failed',
      frontendOrigin: stateEntry.frontendOrigin,
    };
  }
}

function callbackHtml(result) {
  const payload = JSON.stringify({
    type: 'antleroffice-mcp-oauth',
    ok: !!result.ok,
    mcpId: result.mcpId || '',
    accountId: result.accountId || '',
    error: result.error || '',
  });
  const targetOrigin = result.frontendOrigin || defaultFrontendOrigin();
  const title = result.ok ? 'Login complete' : 'Login failed';
  const message = result.ok
    ? 'MCP account connected. This window will close automatically.'
    : String(result.error || 'OAuth login failed.');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f1115; color: #e8eaed; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .box { max-width: 420px; padding: 24px; border: 1px solid #2a2f3a; border-radius: 12px; background: #171a21; text-align: center; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    p { margin: 0; color: #9aa0a6; font-size: 14px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="box">
    <h1>${title}</h1>
    <p>${message.replace(/</g, '&lt;')}</p>
  </div>
  <script>
    (function () {
      var payload = ${payload};
      var targetOrigin = ${JSON.stringify(targetOrigin)};
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, targetOrigin);
        }
      } catch (e) {}
      setTimeout(function () { window.close(); }, 800);
    })();
  </script>
</body>
</html>`;
}

module.exports = {
  callbackUrl,
  getRedirectBase,
  defaultFrontendOrigin,
  resolveFrontendOrigin,
  startOAuth,
  handleCallback,
  callbackHtml,
  buildAuthorizeUrl,
  exchangeCodeForToken,
};
