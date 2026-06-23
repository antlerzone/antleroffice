// Proxy ECS portal auth + adopt ECS access tokens into boss sessions.

const auth = require('./auth');
const store = require('./store');
const desktopHandoff = require('./desktop-auth-handoff.cjs');

function ecsAuthUrl() {
  return auth.ecsAuthUrl();
}

function ecsApiBase() {
  const base = auth.ecsBaseUrl();
  if (!base) throw new Error('ECS_AUTH_URL or ECS_BASE_URL not configured');
  return base;
}

async function proxyEcs(path, init = {}) {
  const base = ecsApiBase();
  if (!base) throw new Error('ECS_AUTH_URL or ECS_BASE_URL not configured');
  const res = await fetch(`${base}${path}`, {
    ...init,
    signal: init.signal || AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function fetchEcsSession(accessToken) {
  const { res: meRes, data: meData } = await proxyEcs('/api/auth/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!meRes.ok) {
    const err = new Error(meData.error || `auth me ${meRes.status}`);
    err.status = meRes.status;
    throw err;
  }

  const { res: offRes, data: offData } = await proxyEcs('/api/offices', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const offices = offRes.ok ? offData.offices || [] : [];

  return {
    accessToken,
    user: meData.user || { id: '', email: '', name: '' },
    offices,
    selectedOfficeId: offices[0]?.id || null,
    isSaasAdmin: !!meData.isSaasAdmin,
    creditBalance: typeof meData.creditBalance === 'number' ? meData.creditBalance : undefined,
  };
}

async function adoptAccessToken(accessToken) {
  const ecs = await fetchEcsSession(accessToken);
  const bossSession = await auth.loginWithEcsToken({
    access_token: accessToken,
    user: ecs.user,
    offices: ecs.offices,
    selectedOfficeId: ecs.selectedOfficeId,
    creditBalance: ecs.creditBalance,
    subscription: ecs.user?.subscription || { plan: 'Pro', status: 'active' },
  });
  if (ecs.selectedOfficeId) {
    store.writeSettings({
      ...store.readSettings(),
      selectedOfficeId: ecs.selectedOfficeId,
    });
  }
  return {
    bossToken: bossSession.token,
    session: auth.publicView(bossSession),
    ...ecs,
  };
}

function rememberDesktopHandoff(adopted) {
  desktopHandoff.setPending({
    accessToken: adopted.accessToken,
    bossToken: adopted.bossToken,
    user: adopted.user,
    offices: adopted.offices,
    selectedOfficeId: adopted.selectedOfficeId,
    isSaasAdmin: adopted.isSaasAdmin,
  });
}

function registerEcsPortalAuthRoutes(app) {
  app.post('/api/ecs/auth/oauth-session', async (req, res) => {
    try {
      const base = ecsAuthUrl();
      if (!base) return res.status(503).json({ ok: false, error: 'ECS auth URL not configured' });
      const { portalToken } = req.body || {};
      if (!portalToken) return res.status(400).json({ ok: false, error: 'portalToken required' });

      const { res: ecsRes, data } = await proxyEcs('/api/auth/oauth-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portalToken }),
      });
      if (!ecsRes.ok || !data.accessToken) {
        return res.status(ecsRes.status || 401).json({
          ok: false,
          error: data.error || 'Could not complete sign-in',
        });
      }

      const adopted = await adoptAccessToken(data.accessToken);
      rememberDesktopHandoff(adopted);
      res.json({ ok: true, ...adopted });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/ecs/auth/login', async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim();
      const password = String(req.body?.password || '');
      if (!email || !password) {
        return res.status(400).json({ ok: false, error: 'Email and password required' });
      }

      const { res: ecsRes, data } = await proxyEcs('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!ecsRes.ok || !data.accessToken) {
        return res.status(ecsRes.status || 401).json({
          ok: false,
          error: data.error || 'Sign in failed',
        });
      }

      const adopted = await adoptAccessToken(data.accessToken);
      rememberDesktopHandoff(adopted);
      res.json({ ok: true, ...adopted });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/ecs/auth/adopt', async (req, res) => {
    try {
      const accessToken = String(req.body?.accessToken || '').trim();
      if (!accessToken) return res.status(400).json({ ok: false, error: 'accessToken required' });
      const adopted = await adoptAccessToken(accessToken);
      rememberDesktopHandoff(adopted);
      res.json({ ok: true, ...adopted });
    } catch (e) {
      const status = e.status === 401 ? 401 : 500;
      res.status(status).json({ ok: false, error: e.message || 'Invalid token' });
    }
  });

  app.get('/api/ecs/auth/desktop-pending', (_req, res) => {
    try {
      const hit = desktopHandoff.takePending();
      if (!hit) return res.json({ ok: true, pending: false });
      res.json({ ok: true, pending: true, ...hit });
    } catch (e) {
      console.error('[ecs/auth] desktop-pending failed:', e);
      res.status(500).json({ ok: false, error: e.message || 'desktop-pending failed' });
    }
  });

  app.get('/api/ecs/auth/me', async (req, res) => {
    try {
      const bossToken = req.headers['x-boss-token'] || req.query.token;
      let token = auth.getEcsAccessToken(bossToken);
      // Recover after server restart: client may still hold a valid ECS access token.
      if (!token && req.headers['x-ecs-access-token']) {
        token = String(req.headers['x-ecs-access-token']).trim();
      }
      if (!token) return res.status(401).json({ ok: false, error: 'Not signed in' });
      const ecs = await fetchEcsSession(token);
      if (bossToken && !auth.session(bossToken)) {
        const adopted = await adoptAccessToken(token);
        return res.json({ ok: true, bossToken: adopted.bossToken, ...ecs });
      }
      res.json({ ok: true, ...ecs });
    } catch (e) {
      res.status(401).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/ecs/offices', async (req, res) => {
    try {
      const token =
        auth.getEcsAccessToken(req.headers['x-boss-token']) ||
        auth.getEcsAccessToken(req.query.token);
      if (!token) return res.status(401).json({ ok: false, error: 'Not signed in' });
      const { res: ecsRes, data } = await proxyEcs('/api/offices', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!ecsRes.ok) return res.status(ecsRes.status).json({ ok: false, error: data.error || 'Failed' });
      res.json({ ok: true, offices: data.offices || [] });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = {
  registerEcsPortalAuthRoutes,
  adoptAccessToken,
  fetchEcsSession,
};
