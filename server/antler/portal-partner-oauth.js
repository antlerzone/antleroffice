// VIP partner portal OAuth (Coliving, AntlerChat, AntlerHub) — hire gate + MCP API credentials.

const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');

const OAUTH_MESSAGE_TYPE = 'antleroffice-portal-oauth';

const PARTNERS = {
  coliving: {
    id: 'coliving',
    label: 'Coliving JB',
    ecsEnv: ['COLIVING_ECS_BASE_URL', 'COLIVING_MCP_URL', 'COLIVING_API_BASE_URL'],
    ecsDefault: 'https://api.colivingjb.com',
    billingProduct: 'coliving',
    connectionFile: 'portal-oauth-coliving.json',
    legacyConnectionFile: 'coliving-oauth-connection.json',
    docsUrl: 'https://portal.colivingjb.com/docs?tab=mcp',
    templateIds: ['vip_coliving_admin'],
    hireRequirementKey: 'colivingOAuth',
  },
  antlerchat: {
    id: 'antlerchat',
    label: 'AntlerChat',
    ecsEnv: ['ANTLERCHAT_ECS_BASE_URL', 'ANTLERZONE_ECS_BASE_URL', 'ECS_BASE_URL'],
    ecsDefault: 'https://api.antlerzone.com',
    billingProduct: 'antlerchat',
    connectionFile: 'portal-oauth-antlerchat.json',
    docsUrl: 'https://chat.antlerzone.com/docs?tab=mcp',
    templateIds: ['vip_antlerchat_cs'],
    hireRequirementKey: 'antlerchatOAuth',
  },
  antlerhub: {
    id: 'antlerhub',
    label: 'AntlerHub',
    ecsEnv: ['ANTLERHUB_ECS_BASE_URL', 'ANTLERZONE_ECS_BASE_URL', 'ECS_BASE_URL'],
    ecsDefault: 'https://api.antlerzone.com',
    billingProduct: 'homestay',
    connectionFile: 'portal-oauth-antlerhub.json',
    docsUrl: 'https://system.antlerzone.com/docs?tab=mcp',
    templateIds: ['vip_antlerhub_admin'],
    hireRequirementKey: 'antlerhubOAuth',
  },
};

let pendingPartnerId = null;

function partnerConfig(partnerId) {
  const id = String(partnerId || '').trim().toLowerCase();
  return PARTNERS[id] || null;
}

function listPartners() {
  return Object.values(PARTNERS);
}

function ecsBase(partnerId) {
  const cfg = partnerConfig(partnerId);
  if (!cfg) throw new Error('Unknown partner');
  for (const key of cfg.ecsEnv) {
    const val = process.env[key];
    if (val && String(val).trim()) return String(val).trim().replace(/\/+$/, '');
  }
  return cfg.ecsDefault;
}

function apiBase(partnerId) {
  const base = ecsBase(partnerId);
  return base.endsWith('/api') ? base : `${base}/api`;
}

function desktopFrontendOrigin() {
  const fromEnv =
    process.env.PORTAL_OAUTH_FRONTEND ||
    process.env.COLIVING_OAUTH_FRONTEND ||
    process.env.OAUTH_FRONTEND_ORIGIN ||
    process.env.DEV_FRONTEND_URL;
  if (fromEnv) return String(fromEnv).replace(/\/+$/, '');
  const port = process.env.PORT || 3020;
  return `http://127.0.0.1:${port}`;
}

function connectionPath(partnerId) {
  const cfg = partnerConfig(partnerId);
  if (!cfg) throw new Error('Unknown partner');
  return path.join(getDataDir(), cfg.connectionFile);
}

function readConnection(partnerId) {
  const cfg = partnerConfig(partnerId);
  if (!cfg) return null;
  const paths = [connectionPath(partnerId)];
  if (cfg.legacyConnectionFile) {
    paths.push(path.join(getDataDir(), cfg.legacyConnectionFile));
  }
  for (const p of paths) {
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (data?.email && data?.apiUsername && data?.apiToken) return data;
    } catch {
      /* try next */
    }
  }
  return null;
}

function writeConnection(partnerId, data) {
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(connectionPath(partnerId), JSON.stringify(data, null, 2), 'utf8');
}

function isConnected(partnerId) {
  return !!readConnection(partnerId);
}

