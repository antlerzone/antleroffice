const os = require('node:os');
const auth = require('./auth');
const store = require('./store');
const ecssync = require('./ecs-sync');
const ecsSubscriptions = require('./ecs-subscriptions');
const openclaw = require('./openclaw-config');
const desktopRelay = require('./desktop-relay-client.cjs');

function resolveDesktopDisplayName() {
  const custom = String(store.readSettings().office?.desktopDisplayName || '').trim();
  if (custom) return custom;
  return os.hostname();
}

function registerPortalDesktopRoutes(app, hooks = {}) {
  const { reconnectGateway, runBossHeartbeat, disconnectGateway } = hooks;

  async function ecsFetch(pathname, ecsToken, init = {}) {
    const base = auth.ecsBaseUrl();
    if (!base || !ecsToken) return { ok: false, error: 'ECS not configured' };
    const res = await fetch(`${base}${pathname}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${ecsToken}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}`, status: res.status };
    return { ok: true, ...data };
  }

  function bossSession(req) {
    const token = req.headers['x-boss-token'] || req.body?.bossToken || req.query.bossToken;
    return auth.session(token);
  }

  app.get('/api/portal/desktops', async (req, res) => {
    try {
      const s = bossSession(req);
      if (!s?.ecsAccessToken) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      ecssync.rememberEcsToken(s.ecsAccessToken);
      const localId = ecssync.desktopId();
      const data = await ecsFetch(`/api/desktops?localDesktopId=${encodeURIComponent(localId)}`, s.ecsAccessToken);
      if (!data.ok) return res.status(data.status || 500).json(data);
      const settings = store.readSettings();
      const owned = (data.owned || []).map((d) => ({
        ...d,
        isLocal: d.desktopId === localId,
        isCurrent: settings.activeDesktopId === d.desktopId || (!settings.activeDesktopId && d.desktopId === localId),
      }));
      const shared = (data.shared || []).map((d) => ({
        ...d,
        isLocal: false,
        isCurrent: settings.activeDesktopId === d.desktopId,
        shared: true,
      }));
      res.json({
        ok: true,
        localDesktopId: localId,
        localBindStatus: data.localBindStatus || 'unbound',
        owned,
        shared,
        desktops: [...owned, ...shared],
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.patch('/api/portal/desktops/:desktopId', async (req, res) => {
    try {
      const s = bossSession(req);
      if (!s?.ecsAccessToken) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const data = await ecsFetch(`/api/desktops/${encodeURIComponent(req.params.desktopId)}`, s.ecsAccessToken, {
        method: 'PATCH',
        body: JSON.stringify({ displayName: req.body?.displayName }),
      });
      if (!data.ok) return res.status(data.status || 500).json(data);
      res.json(data);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/portal/desktops/:desktopId/share/accept', async (req, res) => {
    try {
      const s = bossSession(req);
      if (!s?.ecsAccessToken) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const data = await ecsFetch(
        `/api/desktops/${encodeURIComponent(req.params.desktopId)}/share/accept`,
        s.ecsAccessToken,
        { method: 'POST' },
      );
      if (!data.ok) return res.status(data.status || 500).json(data);
      res.json(data);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/portal/desktops/:desktopId/share/reject', async (req, res) => {
    try {
      const s = bossSession(req);
      if (!s?.ecsAccessToken) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const data = await ecsFetch(
        `/api/desktops/${encodeURIComponent(req.params.desktopId)}/share/reject`,
        s.ecsAccessToken,
        { method: 'POST' },
      );
      if (!data.ok) return res.status(data.status || 500).json(data);
      res.json(data);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/portal/desktops/manual', async (req, res) => {
    try {
      const s = bossSession(req);
      if (!s?.ecsAccessToken) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const data = await ecsFetch('/api/desktops/manual', s.ecsAccessToken, {
        method: 'POST',
        body: JSON.stringify(req.body || {}),
      });
      if (!data.ok) return res.status(data.status || 500).json(data);
      res.json(data);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/gateway/test', async (req, res) => {
    try {
      const { gatewayWsUrl, gatewayAuthToken, gatewayAuthPassword } = req.body || {};
      if (!gatewayWsUrl) return res.status(400).json({ ok: false, error: 'gatewayWsUrl required' });
      const WebSocket = require('ws');
      const authParam = gatewayAuthToken || gatewayAuthPassword || '';
      const url = authParam
        ? `${gatewayWsUrl}${gatewayWsUrl.includes('?') ? '&' : '?'}auth=${encodeURIComponent(authParam)}`
        : gatewayWsUrl;
      const result = await new Promise((resolve) => {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => {
          ws.terminate();
          resolve({ ok: false, error: 'timeout' });
        }, 8000);
        ws.on('open', () => {
          clearTimeout(timer);
          ws.close();
          resolve({ ok: true });
        });
        ws.on('error', (err) => {
          clearTimeout(timer);
          resolve({ ok: false, error: err.message });
        });
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/gateway/connect', async (req, res) => {
    try {
      const s = bossSession(req);
      if (!s) return res.status(401).json({ ok: false, error: 'Unauthorized' });

      const mode = req.body?.mode;
      const settings = store.readSettings();
      let wsUrl;
      let token;
      let password;
      let activeDesktopId = null;
      let officeId = settings.selectedOfficeId || null;
      let bindCreated = false;

      if (mode === 'local') {
        wsUrl = process.env.OPENCLAW_WS_URL || 'ws://127.0.0.1:18789';
        token = process.env.OPENCLAW_AUTH_TOKEN || '';
        password = process.env.OPENCLAW_AUTH_PASSWORD || '';
        activeDesktopId = ecssync.desktopId();
      } else {
        const desktopId = req.body?.desktopId;
        if (!desktopId) return res.status(400).json({ ok: false, error: 'desktopId required' });
        if (!s.ecsAccessToken) return res.status(401).json({ ok: false, error: 'ECS login required' });
        const data = await ecsFetch(`/api/desktops/${encodeURIComponent(desktopId)}`, s.ecsAccessToken);
        if (!data.ok || !data.desktop) return res.status(404).json({ ok: false, error: 'Desktop not found' });
        const desk = data.desktop;
        wsUrl = desk.gatewayWsUrl || desk.gateway_ws_url;
        token = desk.gatewayAuthToken || desk.gateway_auth_token || '';
        password = desk.gatewayAuthPassword || desk.gateway_auth_password || '';
        activeDesktopId = desktopId;
        officeId = desk.officeId || desk.office_id || officeId;
        if (!wsUrl) return res.status(400).json({ ok: false, error: 'Gateway URL not registered for this desktop' });
        // Phase 2 / A1: direct connection to the owner's public gateway —
        // present OUR per-share token so their inbound gateway can authorize us.
        // ECS relay URLs contain "/relay/desktop/" and keep the legacy auth path.
        const shareToken = data.share?.accessToken || data.share?.access_token || '';
        if (shareToken && !/\/relay\/desktop\//.test(wsUrl)) {
          wsUrl = `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(shareToken)}`;
        }
      }

      if (typeof reconnectGateway === 'function') {
        await reconnectGateway({
          wsUrl,
          token,
          password,
          ecsToken: s.ecsAccessToken || '',
        });
      }

      if (mode === 'local' && s.ecsAccessToken) {
        desktopRelay.startFromBossSession(s);
        await desktopRelay.waitForRelay(4000);
        const relayUrl = desktopRelay.getPublicGatewayUrl() || wsUrl;
        const pkgVersion = require('../../package.json').version;
        const bindRes = await ecsFetch('/api/desktops/bind', s.ecsAccessToken, {
          method: 'POST',
          body: JSON.stringify({
            desktopId: activeDesktopId,
            displayName: resolveDesktopDisplayName(),
            hostname: os.hostname(),
            platform: process.platform,
            gatewayWsUrl: relayUrl,
            gatewayAuthToken: token,
            gatewayAuthPassword: password,
            antlerVersion: pkgVersion,
          }),
        });
        if (!bindRes.ok) {
          const status = bindRes.status || (bindRes.code === 'DESKTOP_OWNED_BY_OTHER' ? 409 : 400);
          return res.status(status).json({
            ok: false,
            error: bindRes.error || 'Could not bind this computer',
            code: bindRes.code,
          });
        }
        officeId = bindRes.officeId || officeId;
        bindCreated = !!bindRes.created;
        store.writeSettings({
          ...store.readSettings(),
          selectedOfficeId: officeId,
          activeDesktopId,
        });
        const bossToken = req.headers['x-boss-token'] || req.body?.bossToken;
        if (typeof runBossHeartbeat === 'function' && bossToken) {
          await runBossHeartbeat(bossToken).catch(() => {});
        }
      } else {
        store.writeSettings({
          ...settings,
          selectedOfficeId: officeId || settings.selectedOfficeId,
          activeDesktopId,
        });
      }

      res.json({
        ok: true,
        mode: mode || 'remote',
        activeDesktopId,
        officeId,
        gatewayWsUrl: wsUrl,
        created: bindCreated,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/portal/desktops/unbind-local', async (req, res) => {
    try {
      const s = bossSession(req);
      if (!s?.ecsAccessToken) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const desktopId = ecssync.desktopId();
      const data = await ecsFetch(`/api/desktops/${encodeURIComponent(desktopId)}/bind`, s.ecsAccessToken, {
        method: 'DELETE',
      });
      if (!data.ok) {
        return res.status(data.status || 400).json({ ok: false, error: data.error || 'Unbind failed', code: data.code });
      }
      if (typeof disconnectGateway === 'function') {
        try {
          await disconnectGateway();
        } catch {
          /* ignore */
        }
      }
      const nextDesktopId = ecssync.resetDesktopId();
      const settings = store.readSettings();
      store.writeSettings({
        ...settings,
        selectedOfficeId: null,
        activeDesktopId: null,
      });
      res.json({
        ok: true,
        previousDesktopId: desktopId,
        desktopId: nextDesktopId,
        officeId: data.officeId,
        creditBalanceRemoved:
          typeof data.creditBalanceRemoved === 'number' ? data.creditBalanceRemoved : 0,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/portal/local-status', async (_req, res) => {
    try {
      const probe = await openclaw.gatewayProbeReliable({ attempts: 2, delayMs: 800 });
      res.json({
        ok: true,
        desktopId: ecssync.desktopId(),
        hostname: os.hostname(),
        gateway: probe,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { registerPortalDesktopRoutes };