function authHeaders(partnerId) {
  const conn = readConnection(partnerId);
  if (!conn?.apiToken || !conn?.apiUsername) return null;
  return {
    Authorization: `Bearer ${conn.apiToken}`,
    'X-API-Username': conn.apiUsername,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function setPendingPartner(partnerId) {
  pendingPartnerId = partnerConfig(partnerId) ? String(partnerId).toLowerCase() : null;
}

function consumePendingPartner(fallback = 'coliving') {
  const p = pendingPartnerId || fallback;
  pendingPartnerId = null;
  return partnerConfig(p) ? p : 'coliving';
}

function buildOAuthStartUrl(partnerId, provider = 'google') {
  const cfg = partnerConfig(partnerId);
  if (!cfg) throw new Error('Unknown partner');
  setPendingPartner(partnerId);
  const p = provider === 'facebook' ? 'facebook' : 'google';
  const frontend = desktopFrontendOrigin();
  const params = new URLSearchParams({ frontend });
  return `${ecsBase(partnerId)}/api/portal-auth/${p}?${params.toString()}`;
}

async function verifyPortalToken(partnerId, token) {
  const res = await fetch(
    `${ecsBase(partnerId)}/api/portal-auth/verify?token=${encodeURIComponent(String(token))}`,
    { signal: AbortSignal.timeout(15000) },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok || !data.email) {
    throw new Error(data?.reason || data?.error || `${partnerConfig(partnerId)?.label || 'Portal'} sign-in failed`);
  }
  return { email: String(data.email).trim(), roles: data.roles || [], portalToken: String(token) };
}

async function fetchApiCredentials(partnerId, email) {
  const cfg = partnerConfig(partnerId);
  const res = await fetch(`${apiBase(partnerId)}/billing/api-docs-my-access`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, product: cfg.billingProduct }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data?.hasAccess || !data?.user?.username || !data?.user?.token) {
    const err = new Error(
      `Your ${cfg.label} account has no MCP API access. Enable API Docs for your operator (see ${cfg.docsUrl}).`,
    );
    err.code = 'PORTAL_API_ACCESS_DENIED';
    throw err;
  }
  return {
    apiUsername: String(data.user.username),
    apiToken: String(data.user.token),
  };
}

async function completeOAuth(partnerId, portalToken) {
  const cfg = partnerConfig(partnerId);
  if (!cfg) throw new Error('Unknown partner');
  const verified = await verifyPortalToken(partnerId, portalToken);
  const creds = await fetchApiCredentials(partnerId, verified.email);
  const saved = {
    partner: partnerId,
    email: verified.email,
    roles: verified.roles,
    apiUsername: creds.apiUsername,
    apiToken: creds.apiToken,
    portalToken: verified.portalToken,
    billingProduct: cfg.billingProduct,
    connectedAt: Date.now(),
  };
  writeConnection(partnerId, saved);
  return {
    ok: true,
    partner: partnerId,
    email: saved.email,
    apiUsername: saved.apiUsername,
    connectedAt: saved.connectedAt,
  };
}

function publicStatus(partnerId) {
  const cfg = partnerConfig(partnerId);
  const conn = readConnection(partnerId);
  if (!conn) {
    return { connected: false, partner: partnerId, label: cfg?.label || partnerId, docsUrl: cfg?.docsUrl || null };
  }
  return {
    connected: true,
    partner: partnerId,
    label: cfg?.label || partnerId,
    docsUrl: cfg?.docsUrl || null,
    email: conn.email,
    apiUsername: conn.apiUsername,
    connectedAt: conn.connectedAt || null,
  };
}

function partnerForTemplate(template = {}) {
  for (const cfg of listPartners()) {
    if (cfg.templateIds.includes(template.id)) return cfg.id;
    const req = template.hireRequirements || template.configJson?.hireRequirements;
    if (req?.[cfg.hireRequirementKey]) return cfg.id;
  }
  return null;
}

function templateRequiresPortalOAuth(template = {}) {
  return !!partnerForTemplate(template);
}

function templatePortalOAuthConnected(template = {}) {
  const partner = partnerForTemplate(template);
  return partner ? isConnected(partner) : true;
}

function callbackHtml({ partnerId, token, error }) {
  const cfg = partnerConfig(partnerId) || PARTNERS.coliving;
  const frontendOrigin = desktopFrontendOrigin();
  const payload = JSON.stringify({
    type: OAUTH_MESSAGE_TYPE,
    partner: partnerId,
    ok: !error && !!token,
    error: error || '',
  });
  const title = error ? `${cfg.label} sign-in failed` : `${cfg.label} sign-in`;
  const message = error
    ? String(error)
    : token
      ? `Completing ${cfg.label} connection…`
      : 'Missing sign-in token.';

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
    <p id="msg">${message.replace(/</g, '&lt;')}</p>
  </div>
  <script>
    (function () {
      var token = ${JSON.stringify(token || '')};
      var partner = ${JSON.stringify(partnerId)};
      var targetOrigin = ${JSON.stringify(frontendOrigin)};
      var payload = ${payload};
      if (token) {
        fetch('/api/config/portal-oauth/' + encodeURIComponent(partner) + '/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ token: token })
        }).then(function (r) { return r.json(); }).then(function (data) {
          payload.ok = !!data.ok;
          payload.error = data.error || '';
          payload.partner = data.partner || partner;
          if (data.ok && data.email) payload.email = data.email;
          notify();
        }).catch(function (e) {
          payload.ok = false;
          payload.error = e && e.message ? e.message : 'Connection failed';
          notify();
        });
      } else {
        notify();
      }
      function notify() {
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage(payload, targetOrigin);
          }
        } catch (e) {}
        var el = document.getElementById('msg');
        if (el) {
          el.textContent = payload.ok
            ? 'Connected. You can close this window.'
            : (payload.error || 'Sign-in failed.');
        }
        setTimeout(function () { window.close(); }, payload.ok ? 800 : 2500);
      }
    })();
  </script>
</body>
</html>`;
}

module.exports = {
  PARTNERS,
  OAUTH_MESSAGE_TYPE,
  listPartners,
  partnerConfig,
  ecsBase,
  apiBase,
  desktopFrontendOrigin,
  buildOAuthStartUrl,
  verifyPortalToken,
  fetchApiCredentials,
  completeOAuth,
  isConnected,
  readConnection,
  authHeaders,
  publicStatus,
  partnerForTemplate,
  templateRequiresPortalOAuth,
  templatePortalOAuthConnected,
  consumePendingPartner,
  callbackHtml,
};
