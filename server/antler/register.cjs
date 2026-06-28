const path = require('node:path');
const fs = require('node:fs');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const office = require('./office-state');
const store = require('./store');
const roster = require('./roster');
const registry = require('./registry-store');
const auth = require('./auth');
const rag = require('./rag');
const memory = require('./memory-store');
const onboard = require('./onboard');
const defaultMcpPack = require('./default-mcp-pack');
const ecssync = require('./ecs-sync');
const ecsCatalog = require('./ecs-catalog');
const ecsAuth = require('./ecs-auth');
const ecsSubscriptions = require('./ecs-subscriptions');
const officeShare = require('./office-share');
const officeMemberAuth = require('./office-member-auth');
const officeEvents = require('./office-events');
const openclaw = require('./openclaw-config');
const debugLog = require('./debug-log');
const portalDesktops = require('./portal-desktops.cjs');
const desktopRelay = require('./desktop-relay-client.cjs');
const appUpdater = require('./app-updater.cjs');
const billing = require('./billing');
const payroll = require('./payroll');
const agentCatalog = require('./agent-catalog');
const payslip = require('./payslip.cjs');
const skillInstallLog = require('./skill-install-log');
const agentUsageStore = require('./agent-usage-store');
const workerEntitlements = require('./worker-entitlements');
const taskMeter = require('./task-meter');
const mcpProbe = require('./mcp-probe');
const mcpOAuth = require('./mcp-oauth');
const { handleInstruction, savePlanDeliverable } = require('./agent-runtime');
const bossChat = require('./boss-chat-store');
const antlerofficeMcp = require('./antleroffice-mcp');
const webAccounts = require('./web-accounts-store');
const bundleRequiredAccounts = require('./bundle-required-accounts.cjs');
const retellStore = require('./retell-store');
const browserCapture = require('./browser-capture-engine');
const materials = require('./materials.cjs');
const adminVault = require('./admin-vault');
const { attachPaBridge, getOfficePresence } = require('./pa-bridge');
const gatewayOfficeAdapter = require('./gateway-office-adapter');
const ecsPortalAuth = require('./ecs-portal-auth');
const voiceService = require('./voice-service');
const standupConfig = require('./daily-standup-config-store');
const departmentStandup = require('./department-standup-service');
const dailyStandupScheduler = require('./daily-standup-scheduler');
const cooHeartbeatConfig = require('./coo-heartbeat-config-store');
const cooHeartbeat = require('./coo-heartbeat-service');
const cooHeartbeatScheduler = require('./coo-heartbeat-scheduler');
const cooAutonomousLoop = require('./coo-autonomous-loop');
const ceoDailyPayrollScheduler = require('./ceo-daily-payroll-scheduler');
const standupPdf = require('./standup-pdf-export');
const orgRoles = require('./org-roles');
const ceoPricing = require('./ceo-pricing');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function prepareOAuthAccount(registry, mcpId, accountId, body = {}) {
  const m = registry.getMcp(mcpId);
  if (!m) return null;
  let accId = accountId;
  if (!accId) {
    accId = m.defaultAccountId || m.accounts[0]?.id;
    if (!accId) {
      const created = registry.addMcpAccount(mcpId, {
        label: body.label || 'Default',
        authType: body.authType || 'oauth',
      });
      if (!created) return null;
      accId = created.account.id;
    }
  }
  if (body.auth || body.authType || body.label) {
    registry.updateMcpAccount(mcpId, accId, body);
  }
  const account = registry.getMcpAccount(mcpId, accId);
  return account ? { accountId: accId, account } : null;
}

function handleMcpOAuthStart(req, res, mcpId, accountId) {
  const body = req.body || {};
  const prepared = prepareOAuthAccount(registry, mcpId, accountId, body);
  if (!prepared) return res.status(404).json({ ok: false, error: 'MCP or account not found' });

  const oauthResult = mcpOAuth.startOAuth({
    mcpId,
    accountId: prepared.accountId,
    account: prepared.account,
    frontendOrigin: mcpOAuth.resolveFrontendOrigin(req, body),
  });
  if (!oauthResult.ok) {
    return res.status(400).json({ ok: false, error: oauthResult.error || 'Could not start OAuth' });
  }
  res.json({
    ok: true,
    accountId: prepared.accountId,
    state: oauthResult.state,
    authorizeUrl: oauthResult.authorizeUrl,
    redirectUri: oauthResult.redirectUri,
  });
}

function resolveBossAuthor(req) {
  return resolveBossOwner(req).ownerName;
}

function resolveBossOwner(req) {
  const token = req.headers['x-boss-token'] || (req.body || {}).bossToken;
  if (token) {
    const s = auth.session(String(token));
    if (s?.user?.id) {
      return {
        ownerKey: `user:${s.user.id}`,
        ownerName: resolveBossDisplayName(s),
      };
    }
    if (s?.user?.email) {
      return {
        ownerKey: `email:${s.user.email}`,
        ownerName: resolveBossDisplayName(s),
      };
    }
  }
  if (req.officeMember?.userId) {
    return {
      ownerKey: `user:${req.officeMember.userId}`,
      ownerName: req.officeMember.name || 'Member',
    };
  }
  return { ownerKey: 'local:boss', ownerName: resolveBossDisplayName(null) };
}

function requireBossOnly(req, res, next) {
  if (req.officeMember && req.officeMember.role !== 'owner') {
    return res.status(403).json({ ok: false, error: 'Boss only' });
  }
  next();
}

function requireBossOnlyRoute(req, res) {
  if (req.officeMember && req.officeMember.role !== 'owner') {
    res.status(403).json({ ok: false, error: 'Boss only' });
    return false;
  }
  return true;
}

function resolveEcsBillingContext(req) {
  const token = req.headers['x-boss-token'] || (req.body || {}).bossToken;
  const s = token ? auth.session(String(token)) : null;
  const settings = store.readSettings();
  const officeId = settings.selectedOfficeId || s?.offices?.[0]?.id || null;
  return {
    ecsToken: s?.ecsAccessToken || null,
    officeId,
    session: s,
  };
}

function registerAntlerRoutes(app, hooks = {}) {
  store.setDataDir();
  materials.ensureDefaultMaterialsRoot();
  adminVault.ensureVaultStructure();
  antlerofficeMcp.attachMcpRoutes(app);
  defaultMcpPack.ensureAntlerofficeToolsBinding().catch((e) => {
    console.warn('[AntlerOffice] antleroffice-tools MCP bind:', e.message);
  });
  try {
    openclaw.ensureValidOpenClawConfig();
  } catch {
    /* openclaw config may not exist yet */
  }

  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/') || req.path.startsWith('/api/debug/log')) return next();
    const t0 = Date.now();
    const bodyHint =
      req.method !== 'GET' && req.body && Object.keys(req.body).length
        ? ` ${JSON.stringify(req.body).slice(0, 280)}`
        : '';
    debugLog.logInfo('ui→api', `${req.method} ${req.path}${bodyHint}`);
    res.on('finish', () => {
      const level = res.statusCode >= 400 ? 'warn' : 'ok';
      debugLog[level === 'ok' ? 'logOk' : 'logWarn']('api', `${req.method} ${req.path} → ${res.statusCode} (${Date.now() - t0}ms)`);
    });
    next();
  });

  app.use(async (req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    try {
      await officeMemberAuth.attachOfficeMember(req);
      next();
    } catch (e) {
      next(e);
    }
  });

  app.use(officeMemberAuth.enforceOfficeAccess);

  app.get('/api/debug/log', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 400);
    res.json({ lines: debugLog.list({ limit }) });
  });
  app.delete('/api/debug/log', (_req, res) => {
    debugLog.clear();
    res.json({ ok: true });
  });
  app.post('/api/debug/event', (req, res) => {
    const { action, detail } = req.body || {};
    if (action) debugLog.logInfo('ui', String(action), detail ? String(detail) : undefined);
    res.json({ ok: true });
  });

  // Boot NPCs: roster.defaults() is now empty — new users start with an empty
  // office and hire a COO from Browse. (Loop kept in case defaults() is repopulated.)
  for (const d of roster.defaults()) {
    const a = office.ensureRole(d.role, d.label, d.charSprite);
    const saved = registry.getBuiltinAgentSettings(d.role);
    const bootPatch = {};
    if (saved.label) bootPatch.label = saved.label;
    if (Number.isInteger(saved.sprite)) bootPatch.charSprite = saved.sprite;
    if (Number.isInteger(saved.hueShift)) bootPatch.hueShift = saved.hueShift;
    if (d.role === 'secretary') bootPatch.openclawAgentId = 'main';
    if (Object.keys(bootPatch).length) office.setAgent(a.id, bootPatch);
  }

  // Grandfather: existing users (used the app before the "empty office" change)
  // keep their free COO; brand-new users stay empty. Decided once, then persisted.
  const officeFlags = require('./office-flags');
  let _officeFlags = officeFlags.read();
  if (!_officeFlags.cooDecisionMade) {
    _officeFlags = officeFlags.write({
      cooDecisionMade: true,
      keepGrandfatheredCoo: officeFlags.looksLikeExistingInstall(),
    });
  }
  if (_officeFlags.keepGrandfatheredCoo && !office.getAgent('coo')) {
    const cooStation = office.ensureRole('coo', 'COO', 5);
    office.setAgent(cooStation.id, {
      label: 'COO',
      npcState: 'resting',
      bubbleText: '',
      openclawAgentId: 'main',
    });
  }

  orgRoles.migrateOfficeAgents();
  // Hydrate user-created agents persisted from previous sessions.
  office.loadUserAgents(registry.listAgents());
  agentCatalog.migrateHiredCeoSkills();
  ceoPricing.syncHiredCeoAgent();
  for (const a of registry.listAgents()) {
    if (a.payrollStatus === 'suspended') payroll.syncOfficePayroll(a);
  }

  async function refreshBillingAndFires() {
    try {
      await payroll.processPendingFires(openclaw);
      payroll.runPayrollDue();
      const paygoMeter = require('./paygo-meter');
      await paygoMeter.flushPendingCharges();
      await paygoMeter.tickActiveSessions();
    } catch (e) {
      debugLog.logWarn('payroll', e.message);
    }
    auth.refreshAllSessionCredits();
  }

  async function syncEcsSubscriptionsFromHeartbeat(subscriptions = []) {
    try {
      require('./paygo-meter').syncAgentsFromEcsSubscriptions(subscriptions);
    } catch {
      /* optional */
    }
  }

  async function applyEcsPayrollResults(results = []) {
    for (const r of results) {
      const sub = r.subscription;
      const localId = sub?.localAgentId;
      if (r.action === 'fired' && localId) {
        const agent = registry.getAgent(localId);
        if (agent) await payroll.terminateAgent(agent, { openclaw });
        continue;
      }
      if (!localId) continue;
      const agent = registry.getAgent(localId);
      if (!agent) continue;
      if (sub.status === 'suspended' || r.error === 'INSUFFICIENT_CREDITS') {
        const updated = registry.updateAgent(localId, { payrollStatus: 'suspended' });
        if (updated) payroll.syncOfficePayroll(updated);
      } else if (sub.status === 'active') {
        registry.updateAgent(localId, {
          payrollStatus: 'active',
          nextSalaryDueAt: r.nextSalaryDueAt || sub.nextSalaryDueAt,
          ecsSubscriptionId: sub.id || agent.ecsSubscriptionId,
          billingInterval: sub.billingInterval || agent.billingInterval,
        });
        payroll.syncOfficePayroll(registry.getAgent(localId));
      } else if (sub.status === 'pending_termination') {
        registry.updateAgent(localId, {
          payrollStatus: 'pending_termination',
          fireAt: sub.fireAt || agent.fireAt,
          ecsSubscriptionId: sub.id || agent.ecsSubscriptionId,
        });
        payroll.syncOfficeLeaving(registry.getAgent(localId));
      }
    }
  }

  async function runBossHeartbeat(bossToken) {
    await refreshBillingAndFires();
    const s = auth.session(bossToken);
    if (!s) return { ok: false, error: 'no_session' };

    if (s.ecsAccessToken) {
      ecssync.rememberEcsToken(s.ecsAccessToken);
      await auth.refreshSessionFromEcs(s);
      const settings = store.readSettings();
      const officeId =
        settings.selectedOfficeId || (s.offices && s.offices[0]?.id) || null;
      if (officeId) {
        const agents = registry.listAgents()
          .filter((a) => a.templateId)
          .map((a) => ({
            localId: a.id,
            subscriptionId: a.ecsSubscriptionId,
            templateId: a.templateId,
            agentName: a.name,
            payrollStatus: a.payrollStatus,
            nextSalaryDueAt: a.nextSalaryDueAt,
            fireAt: a.fireAt,
          }));
        desktopRelay.startFromBossSession(s);
        const relayUrl = desktopRelay.getPublicGatewayUrl();
        const pkgVersion = require('../../package.json').version;
        const ecsResult = await ecsSubscriptions.payrollHeartbeat({
          ecsToken: s.ecsAccessToken,
          officeId,
          agents,
          gatewayWsUrl: relayUrl || process.env.OPENCLAW_WS_URL || 'ws://127.0.0.1:18789',
          gatewayAuthToken: process.env.OPENCLAW_AUTH_TOKEN || '',
          gatewayAuthPassword: process.env.OPENCLAW_AUTH_PASSWORD || '',
          displayName: resolveDesktopDisplayName(),
          hostname: require('node:os').hostname(),
          platform: process.platform,
          antlerVersion: pkgVersion,
        });
        if (ecsResult.ok) {
          if (typeof ecsResult.creditBalance === 'number') {
            billing.setBalance(ecsResult.creditBalance, { reason: 'ecs_heartbeat' });
            s.creditBalance = ecsResult.creditBalance;
          }
          await applyEcsPayrollResults(ecsResult.payrollResults || []);
          await syncEcsSubscriptionsFromHeartbeat(ecsResult.subscriptions || []);
          await require('./paygo-meter').flushPendingCharges();
        } else if (!ecsResult.skipped) {
          auth.syncSessionCredits(s);
          return { ok: false, error: ecsResult.error || 'ecs_heartbeat_failed', ecsError: ecsResult.error, session: auth.publicView(s) };
        }
      }
    }

    auth.syncSessionCredits(s);
    return { ok: true, session: auth.publicView(s) };
  }
  refreshBillingAndFires();
  setInterval(refreshBillingAndFires, 15 * 60 * 1000).unref();
  setInterval(() => {
    require('./paygo-meter').tickActiveSessions().catch(() => {});
  }, 60 * 1000).unref();
  setInterval(() => payroll.processPendingFires(openclaw).catch(() => {}), 60 * 60 * 1000).unref();

  // Remove imported agents whose desktop stopped sending heartbeats (offline).
  setInterval(() => office.pruneExternal(30000), 10000).unref();

  // Start on-demand ECS sync polling when ECS is configured.
  ecssync.refresh();

  dailyStandupScheduler.start();
  cooHeartbeatScheduler.start();
  cooAutonomousLoop.start();
  ceoDailyPayrollScheduler.start();

  hooks.runBossHeartbeat = (token) => runBossHeartbeat(token);
  portalDesktops.registerPortalDesktopRoutes(app, hooks);

  const pkgVersion = require('../../package.json').version;
  const npcHireLayoutPath = path.join(__dirname, '../../public/npc-hire-layout.json');

  app.get('/api/dev/npc-hire-layout', (_req, res) => {
    try {
      if (!fs.existsSync(npcHireLayoutPath)) {
        return res.status(404).json({ ok: false, error: 'npc-hire-layout.json not found' });
      }
      const layout = JSON.parse(fs.readFileSync(npcHireLayoutPath, 'utf8'));
      res.json({ ok: true, layout });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/dev/npc-hire-layout', (req, res) => {
    try {
      const layout = req.body || {};
      const required = [
        'agentLeft',
        'agentBottom',
        'agentOffsetX',
        'agentOffsetY',
        'agentMaxW',
        'agentMaxH',
        'statsOffsetX',
        'statsOffsetY',
        'scenePosX',
        'scenePosY',
        'sceneSizeH',
      ];
      for (const key of required) {
        if (!Number.isFinite(Number(layout[key]))) {
          return res.status(400).json({ ok: false, error: `Invalid layout field: ${key}` });
        }
      }
      const normalized = Object.fromEntries(required.map((key) => [key, Number(layout[key])]));
      fs.mkdirSync(path.dirname(npcHireLayoutPath), { recursive: true });
      fs.writeFileSync(npcHireLayoutPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      res.json({ ok: true, layout: normalized });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/app/version', (_req, res) => {
    res.json({
      ok: true,
      version: pkgVersion,
      productName: 'AntlerOffice',
      relayConnected: desktopRelay.isRelayConnected(),
      relayGatewayUrl: desktopRelay.getPublicGatewayUrl(),
    });
  });

  app.get('/api/app/update/status', (_req, res) => {
    res.json({ ok: true, currentVersion: pkgVersion, schedule: appUpdater.readSchedule() });
  });

  app.post('/api/app/update/schedule', (req, res) => {
    try {
      const { version, scheduledAt, preApproved } = req.body || {};
      const schedule = appUpdater.writeSchedule({
        pendingVersion: version || null,
        scheduledAt: scheduledAt ? new Date(scheduledAt).getTime() : null,
        preApproved: !!preApproved,
        skippedVersion: null,
        remindAfter: null,
      });
      res.json({ ok: true, schedule });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/app/update/skip', (req, res) => {
    const version = req.body?.version;
    const schedule = appUpdater.writeSchedule({
      skippedVersion: version || null,
      remindAfter: null,
    });
    res.json({ ok: true, schedule });
  });

  app.post('/api/app/update/remind-later', (req, res) => {
    const minutes = Number(req.body?.minutes) || 60;
    const schedule = appUpdater.writeSchedule({
      remindAfter: Date.now() + minutes * 60 * 1000,
    });
    res.json({ ok: true, schedule });
  });

  app.post('/api/app/update/clear-schedule', (_req, res) => {
    res.json({ ok: true, schedule: appUpdater.clearSchedule() });
  });

  setInterval(() => {
    const due = appUpdater.dueScheduledUpdate();
    if (!due) return;
    console.log('[Updater] Scheduled update due for version', due.pendingVersion);
  }, 60 * 1000).unref();

  // ── ECS portal auth (Google/Facebook / desktop adopt) ─────────────────────
  ecsPortalAuth.registerEcsPortalAuthRoutes(app);

  // ── Boss auth (credits/subscription — separate from Admin /api/auth) ───────
  app.post('/api/boss/auth/login', async (req, res) => {
    try {
      const s = await auth.login(req.body || {});
      res.json({ ok: true, token: s.token, session: auth.publicView(s) });
    } catch (e) {
      res.status(401).json({ ok: false, error: e.message });
    }
  });
  app.get('/api/boss/auth/session', async (req, res) => {
    const token = req.query.token;
    if (token) await runBossHeartbeat(token).catch(() => {});
    let s = auth.session(token);
    if (!s) return res.json({ ok: false });
    if (s.ecsAccessToken) {
      s = await auth.refreshSessionFromEcs(s);
      auth.syncSessionCredits(s);
    }
    res.json({ ok: true, session: auth.publicView(s) });
  });
  app.post('/api/boss/heartbeat', async (req, res) => {
    const token = req.headers['x-boss-token'] || req.body?.token || req.query.token;
    try {
      const result = await runBossHeartbeat(token);
      if (!result.ok) return res.status(401).json({ ok: false, error: result.error || 'Unauthorized' });
      res.json({ ok: true, session: result.session });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  app.post('/api/boss/auth/logout', (req, res) => {
    auth.logout((req.body || {}).token);
    res.json({ ok: true });
  });
  app.get('/api/boss/auth/config', (_req, res) => {
    res.json({
      ok: true,
      mock: auth.isMock(),
      ecsEnabled: ecsAuth.isEcsEnabled(),
      ecsBaseUrl: auth.ecsBaseUrl() || null,
    });
  });
  app.get('/api/boss/auth/oauth/start', (_req, res) => {
    const result = ecsAuth.startDesktopOAuth();
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true, authorizeUrl: result.authorizeUrl, state: result.state });
  });
  app.get('/api/boss/auth/oauth/callback', async (req, res) => {
    const q = req.query || {};
    const frontend = process.env.OAUTH_FRONTEND_ORIGIN || process.env.DEV_FRONTEND_URL || 'http://127.0.0.1:3020';
    if (q.error) {
      return res.redirect(`${frontend}/boss/login?error=${encodeURIComponent(String(q.error))}`);
    }
    try {
      const ecsData = await ecsAuth.exchangeCode(q.code, q.state);
      const s = await auth.loginWithEcsToken(ecsData);
      res.redirect(`${frontend}/boss/login?token=${encodeURIComponent(s.token)}`);
    } catch (e) {
      res.redirect(`${frontend}/boss/login?error=${encodeURIComponent(e.message || 'OAuth failed')}`);
    }
  });

  // ── Office share (Plan 4a) ────────────────────────────────────────────────
  app.get('/api/office/share/info', (_req, res) => {
    res.json({ ok: true, share: officeShare.getShareInfo() });
  });
  app.get('/api/office/presence', (_req, res) => {
    res.json({ ok: true, ...getOfficePresence() });
  });
  app.get('/api/office/events', (req, res) => {
    officeEvents.subscribe(res, {
      agentId: req.query.agentId,
      threadId: req.query.threadId,
    });
  });
  app.post('/api/office/share/enable', async (req, res) => {
    try {
      const token = (req.body || {}).token || req.headers['x-boss-token'];
      const ecsToken = auth.getEcsAccessToken(token);
      if (!ecsToken) return res.status(401).json({ ok: false, error: 'ECS login required' });
      const share = await officeShare.enableShare({
        name: req.body?.name,
        bossAccessToken: ecsToken,
      });
      res.json({ ok: true, share });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  app.post('/api/office/share/join', async (req, res) => {
    try {
      const token = (req.body || {}).token || req.headers['x-boss-token'];
      const ecsToken = auth.getEcsAccessToken(token);
      if (!ecsToken) return res.status(401).json({ ok: false, error: 'ECS login required' });
      const share = await officeShare.joinShare({
        inviteCode: req.body?.inviteCode,
        hostUrl: req.body?.hostUrl,
        bossAccessToken: ecsToken,
      });
      res.json({ ok: true, share });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  app.post('/api/office/share/disable', (_req, res) => {
    res.json({ ok: true, share: officeShare.disableShare() });
  });

  // ── Office state (renderer + parent page poll this) ───────────────────────
  app.get('/api/office/snapshot', (req, res) => {
    const owner = resolveBossOwner(req);
    res.json(
      office.snapshot({
        agentId: req.query.agentId ? String(req.query.agentId) : undefined,
        threadId: req.query.threadId ? String(req.query.threadId) : undefined,
        ownerKey: owner.ownerKey,
        ownerName: owner.ownerName,
      }),
    );
  });

  // ── Boss chat threads (per-agent, per-user conversations) ─────────────────
  app.get('/api/boss-chats', (req, res) => {
    const agentId = String(req.query.agentId || '').trim();
    const owner = resolveBossOwner(req);
    const threads = agentId
      ? bossChat.threadSummaries(agentId, owner.ownerKey)
      : bossChat.inboxSummaries(owner.ownerKey, owner.ownerName);
    res.json({
      ok: true,
      ownerKey: owner.ownerKey,
      ownerName: owner.ownerName,
      threads,
    });
  });
  app.post('/api/boss-chats', (req, res) => {
    const agentId = String(req.body?.agentId || '').trim();
    if (!agentId) return res.status(400).json({ ok: false, error: 'agentId required' });
    const owner = resolveBossOwner(req);
    const openclawAgentId = office.resolveOpenClawAgentId(agentId);
    const thread = bossChat.createThread(agentId, req.body?.title, { ...owner, openclawAgentId });
    res.json({
      ok: true,
      thread: {
        id: thread.id,
        agentId: thread.agentId,
        title: thread.title,
        pinned: thread.pinned,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        messageCount: thread.gatewayBacked ? null : 0,
        gatewayBacked: !!openclawAgentId,
        openclawSessionKey: thread.openclawSessionKey,
        openclawAgentId: thread.openclawAgentId,
      },
    });
  });
  app.post('/api/boss-chats/:id/plan-deliverable', (req, res) => {
    const threadId = String(req.params.id || '').trim();
    const owner = resolveBossOwner(req);
    const thread = bossChat.getThreadForOwner(threadId, owner.ownerKey);
    if (!thread) return res.status(404).json({ ok: false, error: 'thread not found' });
    const agent = office.getAgent(thread.agentId);
    if (!agent || !orgRoles.isSecretaryRole(agent.role)) {
      return res.status(400).json({ ok: false, error: 'plan deliverables are Secretary-only (talk to your Secretary)' });
    }
    const task = String(req.body?.task || '').trim();
    const result = String(req.body?.result || '').trim();
    if (!task || !result) return res.status(400).json({ ok: false, error: 'task and result required' });
    try {
      const file = savePlanDeliverable({ agentIdOrRole: agent.id, task, result });
      res.json({ ok: true, file });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });
  app.get('/api/boss-chats/:id/openclaw-session', (req, res) => {
    const threadId = String(req.params.id || '').trim();
    const owner = resolveBossOwner(req);
    const thread = bossChat.getThreadForOwner(threadId, owner.ownerKey);
    if (!thread) return res.status(404).json({ ok: false, error: 'thread not found' });
    const openclawAgentId = office.resolveOpenClawAgentId(thread.agentId);
    if (!openclawAgentId) {
      return res.status(400).json({ ok: false, error: 'agent has no OpenClaw runtime' });
    }
    const key = bossChat.ensureOpenClawSessionKey(threadId, owner.ownerKey, { openclawAgentId });
    res.json({ ok: true, openclawSessionKey: key, openclawAgentId });
  });
  app.patch('/api/boss-chats/:id', (req, res) => {
    const threadId = String(req.params.id || '').trim();
    const owner = resolveBossOwner(req);
    if (req.body?.pinned !== undefined) {
      const thread = bossChat.setPinned(threadId, owner.ownerKey, !!req.body.pinned);
      if (!thread) return res.status(404).json({ ok: false, error: 'thread not found' });
      return res.json({
        ok: true,
        thread: bossChat.threadSummaries(thread.agentId, owner.ownerKey).find((t) => t.id === thread.id) || {
          id: thread.id,
          agentId: thread.agentId,
          title: thread.title,
          pinned: thread.pinned,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          messageCount: thread.messages.length,
        },
      });
    }
    if (req.body?.title !== undefined) {
      const thread = bossChat.setThreadTitle(threadId, owner.ownerKey, req.body.title);
      if (!thread) return res.status(404).json({ ok: false, error: 'thread not found' });
      return res.json({ ok: true, thread: { id: thread.id, title: thread.title, updatedAt: thread.updatedAt } });
    }
    if (req.body?.openclawSessionKey !== undefined) {
      const thread = bossChat.setThreadSessionKey(
        threadId,
        owner.ownerKey,
        String(req.body.openclawSessionKey || '').trim(),
      );
      if (!thread) return res.status(404).json({ ok: false, error: 'thread not found' });
      return res.json({
        ok: true,
        thread: {
          id: thread.id,
          openclawSessionKey: thread.openclawSessionKey,
          openclawAgentId: thread.openclawAgentId,
          updatedAt: thread.updatedAt,
        },
      });
    }
    return res.status(400).json({ ok: false, error: 'nothing to update' });
  });
  app.get('/api/boss-chats/by-session', (req, res) => {
    const owner = resolveBossOwner(req);
    const sessionKey = String(req.query.sessionKey || '').trim();
    if (!sessionKey) return res.status(400).json({ ok: false, error: 'sessionKey required' });
    const thread = bossChat.findThreadBySessionKey(owner.ownerKey, sessionKey);
    if (!thread) return res.json({ ok: true, thread: null });
    res.json({
      ok: true,
      thread: {
        id: thread.id,
        agentId: thread.agentId,
        title: thread.title,
        openclawSessionKey: thread.openclawSessionKey,
        openclawAgentId: thread.openclawAgentId,
      },
    });
  });
  app.delete('/api/boss-chats/:id', (req, res) => {
    const owner = resolveBossOwner(req);
    const ok = bossChat.deleteThread(String(req.params.id || '').trim(), owner.ownerKey);
    if (!ok) return res.status(404).json({ ok: false, error: 'thread not found' });
    res.json({ ok: true });
  });

  // Org chart (UI builds per-NPC settings + station labels from this)
  app.get('/api/office/roster', (_req, res) => {
    res.json({
      departments: roster.residents().map((d) => ({
        role: d.role,
        label: d.label,
        charSprite: d.charSprite,
        skillId: d.skillId,
        routable: d.routable,
      })),
    });
  });

  app.post('/api/webhooks/coliving/vacant-room', async (req, res) => {
    try {
      const orchestrator = require('./vacant-room-orchestrator');
      const body = req.body || {};
      const result = await orchestrator.runVacantRoomPipeline(body);
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/office/command', (req, res) => {
    const { action } = req.body || {};
    try {
      switch (action) {
        case 'set_note': {
          const { agentId = 'it', note = '' } = req.body;
          office.setAgent(agentId, { bubbleText: note });
          break;
        }
        case 'set_posting_job': {
          const { status, label, step, progress, total } = req.body;
          const a = office.ensureRole('posting', 'Marketing · Posting', 2);
          if (status === 'running') {
            office.work(a.role, label || 'Posting…', { label, step, progress, total });
          } else {
            office.rest(a.role, '');
          }
          break;
        }
        case 'rest':
          office.rest(req.body.agentId, req.body.note || '');
          break;
        case 'work':
          office.work(req.body.agentId, req.body.note || '', req.body.job || null);
          break;
        default:
          return res.status(400).json({ ok: false, error: `unknown action: ${action}` });
      }
      res.json({ ok: true, snapshot: office.snapshot() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Cross-desktop OpenClaw agent ingest ───────────────────────────────────
  app.post('/api/agents/register', (req, res) => {
    const a = office.registerExternalAgent(req.body || {});
    res.json({ ok: true, id: a.id, agent: a });
  });
  app.post('/api/agents/status', (req, res) => {
    const { id, state, note } = req.body || {};
    const a = office.externalStatus(id, { state, note });
    if (!a) return res.status(404).json({ ok: false, error: 'unknown agent id' });
    res.json({ ok: true, agent: a });
  });
  app.post('/api/agents/heartbeat', (req, res) => {
    const a = office.heartbeat((req.body || {}).id);
    if (!a) return res.status(404).json({ ok: false, error: 'unknown agent id' });
    res.json({ ok: true });
  });
  app.post('/api/agents/remove', (req, res) => {
    office.removeAgent((req.body || {}).id);
    res.json({ ok: true });
  });
  app.get('/api/agents', (_req, res) => {
    res.json({ agents: office.snapshot().agents.filter((a) => a.external) });
  });

  // ── Config: user-created agents ───────────────────────────────────────────
  app.get('/api/config/agents/catalog', async (_req, res) => {
    try {
      const hirePassword = require('./hire-password');
      const templates = (await ecsCatalog.catalogWithStatusMerged()).map((t) =>
        hirePassword.redactCatalogTemplate(t),
      );
      res.json({ templates, source: ecsCatalog.ecsBaseUrl() ? 'ecs' : 'local' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Category tabs for Browse — server-driven (pulled from ECS, with a built-in
  // fallback). Edit data/categories.json on ECS and all desktops sync.
  app.get('/api/config/agents/categories', async (_req, res) => {
    try {
      const categories = await ecsCatalog.categoriesMerged();
      res.json({ ok: true, categories });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  const portalPartnerOAuth = require('./portal-partner-oauth');
  const colivingOAuth = require('./coliving-oauth');

  function mountPortalOAuthRoutes(partnerId) {
    app.get(`/api/config/portal-oauth/${partnerId}/status`, (_req, res) => {
      res.json({ ok: true, ...portalPartnerOAuth.publicStatus(partnerId) });
    });
    app.get(`/api/config/portal-oauth/${partnerId}/start`, (req, res) => {
      try {
        const provider = String(req.query?.provider || 'google').trim();
        res.json({ ok: true, authorizeUrl: portalPartnerOAuth.buildOAuthStartUrl(partnerId, provider), partner: partnerId });
      } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
      }
    });
    app.post(`/api/config/portal-oauth/${partnerId}/complete`, async (req, res) => {
      try {
        const token = String(req.body?.token || '').trim();
        if (!token) return res.status(400).json({ ok: false, error: 'Missing portal token' });
        const result = await portalPartnerOAuth.completeOAuth(partnerId, token);
        res.json({ ok: true, ...result });
      } catch (e) {
        res.status(400).json({
          ok: false,
          error: e.message || 'Portal OAuth failed',
          code: e.code || 'PORTAL_OAUTH_FAILED',
          partner: partnerId,
        });
      }
    });
  }

  for (const p of portalPartnerOAuth.listPartners()) {
    mountPortalOAuthRoutes(p.id);
  }

  app.get('/api/config/coliving/oauth/status', (_req, res) => {
    res.json({ ok: true, ...colivingOAuth.publicStatus() });
  });
  app.get('/api/config/coliving/oauth/start', (req, res) => {
    const provider = String(req.query?.provider || 'google').trim();
    res.json({ ok: true, authorizeUrl: colivingOAuth.buildOAuthStartUrl(provider) });
  });
  app.post('/api/config/coliving/oauth/complete', async (req, res) => {
    try {
      const token = String(req.body?.token || '').trim();
      if (!token) return res.status(400).json({ ok: false, error: 'Missing portal token' });
      const result = await colivingOAuth.completeOAuth(token);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({
        ok: false,
        error: e.message || 'Coliving OAuth failed',
        code: e.code || 'COLIVING_OAUTH_FAILED',
      });
    }
  });

  app.get('/auth/callback', (req, res) => {
    const q = req.query || {};
    const partnerId = portalPartnerOAuth.consumePendingPartner('coliving');
    if (q.error) {
      return res
        .status(400)
        .type('html')
        .send(portalPartnerOAuth.callbackHtml({ partnerId, error: String(q.error) }));
    }
    return res
      .type('html')
      .send(portalPartnerOAuth.callbackHtml({ partnerId, token: q.token ? String(q.token) : '' }));
  });
  app.post('/api/config/agents/hire', async (req, res) => {
    try {
      const { templateId, name, hirePassword, billingInterval, autoRenew, devScope, devEngine, model } = req.body || {};
      const bossToken = req.headers['x-boss-token'] || req.body?.token;
      const result = await agentCatalog.hireFromTemplate({
        templateId,
        name,
        bossToken,
        hirePassword,
        billingInterval,
        autoRenew,
        devScope,
        devEngine,
        model,
      });
      auth.refreshAllSessionCredits();
      res.json({
        ok: true,
        agent: redactAgent(result.agent),
        creditBalance: result.balance,
        openclaw: result.openclaw,
        postInstall: result.postInstall || null,
        codexInstall: result.codexInstall || null,
        cursorInstall: result.cursorInstall || null,
        claudeInstall: result.claudeInstall || null,
        devCliInstall: result.devCliInstall || null,
        devEngine: result.devEngine || null,
      });
    } catch (e) {
      const status =
        e.code === 'INSUFFICIENT_CREDITS'
          ? 409
          : e.code === 'ALREADY_HIRED'
            ? 409
            : e.code === 'UNKNOWN_TEMPLATE'
              ? 404
              : e.code === 'COLIVING_OAUTH_REQUIRED' || e.code === 'PORTAL_OAUTH_REQUIRED'
                ? 403
              : e.code === 'HIRE_PASSWORD_REQUIRED' || e.code === 'INVALID_HIRE_PASSWORD'
                ? 403
                : e.code === 'HIRE_PASSWORD_UNAVAILABLE'
                  ? 503
                  : 400;
      res.status(status).json({
        ok: false,
        error: e.message,
        code: e.code,
        balance: e.balance,
        required: e.required,
      });
    }
  });
  app.get('/api/config/agents', (_req, res) => {
    refreshBillingAndFires().finally(() => {
      res.json({ agents: registry.listAgents().map(redactAgent) });
    });
  });
  app.get('/api/config/agents/skin-targets', (_req, res) => {
    const targets = [];
    for (const a of office.snapshot().agents || []) {
      if (a.external) continue;
      if (a.userAgentId) {
        targets.push({ id: a.userAgentId, name: a.label, kind: 'user' });
      } else {
        targets.push({
          id: `builtin:${a.role}`,
          name: a.label,
          kind: 'builtin',
          role: a.role,
        });
      }
    }
    res.json({ agents: targets });
  });
  app.put('/api/config/builtin-agents/:role', (req, res) => {
    try {
      const { role } = req.params;
      const body = req.body || {};
      const row = registry.updateBuiltinAgent(role, {
        label: body.label,
        sprite: body.sprite,
        hueShift: body.hueShift,
      });
      const officePatch = {};
      if (row.label) officePatch.label = row.label;
      if (Number.isInteger(row.sprite)) officePatch.charSprite = row.sprite;
      if (Number.isInteger(row.hueShift)) officePatch.hueShift = row.hueShift;
      const a = office.setAgent(role, officePatch);
      if (!a) return res.status(404).json({ ok: false, error: 'Agent not found' });
      res.json({
        ok: true,
        agent: {
          id: a.id,
          role: a.role,
          label: a.label,
          charSprite: a.charSprite,
          hueShift: a.hueShift,
        },
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  app.get('/api/config/agent-reviews', (_req, res) => {
    res.json({ reviews: registry.listAgentReviews() });
  });
  app.get('/api/config/agents/:id/review', (req, res) => {
    const a = registry.getAgent(req.params.id);
    if (!a) return res.status(404).json({ ok: false, error: 'Agent not found' });
    const review = registry.getAgentReview(registry.userAgentReviewKey(a.id));
    res.json({ ok: true, review });
  });
  app.put('/api/config/agents/:id/review', (req, res) => {
    const a = registry.getAgent(req.params.id);
    if (!a) return res.status(404).json({ ok: false, error: 'Agent not found' });
    try {
      const review = registry.setAgentReview(registry.userAgentReviewKey(a.id), req.body?.rating);
      res.json({ ok: true, review });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  app.get('/api/config/builtin-agents/:role/review', (req, res) => {
    const review = registry.getAgentReview(registry.builtinAgentReviewKey(req.params.role));
    res.json({ ok: true, review });
  });
  app.put('/api/config/builtin-agents/:role/review', (req, res) => {
    try {
      const review = registry.setAgentReview(registry.builtinAgentReviewKey(req.params.role), req.body?.rating);
      res.json({ ok: true, review });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  app.get('/api/config/builtin-agents/:role/overview', async (req, res) => {
    const { buildBuiltinOverview } = require('./builtin-overview');
    const out = await buildBuiltinOverview(req.params.role, { office, registry });
    if (!out) return res.status(404).json({ ok: false, error: 'Builtin agent not found' });
    res.json(out);
  });
  app.get('/api/config/templates/:id/review', (req, res) => {
    const review = registry.getAgentReview(registry.templateReviewKey(req.params.id));
    res.json({ ok: true, review });
  });
  app.put('/api/config/templates/:id/review', (req, res) => {
    try {
      const review = registry.setAgentReview(registry.templateReviewKey(req.params.id), req.body?.rating);
      res.json({ ok: true, review });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  app.post('/api/config/agents', async (req, res) => {
    const body = req.body || {};
    // Hiring an NPC creates a *real* isolated OpenClaw agent (1 NPC = 1 agent).
    // If OpenClaw isn't installed yet, fall back to a demo-runtime record.
    let openclawAgentId = null;
    let runtime = body.runtime;
    const oc = await openclaw.agentsAdd({ name: body.name, model: body.model });
    if (oc.ok) {
      openclawAgentId = oc.agentId;
      runtime = 'openclaw';
    }
    const a = registry.addAgent({ ...body, openclawAgentId, runtime });
    defaultMcpPack.applyRoleDefaultsToAgent(a);
    office.attachHiredAgent(a); // mirror into the office immediately
    res.json({ ok: true, agent: redactAgent(a), openclaw: { available: oc.available !== false, agentId: openclawAgentId, error: oc.error } });
  });
  app.get('/api/config/agents/:id', (req, res) => {
    const a = registry.getAgent(req.params.id);
    if (!a) return res.status(404).json({ ok: false });
    res.json({ agent: redactAgent(a), knowledge: registry.listKnowledge(a.id) });
  });
  app.put('/api/config/agents/:id', async (req, res) => {
    const existing = registry.getAgent(req.params.id);
    if (!existing) return res.status(404).json({ ok: false });
    const patch = mergeAgentIncoming(existing, req.body || {});
    const a = registry.updateAgent(req.params.id, patch);
    const cooStation = orgRoles.isCooRole(a.role) ? office.getAgent('coo') || office.getAgent('ceo') : null;
    const officeTarget =
      orgRoles.isCooRole(a.role) && cooStation?.userAgentId === a.id
        ? cooStation.id
        : `user:${a.id}`;
    office.setAgent(officeTarget, {
      label: a.name,
      role: a.role,
      charSprite: a.sprite,
      hueShift: a.hueShift,
      skillIds: a.skillIds,
      openclawSkillNames: a.openclawSkillNames || [],
      mcpIds: a.mcpIds,
      mcpBindings: a.mcpBindings,
      channels: a.channels,
      devEngine: a.devEngine,
      devScope: a.devScope,
    });
    let entitlementWarnings = [];
    try {
      entitlementWarnings = await workerEntitlements.checkBindingWarnings({
        homeWorkerId: a.homeWorkerId || a.role || a.templateId,
        skillIds: a.skillIds || [],
        mcpIds: a.mcpIds || [],
      });
    } catch {
      /* non-fatal */
    }
    res.json({ ok: true, agent: redactAgent(a), entitlementWarnings });
  });
  app.get('/api/config/agents/:id/overview', async (req, res) => {
    const a = registry.getAgent(req.params.id);
    if (!a) return res.status(404).json({ ok: false });
    const liveNpc = office.getAgent(`user:${a.id}`);
    const allDeliverables = registry.listDeliverables();
    const recentDeliverables = allDeliverables
      .filter((d) => d.agentId === a.id || d.agentId === `user:${a.id}`)
      .slice(0, 8);
    const oc = await openclaw.skillsList();
    const allSkills = registry.listSkills();
    const mcpsList = registry.listMcps();
    const { buildHiredAgentOverview } = require('./agent-overview-build');

    let catalog = null;
    if (a.templateId || a.role) {
      try {
        const templates = await ecsCatalog.loadCatalogMerged();
        const tid = a.templateId;
        catalog =
          templates.find(
            (t) =>
              t.id === tid ||
              t.departmentId === tid ||
              t.bundleTemplateId === tid ||
              t.templateId === tid,
          ) || null;
        if (!catalog && tid) catalog = agentCatalog.getTemplate(tid);
        if (!catalog && a.role) {
          catalog =
            templates.find((t) => t.role === a.role) ||
            agentCatalog.getTemplate(a.role) ||
            null;
        }
      } catch {
        catalog =
          (a.templateId && agentCatalog.getTemplate(a.templateId)) ||
          (a.role && agentCatalog.getTemplate(a.role)) ||
          null;
      }
    }

    const built = buildHiredAgentOverview(a, {
      catalog,
      allSkills,
      mcpsList,
      agentCatalog,
      liveNpc,
    });

    let soulPreview = '';
    let modelRef = '';
    if (a.openclawAgentId) {
      const soulFile = openclaw.readAgentWorkspaceFile(a.openclawAgentId, 'SOUL.md');
      if (soulFile.ok) {
        soulPreview = openclaw.soulPreviewFromContent(soulFile.content);
      }
      const modelInfo = await openclaw.getAgentModelRef(a.openclawAgentId);
      modelRef = modelInfo.modelRef || '';
    }

    res.json({
      ok: true,
      agent: redactAgent(a),
      live: built.live,
      description: built.description,
      examples: built.examples,
      jobScope: built.jobScope,
      skills: built.skills,
      baseSkills: built.baseSkills,
      additionalSkills: built.additionalSkills,
      mcps: built.mcps,
      baseMcps: built.baseMcps,
      additionalMcps: built.additionalMcps,
      additionalOpenclawSkills: built.additionalOpenclawSkills,
      additionalCapabilities: built.additionalCapabilities,
      openclawSkills: built.openclawSkills,
      knowledge: registry.listKnowledge(a.id),
      recentDeliverables,
      openclawAvailable: !!oc.available,
      catalog: built.catalog,
      soulPreview,
      modelRef,
    });
  });
  app.put('/api/config/agents/:id/model', async (req, res) => {
    const a = registry.getAgent(req.params.id);
    if (!a) return res.status(404).json({ ok: false, error: 'Agent not found' });
    if (!a.openclawAgentId) {
      return res.status(400).json({ ok: false, error: 'Agent has no OpenClaw id (demo runtime)' });
    }
    const modelRef = String(req.body?.modelRef ?? req.body?.model ?? '').trim();
    const r = await openclaw.setAgentModelRef(a.openclawAgentId, modelRef);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error || 'Could not set model' });
    res.json({ ok: true, modelRef, openclawAgentId: a.openclawAgentId });
  });
  app.post('/api/config/agents/apply-worker-permissions', async (_req, res) => {
    const workerPermissions = require('./worker-permissions');
    const out = await workerPermissions.applyAllHiredWorkerPermissions();
    res.json(out);
  });
  app.delete('/api/config/agents/:id', async (req, res) => {
    res.status(410).json({ ok: false, error: 'Use POST /api/config/agents/:id/fire instead. Firing is scheduled for the next salary date with no refund.' });
  });
  app.post('/api/config/agents/:id/fire', async (req, res) => {
    const existing = registry.getAgent(req.params.id);
    if (!existing) return res.status(404).json({ ok: false, error: 'Agent not found' });
    try {
      const bossToken = req.headers['x-boss-token'] || req.body?.token;
      if (ecsSubscriptions.isEcsBillingEnabled(bossToken)) {
        await ecsSubscriptions.notifyFire({
          ecsToken: ecsSubscriptions.ecsTokenFromBossToken(bossToken),
          bossToken,
          subscriptionId: existing.ecsSubscriptionId,
          localAgentId: existing.id,
        });
      }
      const plan = payroll.requestFire(existing);
      if (plan.immediate) {
        await payroll.terminateAgent(existing, { openclaw });
        return res.json({ ok: true, immediate: true, fireAt: plan.fireAt });
      }
      res.json({
        ok: true,
        immediate: false,
        fireAt: plan.fireAt,
        agent: redactAgent(plan.agent),
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  app.post('/api/config/agents/:id/contract', async (req, res) => {
    const existing = registry.getAgent(req.params.id);
    if (!existing) return res.status(404).json({ ok: false, error: 'Agent not found' });
    if (orgRoles.isCooRole(existing.role)) {
      return res.status(400).json({
        ok: false,
        error: 'COO salary is daily only and recalculates automatically at midnight.',
      });
    }
    const { billingInterval } = req.body || {};
    if (!billingInterval) {
      return res.status(400).json({ ok: false, error: 'billingInterval required' });
    }
    try {
      const bossToken = req.headers['x-boss-token'] || req.body?.token;
      let ecsResult = null;
      if (ecsSubscriptions.isEcsBillingEnabled(bossToken) && existing.ecsSubscriptionId) {
        ecsResult = await ecsSubscriptions.notifyUpdateBilling({
          ecsToken: ecsSubscriptions.ecsTokenFromBossToken(bossToken),
          bossToken,
          subscriptionId: existing.ecsSubscriptionId,
          localAgentId: existing.id,
          billingInterval,
        });
        if (!ecsResult.ok) {
          return res.status(400).json({
            ok: false,
            error: ecsResult.error || 'ECS contract update failed',
            code: ecsResult.code,
          });
        }
        if (typeof ecsResult.creditBalance === 'number') {
          billing.setBalance(ecsResult.creditBalance, { reason: 'ecs_contract_update' });
        }
      }
      let agent = payroll.updateContractBilling(existing, { billingInterval });
      if (ecsResult?.subscription) {
        agent = registry.updateAgent(agent.id, {
          billingInterval: ecsResult.subscription.billingInterval || agent.billingInterval,
          nextSalaryDueAt: ecsResult.subscription.nextSalaryDueAt || agent.nextSalaryDueAt,
        }) || agent;
      }
      auth.refreshAllSessionCredits();
      res.json({ ok: true, agent: redactAgent(agent) });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  app.post('/api/config/agents/:id/hire-back', async (req, res) => {
    const existing = registry.getAgent(req.params.id);
    if (!existing) return res.status(404).json({ ok: false, error: 'Agent not found' });
    try {
      const bossToken = req.headers['x-boss-token'] || req.body?.token;
      let ecsResult = null;
      if (ecsSubscriptions.isEcsBillingEnabled(bossToken) && existing.ecsSubscriptionId) {
        ecsResult = await ecsSubscriptions.notifyReactivate({
          ecsToken: ecsSubscriptions.ecsTokenFromBossToken(bossToken),
          bossToken,
          subscriptionId: existing.ecsSubscriptionId,
          localAgentId: existing.id,
          billingInterval: req.body?.billingInterval,
        });
        if (!ecsResult.ok) {
          return res.status(400).json({
            ok: false,
            error: ecsResult.error || 'ECS hire-back failed',
            code: ecsResult.code,
          });
        }
        if (typeof ecsResult.creditBalance === 'number') {
          billing.setBalance(ecsResult.creditBalance, { reason: 'ecs_hire_back' });
        }
      }
      const agent = payroll.cancelFire(existing, { billingInterval: req.body?.billingInterval });
      let updated = agent;
      if (ecsSubscriptions.isEcsBillingEnabled(bossToken) && ecsResult?.subscription) {
        updated = registry.updateAgent(agent.id, {
          billingInterval: ecsResult.subscription.billingInterval || agent.billingInterval,
          autoRenew: ecsResult.subscription.autoRenew !== false,
          nextSalaryDueAt: ecsResult.subscription.nextSalaryDueAt || agent.nextSalaryDueAt,
        }) || agent;
      }
      auth.refreshAllSessionCredits();
      res.json({ ok: true, agent: redactAgent(updated) });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Resolved spec the external OpenClaw / Hermes runtime will consume (Phase 2).
  app.get('/api/config/agents/:id/spec', (req, res) => {
    const a = registry.getAgent(req.params.id);
    if (!a) return res.status(404).json({ ok: false });
    const allSkills = registry.listSkills();
    const { mcpBindings, mcpServers } = registry.resolveAgentMcpRuntimeSpec(a.id);
    res.json({
      id: a.id,
      name: a.name,
      role: a.role,
      runtime: a.runtime,
      systemPrompts: a.skillIds.map((sid) => allSkills.find((s) => s.id === sid)).filter(Boolean).map((s) => s.system),
      openclawSkillNames: a.openclawSkillNames || [],
      mcpIds: a.mcpIds || [],
      mcpBindings,
      mcpServers,
      channels: a.channels,
      knowledge: registry.listKnowledge(a.id),
    });
  });

  // ── Config: skills catalog ────────────────────────────────────────────────
  app.get('/api/config/skills', (_req, res) => res.json({ skills: registry.listSkills() }));
  app.post('/api/config/skills', (req, res) => res.json({ ok: true, skill: registry.addSkill(req.body || {}) }));
  app.put('/api/config/skills/:id', (req, res) => {
    const s = registry.updateSkill(req.params.id, req.body || {});
    if (!s) return res.status(404).json({ ok: false });
    res.json({ ok: true, skill: s });
  });
  app.delete('/api/config/skills/:id', (req, res) => {
    registry.removeSkill(req.params.id);
    res.json({ ok: true });
  });

  // ── Config: Retell AI key (Bring-Your-Own-Key) ────────────────────────────
  // Status only ever returns a masked preview — never the plaintext key.
  app.get('/api/config/retell', (_req, res) => {
    try {
      res.json({ ok: true, ...retellStore.getStatus() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'Failed to read Retell key' });
    }
  });
  app.post('/api/config/retell', (req, res) => {
    try {
      const apiKey = (req.body && req.body.apiKey) || '';
      const status = retellStore.setApiKey(apiKey);
      res.json({ ok: true, ...status });
    } catch (e) {
      res.status(400).json({ ok: false, error: e instanceof Error ? e.message : 'Failed to save Retell key' });
    }
  });
  app.delete('/api/config/retell', (_req, res) => {
    try {
      const status = retellStore.clearApiKey();
      res.json({ ok: true, ...status });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'Failed to clear Retell key' });
    }
  });

  // ── Config: MCP server catalog ────────────────────────────────────────────
  app.get('/api/config/mcps', (_req, res) => res.json({ mcps: registry.listMcps().map(redactMcp) }));
  app.post('/api/config/mcps/probe', async (req, res) => {
    const { url, timeoutMs } = req.body || {};
    try {
      const result = await mcpProbe.probe({ url, timeoutMs });
      if (!result.reachable) {
        return res.status(422).json({
          ok: false,
          reachable: false,
          error: result.error || 'MCP server unreachable',
          probe: result,
        });
      }
      res.json({ ok: true, reachable: true, probe: result });
    } catch (err) {
      res.status(500).json({
        ok: false,
        reachable: false,
        error: err instanceof Error ? err.message : 'Probe failed',
      });
    }
  });
  app.post('/api/config/mcps', async (req, res) => {
    const body = req.body || {};
    if (!body.skipProbeOnHire) {
      const url = typeof body.url === 'string' ? body.url.trim() : '';
      if (!url) {
        return res.status(400).json({ ok: false, error: 'Server URL is required' });
      }
      try {
        const probeResult = await mcpProbe.probe({ url });
        if (!probeResult.reachable) {
          return res.status(422).json({
            ok: false,
            error: probeResult.error || 'MCP server unreachable — fix URL or start the server before saving',
            probe: probeResult,
          });
        }
        Object.assign(body, mcpProbe.applyProbeToMcpBody(body, probeResult));
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : 'Probe failed',
        });
      }
    }
    const mcp = registry.addMcp(body);
    res.json({ ok: true, mcp: redactMcp(mcp) });
  });
  app.put('/api/config/mcps/:id', async (req, res) => {
    const existing = registry.getMcp(req.params.id);
    if (!existing) return res.status(404).json({ ok: false });
    const patch = req.body || {};
    const nextUrl = typeof patch.url === 'string' ? patch.url.trim() : '';
    const urlChanged = nextUrl && nextUrl !== (existing.url || '');
    if (urlChanged && !patch.skipProbeOnHire) {
      try {
        const probeResult = await mcpProbe.probe({ url: nextUrl });
        if (!probeResult.reachable) {
          return res.status(422).json({
            ok: false,
            error: probeResult.error || 'MCP server unreachable — fix URL or start the server before saving',
            probe: probeResult,
          });
        }
        Object.assign(patch, mcpProbe.applyProbeToMcpBody(patch, probeResult));
      } catch (err) {
        return res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : 'Probe failed',
        });
      }
    }
    const m = registry.updateMcp(req.params.id, patch);
    if (!m) return res.status(404).json({ ok: false });
    res.json({ ok: true, mcp: redactMcp(m) });
  });
  app.post('/api/config/mcps/:id/auth/connect', (req, res) => {
    const result = registry.connectMcpAuth(req.params.id, req.body || {});
    if (!result) return res.status(404).json({ ok: false, error: 'MCP not found' });
    res.json({
      ok: true,
      mcp: redactMcp(result.mcp),
      account: result.account ? redactMcpAccount(result.account) : null,
      authorizeUrl: result.authorizeUrl || '',
    });
  });
  app.post('/api/config/mcps/:id/auth/disconnect', (req, res) => {
    const accountId = (req.body || {}).accountId;
    const m = registry.disconnectMcpAuth(req.params.id, accountId);
    if (!m) return res.status(404).json({ ok: false, error: 'MCP not found' });
    res.json({ ok: true, mcp: redactMcp(m) });
  });
  app.get('/api/config/mcps/:id/accounts', (req, res) => {
    const m = registry.getMcp(req.params.id);
    if (!m) return res.status(404).json({ ok: false, error: 'MCP not found' });
    res.json({
      ok: true,
      accounts: (m.accounts || []).map(redactMcpAccount),
      defaultAccountId: m.defaultAccountId || null,
    });
  });
  app.post('/api/config/mcps/:id/accounts', (req, res) => {
    const result = registry.addMcpAccount(req.params.id, req.body || {});
    if (!result) return res.status(404).json({ ok: false, error: 'MCP not found' });
    res.json({
      ok: true,
      mcp: redactMcp(result.mcp),
      account: redactMcpAccount(result.account),
    });
  });
  app.put('/api/config/mcps/:id/accounts/:accountId', (req, res) => {
    const result = registry.updateMcpAccount(req.params.id, req.params.accountId, req.body || {});
    if (!result) return res.status(404).json({ ok: false, error: 'Account not found' });
    res.json({
      ok: true,
      mcp: redactMcp(result.mcp),
      account: redactMcpAccount(result.account),
    });
  });
  app.delete('/api/config/mcps/:id/accounts/:accountId', (req, res) => {
    const m = registry.removeMcpAccount(req.params.id, req.params.accountId);
    if (!m) return res.status(404).json({ ok: false, error: 'Account not found' });
    res.json({ ok: true, mcp: redactMcp(m) });
  });
  app.post('/api/config/mcps/:id/accounts/:accountId/connect', (req, res) => {
    const result = registry.connectMcpAccountAuth(
      req.params.id,
      req.params.accountId,
      req.body || {},
    );
    if (!result) return res.status(404).json({ ok: false, error: 'Account not found' });
    res.json({
      ok: true,
      mcp: redactMcp(result.mcp),
      account: redactMcpAccount(result.account),
      authorizeUrl: result.authorizeUrl || '',
    });
  });
  app.post('/api/config/mcps/:id/accounts/:accountId/disconnect', (req, res) => {
    const result = registry.disconnectMcpAccountAuth(req.params.id, req.params.accountId);
    if (!result) return res.status(404).json({ ok: false, error: 'Account not found' });
    res.json({
      ok: true,
      mcp: redactMcp(result.mcp),
      account: redactMcpAccount(result.account),
    });
  });
  app.post('/api/config/mcps/:id/oauth/start', (req, res) => {
    handleMcpOAuthStart(req, res, req.params.id, (req.body || {}).accountId);
  });
  app.post('/api/config/mcps/:id/accounts/:accountId/oauth/start', (req, res) => {
    handleMcpOAuthStart(req, res, req.params.id, req.params.accountId);
  });
  app.get('/api/config/mcps/oauth/callback', async (req, res) => {
    const q = req.query || {};
    if (q.error) {
      const html = mcpOAuth.callbackHtml({
        ok: false,
        error: String(q.error_description || q.error),
        frontendOrigin: mcpOAuth.defaultFrontendOrigin(),
      });
      return res.status(400).type('html').send(html);
    }
    const result = await mcpOAuth.handleCallback({
      code: q.code,
      state: q.state,
      registry,
    });
    const status = result.ok ? 200 : 400;
    res.status(status).type('html').send(mcpOAuth.callbackHtml(result));
  });
  app.delete('/api/config/mcps/:id', (req, res) => {
    registry.removeMcp(req.params.id);
    res.json({ ok: true });
  });

  // ── Config: skins catalog ─────────────────────────────────────────────────
  app.get('/api/config/skins', (_req, res) => res.json({ skins: registry.listSkins() }));
  app.post('/api/config/skins', upload.single('sprite'), (req, res) => {
    try {
      const skin = registry.addCustomSkin({
        name: req.body?.name,
        pngBuffer: req.file?.buffer,
      });
      res.json({ ok: true, skin });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || 'Could not add skin' });
    }
  });
  app.put('/api/config/skins/:id', (req, res) => {
    try {
      const skin = registry.updateSkin(req.params.id, req.body || {});
      if (!skin) return res.status(404).json({ ok: false, error: 'Skin not found' });
      res.json({ ok: true, skin });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || 'Could not update skin' });
    }
  });

  // ── Paid skins store (proxies ECS; falls back to local builtins offline) ───
  // Browse: preview is visible to all; `owned` flags what can be Applied.
  app.get('/api/skins/store', async (req, res) => {
    const bossToken = req.headers['x-boss-token'] || req.query?.token;
    try {
      if (ecsSubscriptions.isEcsBillingEnabled(bossToken)) {
        const result = await ecsSubscriptions.skinCatalog({ bossToken });
        if (result.ok) return res.json({ ok: true, source: 'ecs', skins: result.skins || [] });
        // ECS reachable but errored — surface it (don't silently fake ownership)
        return res.status(result.status || 502).json({ ok: false, error: result.error, code: result.code });
      }
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message || 'ECS unavailable' });
    }
    // Offline / ECS not wired: show local builtins as free + owned so the page still works.
    const skins = registry.listSkins().map((s) => ({
      id: s.id,
      name: s.name,
      priceCredits: 0,
      isDefault: true,
      previewUrl: s.previewUrl || null,
      owned: true,
      assetUrl: s.assetUrl || null,
    }));
    res.json({ ok: true, source: 'local', skins });
  });

  // Purchase: server-authoritative on ECS (deducts credit, binds to gateway).
  app.post('/api/skins/:id/purchase', async (req, res) => {
    const bossToken = req.headers['x-boss-token'] || req.body?.token;
    if (!ecsSubscriptions.isEcsBillingEnabled(bossToken)) {
      return res.status(400).json({ ok: false, error: 'ECS login required to purchase.', code: 'ECS_REQUIRED' });
    }
    try {
      const result = await ecsSubscriptions.purchaseSkin({ bossToken, skinId: req.params.id });
      if (!result.ok) {
        return res.status(result.status || 400).json({
          ok: false,
          error: result.error,
          code: result.code,
          balance: result.balance,
          required: result.required,
        });
      }
      res.json(result);
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message || 'Purchase failed' });
    }
  });

  // Create a paid skin in the ECS catalog (used by the HR create-skin flow after
  // the boss confirms name + price). Server-authoritative.
  app.post('/api/skins/create', async (req, res) => {
    const bossToken = req.headers['x-boss-token'] || req.body?.token;
    if (!ecsSubscriptions.isEcsBillingEnabled(bossToken)) {
      return res.status(400).json({ ok: false, error: 'ECS login required to publish skins.', code: 'ECS_REQUIRED' });
    }
    try {
      const result = await ecsSubscriptions.createSkin({
        bossToken,
        name: req.body?.name,
        priceCredits: req.body?.priceCredits,
        previewUrl: req.body?.previewUrl,
        assetUrl: req.body?.assetUrl,
      });
      if (!result.ok) {
        return res.status(result.status || 400).json({ ok: false, error: result.error, code: result.code });
      }
      res.json(result);
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message || 'Publish failed' });
    }
  });

  // ── OpenClaw skills catalog (browse what's available + readiness) ─────────
  app.get('/api/clawhub/search', async (req, res) => res.json(await openclaw.skillsSearch(req.query.q || '')));
  app.get('/api/clawhub/installed', async (_req, res) => res.json(await openclaw.skillsList()));
  app.get('/api/clawhub/info', async (req, res) => res.json(await openclaw.skillInfo(req.query.name || '')));

  // ── Channels: the office "front desk" (Telegram/WhatsApp/Discord/…) ───────
  app.get('/api/channels', async (_req, res) => {
    const data = await openclaw.channelsList();
    // Attach the routing target (which agent the channel talks to; default COO).
    const channels = (data.channels || []).map((c) => ({
      ...c,
      agentId: registry.getChannelRoute(c.provider, c.account),
    }));
    res.json({ ...data, channels });
  });
  app.get('/api/channels/status', async (_req, res) => res.json(await openclaw.channelsStatus()));
  app.get('/api/channels/next-account', async (req, res) => {
    const provider = req.query.provider || '';
    if (!provider) return res.status(400).json({ ok: false, error: 'missing provider' });
    const account = await openclaw.channelsNextAccountId(provider);
    res.json({ ok: true, provider, account });
  });
  app.post('/api/channels/rename', async (req, res) => {
    const { provider, account, name } = req.body || {};
    if (!provider || !account) return res.status(400).json({ ok: false, error: 'missing provider or account' });
    res.json(await openclaw.channelsRename(provider, account, name));
  });
  app.post('/api/channels', async (req, res) => {
    const { provider, ...opts } = req.body || {};
    res.json(await openclaw.channelsAdd(provider, opts));
  });
  // Set which agent an inbound channel routes to (Secretary by default).
  app.post('/api/channels/route', (req, res) => {
    const { provider, account, agentId } = req.body || {};
    if (!provider) return res.status(400).json({ ok: false, error: 'missing provider' });
    const saved = registry.setChannelRoute(provider, account, agentId);
    res.json({ ok: true, agentId: saved });
  });
  app.delete('/api/channels/:provider/:account', async (req, res) => {
    res.json(await openclaw.channelsRemove(req.params.provider, req.params.account));
  });
  // WhatsApp QR linking (scan in WhatsApp → Linked Devices). Supports multiple accounts.
  app.get('/api/channels/whatsapp/statuses', async (_req, res) => {
    res.json(await openclaw.whatsappLinkStatuses());
  });
  app.get('/api/channels/whatsapp/status', async (req, res) => {
    const account = req.query.account || 'default';
    res.json(await openclaw.whatsappLinkStatus({ accountId: account }));
  });
  app.post('/api/channels/whatsapp/logout', async (req, res) => {
    const account = req.body?.account || 'default';
    res.json(await openclaw.whatsappLogout({ accountId: account }));
  });
  app.post('/api/channels/whatsapp/login/start', async (req, res) => {
    const force = req.body?.force === true;
    const account = req.body?.account || 'default';
    const name = req.body?.name;
    res.json(await openclaw.whatsappLoginStart({ accountId: account, name, force, timeoutMs: 45000 }));
  });
  app.get('/api/channels/whatsapp/login/wait', async (req, res) => {
    const timeoutMs = Math.min(Number(req.query.timeoutMs) || 180000, 240000);
    const account = req.query.account || 'default';
    const name = req.query.name;
    res.json(await openclaw.whatsappLoginWait({ accountId: account, name, timeoutMs }));
  });

  // ── Gateway: start/stop the OpenClaw WS service (channels + cron need it) ─
  app.get('/api/gateway/status', async (_req, res) => res.json(await openclaw.gatewayProbe()));
  app.post('/api/gateway/start', async (_req, res) => res.json(await openclaw.gatewayStart()));
  app.post('/api/gateway/stop', async (_req, res) => res.json(await openclaw.gatewayStop()));
  app.post('/api/gateway/restart', async (_req, res) => res.json(await openclaw.gatewayRestart()));

  // ── Cron: recurring agent work schedules ───────────────────────────────────
  app.get('/api/cron', async (_req, res) => {
    const data = await openclaw.cronList();
    const jobs = (data.jobs || []).map((j) => ({
      ...j,
      scheduleLabel: openclaw.formatSchedule(j),
      nextRunLabel: j.state?.nextRunAtMs ? new Date(j.state.nextRunAtMs).toLocaleString() : '—',
    }));
    res.json({ ...data, jobs });
  });
  app.post('/api/cron', async (req, res) => {
    const { name, message, agentId, every, cron, at, enabled } = req.body || {};
    res.json(await openclaw.cronAdd({ name, message, agentId, every, cron, at, enabled }));
  });
  app.delete('/api/cron/:id', async (req, res) => res.json(await openclaw.cronRemove(req.params.id)));
  app.post('/api/cron/:id/enable', async (req, res) => res.json(await openclaw.cronSetEnabled(req.params.id, true)));
  app.post('/api/cron/:id/disable', async (req, res) => res.json(await openclaw.cronSetEnabled(req.params.id, false)));
  app.post('/api/cron/:id/run', async (req, res) => {
    const result = await openclaw.cronRun(req.params.id);
    if (result?.ok !== false) {
      try {
        const jobs = (await openclaw.cronList()).jobs || [];
        const job = jobs.find((j) => j.id === req.params.id);
        if (job) {
          const msg = job.payload?.message || job.payload?.text || job.name || '';
          const label = `${job.name || ''} ${msg}`;
          const isDaily = /daily\s*report|morning\s*report|日报|每日/i.test(label);
          const isAlert = /alert|notify|remind|warning|issue|问题|提醒/i.test(label);
          const kind = isDaily ? 'daily_report' : isAlert ? 'alert' : 'daily_report';
          registry.addBossSummary({
            kind,
            summary: isDaily
              ? `Daily report: ${job.name || 'scheduled task'}`
              : isAlert
                ? `Attention needed: ${job.name || 'scheduled check'}`
                : `Schedule finished: ${job.name || 'recurring task'}`,
            task: msg,
            agentLabel: job.agentId || 'Schedule',
            content: msg ? `# Scheduled task\n${msg}\n` : undefined,
          });
        }
      } catch {
        /* summary inbox is best-effort */
      }
    }
    res.json(result);
  });

  // ── Per-agent knowledge (drag PDFs/docs to teach an agent) ────────────────
  app.get('/api/config/agents/:id/knowledge', (req, res) => {
    res.json({ knowledge: registry.listKnowledge(req.params.id) });
  });
  app.post('/api/config/agents/:id/knowledge', upload.array('files'), async (req, res) => {
    const a = registry.getAgent(req.params.id);
    if (!a) return res.status(404).json({ ok: false });
    const dir = registry.knowledgeDir(a.id);
    let chunks = 0;
    for (const f of req.files || []) {
      const safe = path.basename(f.originalname);
      fs.writeFileSync(path.join(dir, safe), f.buffer);
      const text = await extractText(safe, f.buffer);
      if (text) {
        fs.writeFileSync(path.join(dir, `${safe}.extracted.txt`), text, 'utf8');
        chunks += rag.index(a.id, safe, text).added; // BM25-indexed for retrieval
      }
    }
    res.json({ ok: true, chunks, knowledge: registry.listKnowledge(a.id), sources: rag.listSources(a.id) });
  });
  app.delete('/api/config/agents/:id/knowledge/:file', (req, res) => {
    registry.removeKnowledge(req.params.id, req.params.file);
    rag.removeSource(req.params.id, req.params.file);
    res.json({ ok: true, knowledge: registry.listKnowledge(req.params.id), sources: rag.listSources(req.params.id) });
  });

  // Learn from a URL: fetch -> strip HTML -> chunk + index.
  app.post('/api/config/agents/:id/learn/url', async (req, res) => {
    const a = registry.getAgent(req.params.id);
    if (!a) return res.status(404).json({ ok: false });
    const url = String(req.body?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: 'invalid url' });
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'AntlerOffice/0.1' } });
      if (!r.ok) return res.status(400).json({ ok: false, error: `fetch ${r.status}` });
      const text = stripHtml(await r.text());
      const dir = registry.knowledgeDir(a.id);
      const name = `url-${new URL(url).hostname}`;
      fs.writeFileSync(path.join(dir, `${name}.extracted.txt`), `# ${url}\n${text}`, 'utf8');
      const { added } = rag.index(a.id, name, text);
      res.json({ ok: true, source: name, chunks: added, sources: rag.listSources(a.id) });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });


  // Knowledge sources (chunk counts) for the agent drawer.
  app.get('/api/config/agents/:id/sources', (req, res) => {
    res.json({ sources: rag.listSources(req.params.id) });
  });

  // ── Per-agent memory (the Hermes layer; view + clear) ─────────────────────
  app.get('/api/config/agents/:id/memory', (req, res) => {
    const a = registry.getAgent(req.params.id);
    const key = a ? a.id : req.params.id;
    res.json({ memory: memory.list(key), pinned: memory.getPinned(key) });
  });
  app.post('/api/config/agents/:id/memory', (req, res) => {
    const a = registry.getAgent(req.params.id);
    const key = a ? a.id : req.params.id;
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'text required' });
    const item = memory.append(key, { kind: 'fact', text, pinned: req.body?.pinned !== false });
    res.json({ ok: !!item, memory: item });
  });
  app.delete('/api/config/agents/:id/memory', (req, res) => {
    const a = registry.getAgent(req.params.id);
    memory.clear(a ? a.id : req.params.id);
    res.json({ ok: true, memory: [] });
  });

  // ── Deliverables inbox ("agent complete job") ─────────────────────────────
  app.get('/api/deliverables', (_req, res) => {
    try {
      require('./work-board').syncPipelineGatesToBoard();
    } catch {
      /* best-effort */
    }
    res.json({ deliverables: registry.listDeliverables() });
  });
  app.post('/api/deliverables/notify', (req, res) => {
    const { kind, summary, task, agentLabel, content } = req.body || {};
    const normalizedKind = kind === 'daily_report' || kind === 'plan_complete' || kind === 'alert' ? kind : 'alert';
    if (!summary && !task && !content) {
      return res.status(400).json({ ok: false, error: 'summary, task, or content required' });
    }
    const item = registry.addBossSummary({
      kind: normalizedKind,
      summary: summary || task,
      task,
      agentLabel,
      content,
    });
    res.json({ ok: true, deliverable: item });
  });
  app.get('/api/deliverables/:id', (req, res) => {
    const d = registry.getDeliverable(req.params.id);
    if (!d) return res.status(404).json({ ok: false });
    res.json({ deliverable: d });
  });
  app.post('/api/deliverables/:id/forward', (req, res) => {
    // Phase 1: mark forwarded. Phase 2 channel manager performs the real send.
    const d = registry.markForwarded(req.params.id, true);
    if (!d) return res.status(404).json({ ok: false });
    const tg = (store.readSettings().notifications || {}).telegram || {};
    res.json({ ok: true, deliverable: d, willSend: !!tg.enabled });
  });
  app.patch('/api/deliverables/:id/progress', (req, res) => {
    const id = String(req.params.id || '').trim();
    const { planSteps, progressPercent, status, kind, summary, standupSections } = req.body || {};
    const d = registry.updateDeliverableProgress(id, {
      planSteps,
      progressPercent,
      status,
      kind,
      summary,
      standupSections,
    });
    if (!d) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, deliverable: d });
  });
  app.post('/api/deliverables/:id/acknowledge-ceo-decision', (req, res) => {
    const id = String(req.params.id || '').trim();
    const workBoard = require('./work-board');
    const d = workBoard.markCeoDecisionAcknowledged({ deliverableId: id });
    if (!d) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, deliverable: d });
  });

  // ── Department standup (config + manual run) ───────────────────────────────
  app.get('/api/department-standup/config', (_req, res) => {
    res.json({
      ok: true,
      config: standupConfig.getConfig(),
      candidates: standupConfig.listOfficeStandupCandidates(),
    });
  });
  app.patch('/api/department-standup/config', (req, res) => {
    try {
      const config = standupConfig.patchConfig(req.body || {});
      const schedule = dailyStandupScheduler.reschedule();
      res.json({
        ok: true,
        config,
        candidates: standupConfig.listOfficeStandupCandidates(),
        schedule,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  app.get('/api/department-standup/status', (_req, res) => {
    res.json({ ok: true, ...departmentStandup.getStatus() });
  });
  app.post('/api/department-standup/run', async (req, res) => {
    const { period, participantIds, wait, threadId } = req.body || {};
    const owner = resolveBossOwner(req);
    try {
      const result = await departmentStandup.runStandup({
        period,
        participantIds,
        ownerKey: owner.ownerKey,
        threadId: threadId || null,
        trigger: 'manual',
        wait: wait !== false,
      });
      res.json(result);
    } catch (e) {
      const code = e.code === 'STANDUP_BUSY' ? 409 : e.code === 'NO_PARTICIPANTS' ? 400 : 500;
      res.status(code).json({ ok: false, error: e.message, code: e.code || 'STANDUP_ERROR' });
    }
  });
  app.post('/api/department-standup/follow-up', async (req, res) => {
    const { deliverableId, sectionIndex, userText, threadId, ownerName } = req.body || {};
    const owner = resolveBossOwner(req);
    try {
      const result = await departmentStandup.runStandupFollowUp({
        deliverableId,
        sectionIndex,
        userText,
        ownerKey: owner.ownerKey,
        ownerName: owner.ownerName || ownerName || 'Boss',
        threadId: threadId || null,
      });
      res.json(result);
    } catch (e) {
      const code =
        e.code === 'NOT_FOUND' || e.code === 'SECTION_NOT_FOUND' ? 404 : e.code === 'EMPTY_QUESTION' ? 400 : 500;
      res.status(code).json({ ok: false, error: e.message, code: e.code });
    }
  });
  app.post('/api/department-standup/:id/export-pdf', async (req, res) => {
    const dest = req.query?.dir === 'materials' ? 'materials' : 'desktop';
    try {
      const result = await standupPdf.exportStandupPdf(String(req.params.id || '').trim(), { dest });
      res.json(result);
    } catch (e) {
      const code = e.code === 'NOT_FOUND' || e.code === 'NO_CONTENT' ? 404 : 500;
      res.status(code).json({ ok: false, error: e.message, code: e.code });
    }
  });
  app.post('/api/department-standup/export-pdf/latest', async (req, res) => {
    const dest = req.query?.dir === 'materials' ? 'materials' : 'desktop';
    try {
      const result = await standupPdf.exportStandupPdf(null, { dest });
      res.json(result);
    } catch (e) {
      const code = e.code === 'NOT_FOUND' || e.code === 'NO_CONTENT' ? 404 : 500;
      res.status(code).json({ ok: false, error: e.message, code: e.code });
    }
  });

  // ── COO heartbeat (discovery + optional autonomous loop) ─────────────────
  app.get('/api/coo-heartbeat/config', (_req, res) => {
    res.json({ ok: true, config: cooHeartbeatConfig.getConfig() });
  });
  app.patch('/api/coo-heartbeat/config', (req, res) => {
    try {
      const config = cooHeartbeatConfig.patchConfig(req.body || {});
      const schedule = cooHeartbeatScheduler.reschedule();
      const loop = cooAutonomousLoop.reschedule();
      res.json({ ok: true, config, schedule, loop });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  app.get('/api/coo-heartbeat/status', (_req, res) => {
    const itRepoQueue = require('./runtime/it-repo-queue');
    res.json({
      ok: true,
      ...cooHeartbeat.getStatus(),
      loop: cooAutonomousLoop.getStatus(),
      repoQueues: itRepoQueue.getQueueStatus(),
    });
  });
  app.get('/api/coo-heartbeat/discovery', (_req, res) => {
    const items = cooHeartbeat.discoverWork();
    res.json({
      ok: true,
      items,
      triageText: cooHeartbeat.buildTriageReport(items),
    });
  });
  app.post('/api/coo-heartbeat/run', async (req, res) => {
    try {
      const result = await cooHeartbeat.runHeartbeat({
        trigger: 'manual',
        wait: req.body?.wait !== false,
      });
      res.json(result);
    } catch (e) {
      const code = e.code === 'busy' ? 409 : 500;
      res.status(code).json({ ok: false, error: e.message, code: e.code || 'HEARTBEAT_ERROR' });
    }
  });

  // ── Materials library (shared folder browser for boss + OpenClaw) ───────────
  app.get('/api/materials', (_req, res) => {
    res.json(materials.workspaceInfo());
  });
  app.get('/api/materials/summary', (_req, res) => {
    res.json(materials.librarySummary());
  });
  app.get('/api/materials/list', (req, res) => {
    const result = materials.listDir(req.query.path || '');
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });
  app.get('/api/materials/stat', (req, res) => {
    const rel = String(req.query.path || '').trim();
    if (!rel) return res.status(400).json({ ok: false, error: 'Path required' });
    const result = materials.statEntry(rel);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  });
  app.get('/api/materials/get', (req, res) => {
    const rel = String(req.query.path || '').trim();
    if (!rel) return res.status(400).json({ ok: false, error: 'Path required' });
    const binary = req.query.binary === 'true';
    const resolved = materials.resolveGetPath(rel);
    if (!resolved.ok) return res.status(404).json(resolved);

    const { abs, stat, ext } = resolved;
    if (binary && (materials.IMG_EXTS.has(ext) || materials.VIDEO_EXTS.has(ext) || materials.PDF_EXTS.has(ext))) {
      const contentType = materials.MIME_BY_EXT[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', stat.size);
      const stream = fs.createReadStream(abs);
      stream.pipe(res);
      stream.on('error', (err) => {
        if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
      });
      return;
    }
    const result = materials.readFileMeta(rel);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  });
  app.post('/api/materials/mkdir', (req, res) => {
    const name = String(req.body?.name || '').trim();
    const parent = String(req.body?.path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!name) return res.status(400).json({ ok: false, error: 'Folder name required' });
    if (/[<>:"|?*\\]/.test(name)) {
      return res.status(400).json({ ok: false, error: 'Invalid folder name' });
    }
    const rel = parent ? `${parent}/${name}` : name;
    const result = materials.mkdir(rel);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });
  app.post('/api/materials/delete', (req, res) => {
    const rel = String(req.body?.path || '').trim();
    if (!rel) return res.status(400).json({ ok: false, error: 'Path required' });
    const result = materials.remove(rel);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });
  app.post('/api/materials/move', (req, res) => {
    const fromPath = String(req.body?.fromPath || '').trim();
    const toPath = String(req.body?.toPath || '').trim();
    if (!fromPath || !toPath) return res.status(400).json({ ok: false, error: 'fromPath and toPath required' });
    const result = materials.move(fromPath, toPath);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });
  app.post('/api/materials/duplicate', (req, res) => {
    const rel = String(req.body?.path || '').trim();
    if (!rel) return res.status(400).json({ ok: false, error: 'Path required' });
    const result = materials.duplicate(rel);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });
  app.post('/api/materials/paste', (req, res) => {
    const mode = req.body?.mode === 'cut' ? 'cut' : 'copy';
    const fromPath = String(req.body?.fromPath || '').trim();
    const toDir = String(req.body?.toDir ?? req.body?.path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!fromPath) return res.status(400).json({ ok: false, error: 'fromPath required' });
    const result = materials.paste({ mode, fromPath, toDir });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });
  app.post('/api/materials/upload', upload.single('file'), (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    const dir = String(req.body?.path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    const result = materials.writeUploadedFile(dir, file.originalname, file.buffer);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });
  app.post('/api/materials/root', (req, res) => {
    const result = req.body?.useDefault
      ? materials.resetToDefaultRoot()
      : materials.setRootPath(req.body?.rootPath);
    if (!result.ok) return res.status(400).json(result);
    res.json({ ...materials.workspaceInfo(), ...result });
  });

  // ── Facebook bound accounts (Chrome profiles; boss-only) ─────────────────
  app.get('/api/fb/accounts', requireBossOnly, (_req, res) => {
    try {
      const fb = require('./fb-playwright-engine');
      const accounts = fb.listAccountsForBoss();
      res.json({ ok: true, count: accounts.length, accounts });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Web login accounts (encrypted local vault; boss-only) ─────────────────
  app.get('/api/catalog/all-required-accounts', (_req, res) => {
    try {
      const data = bundleRequiredAccounts.listAllRequiredAccounts();
      res.json({ ok: true, ...data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Required accounts for currently hired NPCs only (gates the Accounts page UI).
  app.get('/api/catalog/hired-required-accounts', (_req, res) => {
    try {
      const hiredTemplateIds = registry
        .listAgents()
        .filter((a) => registry.isOnTeamAgent(a))
        .map((a) => a.templateId)
        .filter(Boolean);
      const data = bundleRequiredAccounts.listRequiredAccountsForTemplates(hiredTemplateIds);
      res.json({ ok: true, ...data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/catalog/agents/:id', (req, res) => {
    try {
      const entry = bundleRequiredAccounts.loadAgentCatalogEntry(req.params.id);
      if (!entry) return res.status(404).json({ ok: false, error: 'Template not found' });
      res.json(entry);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/accounts', requireBossOnly, (_req, res) => {
    res.json({ ok: true, accounts: webAccounts.listAccountsForBoss() });
  });

  app.get('/api/accounts/:alias/reveal', requireBossOnly, (req, res) => {
    const secrets = webAccounts.revealAccount(req.params.alias);
    if (!secrets) return res.status(404).json({ ok: false, error: 'account not found' });
    res.json({ ok: true, ...secrets });
  });

  app.get('/api/accounts/:alias', requireBossOnly, (req, res) => {
    const account = webAccounts.getAccountByAlias(req.params.alias);
    if (!account) return res.status(404).json({ ok: false, error: 'account not found' });
    res.json({ ok: true, account });
  });

  app.post('/api/accounts', requireBossOnly, (req, res) => {
    try {
      const account = webAccounts.createAccount(req.body || {});
      res.json({ ok: true, account });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.patch('/api/accounts/:alias', requireBossOnly, (req, res) => {
    try {
      const account = webAccounts.updateAccount(req.params.alias, req.body || {});
      res.json({ ok: true, account });
    } catch (e) {
      const status = /not found/i.test(e.message) ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message });
    }
  });

  app.delete('/api/accounts/:alias', requireBossOnly, (req, res) => {
    try {
      webAccounts.deleteAccount(req.params.alias);
      res.json({ ok: true });
    } catch (e) {
      res.status(404).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/accounts/:alias/test', requireBossOnly, (req, res) => {
    try {
      const result = webAccounts.testAccount(req.params.alias);
      res.json(result);
    } catch (e) {
      const status = /not found/i.test(e.message) ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message });
    }
  });

  // ── Browser-capture login flow (boss manually logs in via Chrome) ──────────
  // POST /api/accounts/browser-capture/start
  //   Body: { url, website, displayName, profileId?, allowedActions? }
  //   Opens Chrome to the given URL; returns sessionId
  app.post('/api/accounts/browser-capture/start', requireBossOnly, async (req, res) => {
    try {
      const { url, website, displayName, profileId, allowedActions } = req.body || {};
      const result = await browserCapture.startCapture({ url, website, displayName, profileId, allowedActions });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // POST /api/accounts/browser-capture/:sessionId/finish
  //   Body: { username?, displayName? }
  //   Extracts cookies from the live browser, saves account, closes Chrome
  app.post('/api/accounts/browser-capture/:sessionId/finish', requireBossOnly, async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { username, displayName } = req.body || {};
      const result = await browserCapture.finishCapture(sessionId, { username, displayName });
      res.json(result);
    } catch (e) {
      const status = /not found|expired/i.test(e.message) ? 404 : 400;
      res.status(status).json({ ok: false, error: e.message });
    }
  });

  // DELETE /api/accounts/browser-capture/:sessionId
  //   Cancels an active capture session; closes Chrome without saving
  app.delete('/api/accounts/browser-capture/:sessionId', requireBossOnly, async (req, res) => {
    try {
      const result = await browserCapture.cancelCapture(req.params.sessionId);
      res.json(result);
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // GET /api/accounts/browser-capture/sessions  (debug / admin)
  app.get('/api/accounts/browser-capture/sessions', requireBossOnly, (_req, res) => {
    res.json({ ok: true, sessions: browserCapture.listActiveSessions() });
  });

  // ── Boss instruction (optional targetAgentId for directed chat) ───────────
  app.post('/api/chat/attachment', upload.single('file'), async (req, res) => {
    const owner = resolveBossOwner(req);
    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    const hook = require('./inbound-attachment-hook');
    const source = req.body?.source === 'boss_chat_openclaw' ? 'boss_chat_openclaw' : 'boss_chat_native';
    const result = await hook.receiveBuffer(file.buffer, file.originalname, {
      source,
      threadId: String(req.body?.threadId || '').trim() || null,
      ownerKey: owner.ownerKey,
      uploadedBy: 'ceo',
      agentId: String(req.body?.agentId || '').trim() || null,
      mode: String(req.body?.mode || '').trim() || undefined,
    });
    if (!result.ok && result.status === 'rejected') {
      return res.status(400).json(result);
    }
    res.json(result);
  });

  app.post('/api/inbound/attachment', upload.single('file'), async (req, res) => {
    const owner = resolveBossOwner(req);
    const hook = require('./inbound-attachment-hook');
    const threadId = String(req.body?.threadId || '').trim() || null;
    const source = String(req.body?.source || 'boss_chat').trim() || 'boss_chat';

    if (req.file) {
      const result = await hook.receiveBuffer(req.file.buffer, req.file.originalname, {
        source,
        threadId,
        ownerKey: owner.ownerKey,
        uploadedBy: 'ceo',
        agentId: String(req.body?.agentId || '').trim() || null,
        mode: String(req.body?.mode || '').trim() || undefined,
      });
      if (!result.ok && result.status === 'rejected') {
        return res.status(400).json(result);
      }
      return res.json(result);
    }

    const openclawMediaPath = String(req.body?.openclawMediaPath || req.body?.mediaPath || '').trim();
    if (openclawMediaPath) {
      const result = await hook.ingestOpenClawMedia(openclawMediaPath, {
        source,
        threadId,
        ownerKey: owner.ownerKey,
        uploadedBy: 'ceo',
      });
      if (!result.ok && result.status === 'rejected') {
        return res.status(400).json(result);
      }
      return res.json(result);
    }

    return res.status(400).json({ ok: false, error: 'file or openclawMediaPath required' });
  });

  app.post('/api/inbound/attachment/resolve', async (req, res) => {
    const owner = resolveBossOwner(req);
    const hook = require('./inbound-attachment-hook');
    const pendingId = String(req.body?.pendingId || '').trim();
    const mode = String(req.body?.mode || '').trim();
    const threadId = String(req.body?.threadId || '').trim() || null;
    const agentId = String(req.body?.agentId || '').trim() || null;
    if (!pendingId || !mode) {
      return res.status(400).json({ ok: false, error: 'pendingId and mode required' });
    }
    if (mode !== 'archive' && mode !== 'reference') {
      return res.status(400).json({ ok: false, error: 'mode must be archive or reference' });
    }
    const result = await hook.resolvePending(pendingId, mode, {
      threadId,
      agentId,
      ownerKey: owner.ownerKey,
    });
    if (!result.ok && result.status === 'rejected') {
      return res.status(400).json(result);
    }
    return res.json(result);
  });

  app.post('/api/chat', async (req, res) => {
    const owner = resolveBossOwner(req);
    const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    const result = await handleInstruction(req.body?.text, {
      targetAgentId: req.body?.targetAgentId,
      mode: req.body?.mode,
      threadId: req.body?.threadId,
      authorName: owner.ownerName,
      ownerKey: owner.ownerKey,
      attachments,
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });

  // ── Browser Agent: AI-driven visible browser (Playwright + LLM loop) ─────────
  const browserAgent = require('./browser-agent-loop');

  // POST /api/browser-agent/run  — start a browser task
  // Body: { task, startUrl?, accountId?, headless?, threadId? }
  app.post('/api/browser-agent/run', requireBossOnly, async (req, res) => {
    try {
      const { task, startUrl, accountId, threadId } = req.body || {};
      if (!task) return res.status(400).json({ ok: false, error: 'task is required' });
      // headless: request body overrides store setting; store setting overrides default (false)
      const storeHeadless = store.readSettings().browserAgent?.headless ?? false;
      const headless = req.body?.headless !== undefined ? !!req.body.headless : storeHeadless;

      // Resolve credentials from web-accounts-store if accountId given
      let credentials = {};
      if (accountId) {
        try {
          const webAccounts = require('./web-accounts-store');
          const acc = webAccounts.getAccount(accountId);
          if (acc) {
            credentials = {
              email:    acc.email    || acc.username || '',
              password: acc.password || '',
              phone:    acc.phone    || '',
              company:  acc.company  || '',
            };
          }
        } catch { /* ignore */ }
      }

      // Fire-and-forget — respond immediately with session id, poll for status
      const runPromise = browserAgent.runBrowserTask({
        task,
        startUrl:    startUrl || null,
        credentials,
        headless:    headless === true,
        threadId:    threadId || null,
        maxSteps:    30,
      });

      // Return session id immediately; client polls /status/:id
      runPromise.catch(() => {});
      // Give it 50ms to register session
      await new Promise((r) => setTimeout(r, 50));
      const sessions = browserAgent.listSessions();
      const latest   = sessions[sessions.length - 1];
      res.json({ ok: true, id: latest?.id || 'pending', message: 'Browser agent started' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/browser-agent/status/:id  — poll session progress
  app.get('/api/browser-agent/status/:id', requireBossOnly, (req, res) => {
    const session = browserAgent.getSession(String(req.params.id || ''));
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });
    res.json({ ok: true, session });
  });

  // GET /api/browser-agent/sessions  — list all sessions
  app.get('/api/browser-agent/sessions', requireBossOnly, (_req, res) => {
    res.json({ ok: true, sessions: browserAgent.listSessions() });
  });

  // POST /api/browser-agent/stop/:id  — cancel a running session
  app.post('/api/browser-agent/stop/:id', requireBossOnly, (req, res) => {
    const result = browserAgent.stopSession(String(req.params.id || ''));
    res.json(result);
  });

  // GET  /api/browser-agent/settings  — read headless preference
  app.get('/api/browser-agent/settings', requireBossOnly, (_req, res) => {
    const s = store.readSettings();
    res.json({ ok: true, headless: s.browserAgent?.headless ?? false });
  });

  // POST /api/browser-agent/settings  — save headless preference
  // Body: { headless: true|false }
  app.post('/api/browser-agent/settings', requireBossOnly, (req, res) => {
    const headless = !!req.body?.headless;
    const s = store.readSettings();
    store.writeSettings({ ...s, browserAgent: { ...(s.browserAgent || {}), headless } });
    res.json({ ok: true, headless });
  });

  // ── Tool Intake: COO analyses GitHub URLs / API PDFs before installing ───────
  const toolIntake = require('./tool-intake');

  // GET  /api/tool-intake/pending  — return staged analysis list
  app.get('/api/tool-intake/pending', requireBossOnly, (_req, res) => {
    res.json({ ok: true, items: toolIntake.getPendingInstalls() });
  });

  // POST /api/tool-intake/analyze  — analyse on demand (boss pastes URLs in UI)
  app.post('/api/tool-intake/analyze', requireBossOnly, async (req, res) => {
    try {
      const text = String(req.body?.text || '').trim();
      const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
      if (!text && !attachments.length) {
        return res.status(400).json({ ok: false, error: 'No text or attachments provided' });
      }
      const items = await toolIntake.analyzeMessage(text, attachments);
      if (!items || !items.length) {
        return res.json({ ok: true, items: [], message: 'No GitHub URLs or PDF attachments found' });
      }
      toolIntake.stagePendingInstalls(items);
      res.json({ ok: true, items });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/tool-intake/install-selected  — boss confirmed, install chosen items
  // Body: { indices: [1, 3] }  (1-based indices from the pending list)
  app.post('/api/tool-intake/install-selected', requireBossOnly, async (req, res) => {
    try {
      const indices = Array.isArray(req.body?.indices)
        ? req.body.indices.map(Number).filter((n) => Number.isFinite(n) && n > 0)
        : [];
      if (!indices.length) {
        return res.status(400).json({ ok: false, error: 'No indices provided' });
      }
      const result = await toolIntake.executeSelectedInstalls(indices);
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /api/tool-intake/clear  — discard pending plan
  app.post('/api/tool-intake/clear', requireBossOnly, (_req, res) => {
    toolIntake.clearPendingInstalls();
    res.json({ ok: true });
  });

  // ── Onboarding: detect + install OpenClaw (execution) ─────────────────────
  app.get('/api/onboard/state', async (_req, res) => {
    try {
      res.json(await onboard.getAppState());
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  app.get('/api/onboard/status', async (_req, res) => {
    res.json(await onboard.detect());
  });
  app.post('/api/onboard/install', (req, res) => {
    res.json(onboard.install((req.body || {}).name));
  });
  app.get('/api/dev/tools/status', async (_req, res) => {
    try {
      const { probeAll } = require('./runtime/dev-engine-registry');
      const engines = await probeAll();
      res.json({ ok: true, ...engines, cursor: engines.cursor, codex: engines.codex, claude: engines.claude });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  function redactDevSettings(dev = {}) {
    const out = { ...dev };
    out.cursorApiKeySet = Boolean(String(out.cursorApiKey || '').trim());
    out.codexApiKeySet = Boolean(String(out.codexApiKey || '').trim());
    out.claudeApiKeySet = Boolean(String(out.claudeApiKey || '').trim());
    delete out.cursorApiKey;
    delete out.codexApiKey;
    delete out.claudeApiKey;
    return out;
  }
  app.get('/api/dev/agents', (_req, res) => {
    try {
      const devTeamResolver = require('./runtime/dev-team-resolver');
      const agents = devTeamResolver.listDevAgents();
      const team = devTeamResolver.getDevTeamSettings();
      res.json({ ok: true, agents, devTeam: team });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  app.get('/api/dev/settings', async (_req, res) => {
    const s = store.readSettings();
    const dev = redactDevSettings(s.dev || {});
    try {
      const codexCli = require('./runtime/codex-cli');
      dev.codexAuthReady = await codexCli.hasCodexAuth();
    } catch {
      dev.codexAuthReady = false;
    }
    res.json({ ok: true, dev });
  });
  app.post('/api/dev/security-scan', async (req, res) => {
    try {
      const itScanGate = require('./it-scan-gate');
      const projectRoot = String(req.body?.projectRoot || '').trim() || null;
      const gate = await itScanGate.runItScanGate({
        projectRoot,
        threadId: `manual-scan:${Date.now()}`,
        instruction: req.body?.instruction || '',
        rawTask: req.body?.task || 'Manual security scan',
        shortTask: 'Manual scan',
      });
      if (gate.needsProjectPath) {
        return res.status(400).json({ ok: false, error: gate.resolver?.message || 'project path required' });
      }
      res.json({
        ok: true,
        report: gate.report,
        decision: gate.decision,
        markdown: gate.markdown,
        deliverableId: gate.deliverableId,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  app.put('/api/dev/settings', async (req, res) => {
    try {
      const s = store.readSettings();
      const body = req.body || {};
      const nextDev = { ...(s.dev || {}), ...body };
      if (body.projectRootOverride === null || body.projectRootOverride === '') {
        nextDev.projectRootOverride = null;
      }
      if (typeof body.cursorApiKey === 'string' && body.cursorApiKey.trim()) {
        nextDev.cursorApiKey = body.cursorApiKey.trim();
      } else {
        nextDev.cursorApiKey = s.dev?.cursorApiKey || '';
      }
      let codexLogin = null;
      if (typeof body.codexApiKey === 'string' && body.codexApiKey.trim()) {
        nextDev.codexApiKey = body.codexApiKey.trim();
        try {
          const codexCli = require('./runtime/codex-cli');
          codexLogin = await codexCli.ensureCodexLogin(nextDev.codexApiKey);
        } catch (e) {
          codexLogin = { ok: false, error: e.message };
        }
      } else {
        nextDev.codexApiKey = s.dev?.codexApiKey || '';
      }
      if (typeof body.claudeApiKey === 'string' && body.claudeApiKey.trim()) {
        nextDev.claudeApiKey = body.claudeApiKey.trim();
      } else {
        nextDev.claudeApiKey = s.dev?.claudeApiKey || '';
      }
      if (body.devTeam && typeof body.devTeam === 'object') {
        nextDev.devTeam = {
          writerAgentId: body.devTeam.writerAgentId ?? s.dev?.devTeam?.writerAgentId ?? null,
          reviewerAgentIds: Array.isArray(body.devTeam.reviewerAgentIds)
            ? body.devTeam.reviewerAgentIds.filter(Boolean)
            : s.dev?.devTeam?.reviewerAgentIds || [],
        };
      }
      delete nextDev.cursorApiKeySet;
      delete nextDev.codexApiKeySet;
      delete nextDev.claudeApiKeySet;
      s.dev = nextDev;
      store.writeSettings(s);
      const dev = redactDevSettings(s.dev);
      const codexCli = require('./runtime/codex-cli');
      dev.codexAuthReady = await codexCli.hasCodexAuth();
      res.json({ ok: true, dev, codexLogin });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  app.get('/api/onboard/log', (_req, res) => {
    res.json(onboard.getLog());
  });
  // Save the OpenAI API key into OpenClaw's config (no CLI for the user).
  app.post('/api/onboard/openclaw-key', async (req, res) => {
    const { provider, apiKey, model } = req.body || {};
    res.json(await onboard.setOpenClawKey({ provider, apiKey, model }));
  });
  app.post('/api/onboard/ai-skip', (_req, res) => {
    res.json({ ok: true, onboarding: onboard.markAiSkipped() });
  });
  app.post('/api/onboard/company-profile', (req, res) => {
    try {
      res.json(onboard.saveCompanyProfile(req.body || {}));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  app.post('/api/onboard/installer-complete', async (_req, res) => {
    try {
      res.json(await onboard.markInstallerComplete());
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Skill Install Log ─────────────────────────────────────────────────────
  // Record a skill install (called from frontend after wizard/settings install)
  app.post('/api/skill-installs/record', async (req, res) => {
    try {
      const body = req.body || {};
      const entry = await skillInstallLog.recordInstall({
        skillName: body.skillName,
        skillId: body.skillId,
        source: body.source,
        sourceUrl: body.sourceUrl,
        npcTemplateId: body.npcTemplateId,
        npcName: body.npcName,
        tenantId: body.tenantId,
        triggeredBy: body.triggeredBy || 'user',
        status: body.status || 'installed',
        errorMessage: body.errorMessage,
      });
      res.json({ ok: true, entry });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // List installs — admin only
  app.get('/api/admin/skill-installs', requireBossOnly, (req, res) => {
    try {
      const { limit, npcTemplateId, source, status } = req.query;
      const entries = skillInstallLog.listInstalls({ limit, npcTemplateId, source, status });
      res.json({ ok: true, entries, total: entries.length });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Summary grouped by skill — useful for "X users installed Y" view
  app.get('/api/admin/skill-installs/summary', requireBossOnly, (_req, res) => {
    try {
      res.json({ ok: true, summary: skillInstallLog.getInstallSummary() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/onboard/mcp-pack/status', async (_req, res) => {
    res.json(await defaultMcpPack.getStatus());
  });
  app.post('/api/onboard/mcp-pack/apply', async (req, res) => {
    const body = req.body || {};
    try {
      const result = await defaultMcpPack.applyDefaultMcpPack({
        enableCoo: body.enableCoo !== false,
        enableAdmin: body.enableAdmin !== false,
        enableIt: body.enableIt !== false,
        enableGraphicDesign: !!body.enableGraphicDesign,
        perplexityApiKey: String(body.perplexityApiKey || '').trim(),
        firecrawlApiKey: String(body.firecrawlApiKey || '').trim(),
        glifApiKey: String(body.glifApiKey || '').trim(),
        installPlaywright: body.installPlaywright !== false,
      });
      res.json(result);
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  // Install ONE candidate MCP the user picked in onboarding, and bind it to the
  // hired agent of this template. Only the chosen one is installed; the account
  // token is resolved + decrypted server-side and only fed into the MCP env.
  app.post('/api/onboard/mcp/install', requireBossOnly, async (req, res) => {
    const body = req.body || {};
    try {
      const templateId = String(body.templateId || '').trim();
      const slug = String(body.slug || '').trim();
      const accountAlias = String(body.accountAlias || '').trim();
      if (!templateId || !slug) {
        return res.status(400).json({ ok: false, error: 'templateId and slug required' });
      }
      const account = accountAlias ? webAccounts.resolveInternalAccount(accountAlias) : null;
      const result = await defaultMcpPack.installMcpForTemplate({ templateId, slug, account });
      res.json(result);
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  // ── OpenClaw runtime status (drives onboarding + office "connected" badge) ─
  app.get('/api/openclaw/status', async (_req, res) => {
    const available = await openclaw.isAvailable();
    if (!available) return res.json({ available: false });
    const [gateway, models] = await Promise.all([openclaw.gatewayStatus(), openclaw.modelsStatus()]);
    res.json({ available: true, gateway, models, health: openclaw.getHealth() });
  });

  // ── Models: list catalog, set default, add a provider key ─────────────────
  app.get('/api/openclaw/models', async (req, res) => {
    res.json(await openclaw.listModels({ all: req.query.all === '1' || req.query.all === 'true' }));
  });
  app.post('/api/openclaw/model', async (req, res) => {
    const ref = String(req.body?.ref || '').trim();
    if (!ref) return res.json({ ok: false, error: 'missing model ref' });
    const r = await openclaw.setModel(ref);
    openclaw.invalidate();
    res.json(r);
  });
  // Save a key for any provider OpenClaw supports (no model change / no test —
  // the test happens once that provider's model is set as the active default).
  app.post('/api/openclaw/provider-key', async (req, res) => {
    const provider = String(req.body?.provider || '').trim();
    const apiKey = String(req.body?.apiKey || '').trim();
    if (!provider || !apiKey) return res.json({ ok: false, error: 'missing provider or apiKey' });
    res.json(await openclaw.setKey(provider, apiKey));
  });
  app.delete('/api/openclaw/provider-key', async (req, res) => {
    const provider = String(req.query?.provider || req.body?.provider || '').trim();
    const profileId = String(req.query?.profileId || req.body?.profileId || '').trim() || undefined;
    if (!provider) return res.json({ ok: false, error: 'missing provider' });
    res.json(await openclaw.deleteKey(provider, { profileId }));
  });

  // ── Usage + key overview (drives the Settings page) ───────────────────────
  app.get('/api/usage', async (_req, res) => {
    const available = await openclaw.isAvailable();
    if (!available) {
      return res.json({ available: false, usage: openclaw.getUsage(), health: openclaw.getHealth(), keys: [] });
    }
    const models = await openclaw.modelsStatus();
    const st = models.status || {};
    const keys = [];
    for (const p of st.auth?.providers || []) {
      for (const label of p.profiles?.labels || []) {
        const labelStr = String(label || '');
        const eq = labelStr.indexOf('=');
        const profileId = eq > 0 ? labelStr.slice(0, eq) : `${p.provider}:default`;
        const secret = eq >= 0 ? labelStr.slice(eq + 1) : labelStr;
        const tail = secret.includes('...') ? secret.split('...').pop() : secret;
        const last4 = String(tail || '').slice(-4);
        const masked = last4 ? `••••••••${last4}` : '••••••••';
        keys.push({ provider: p.provider, label: labelStr, profileId, masked, last4 });
      }
    }
    res.json({
      available: true,
      model: st.resolvedDefault || st.defaultModel || '',
      keys, // label is already masked by OpenClaw, e.g. "openai:default=sk-...IZlH3scA"
      usage: openclaw.getUsage(),
      health: openclaw.getHealth(),
    });
  });

  // ── ECS sync status (topbar indicator) ────────────────────────────────────
  app.get('/api/sync/status', (_req, res) => res.json(ecssync.getStatus()));
  app.post('/api/sync/push', async (_req, res) => res.json(await ecssync.pushOnce()));

  // ── Antler settings (avoid /api/settings — may conflict with Admin) ───────
  app.get('/api/antler/settings', (_req, res) => {
    res.json(redact(store.readSettings()));
  });
  app.post('/api/antler/settings', async (req, res) => {
    const incoming = req.body || {};
    const saved = store.writeSettings(mergeIncoming(store.readSettings(), incoming));
    if (incoming.office?.desktopDisplayName !== undefined) {
      await syncDesktopDisplayNameToEcs(req, saved.office?.desktopDisplayName || '');
    }
    openclaw.invalidate();
    ecssync.refresh();
    res.json(redact(saved));
  });

  // ── Payslip / billing ledger (boss only) ───────────────────────────────────
  app.get('/api/billing/payslip', async (req, res) => {
    if (!requireBossOnlyRoute(req, res)) return;
    try {
      const { ecsToken, officeId } = resolveEcsBillingContext(req);
      const period = String(req.query.period || '').trim() || undefined;
      const page = Number(req.query.page) || 1;
      const pageSize = Number(req.query.pageSize) || 20;
      const sortBy = String(req.query.sortBy || 'at');
      const sortOrder = req.query.sortOrder === 'ascend' ? 'ascend' : 'descend';
      const data = await payslip.getPayslip({
        ecsToken,
        officeId,
        period,
        page,
        pageSize,
        sortBy,
        sortOrder,
      });
      res.json({ ok: true, ...data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/billing/payslip/export', async (req, res) => {
    if (!requireBossOnlyRoute(req, res)) return;
    try {
      const { ecsToken, officeId } = resolveEcsBillingContext(req);
      const period = String(req.query.period || '').trim() || undefined;
      const data = await payslip.exportPayslip({ ecsToken, officeId, period });
      res.json({ ok: true, ...data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/usage/agent', (req, res) => {
    if (!requireBossOnlyRoute(req, res)) return;
    const agentId = String(req.query.agentId || '').trim();
    const period = String(req.query.period || '').trim() || undefined;
    if (!agentId) return res.status(400).json({ ok: false, error: 'agentId required' });
    res.json({
      ok: true,
      agentId,
      period: period || agentUsageStore.formatPeriod(),
      usage: agentUsageStore.getAgentUsage(agentId, period),
    });
  });

  app.get('/api/catalog/worker-entitlements', async (_req, res) => {
    try {
      const data = await workerEntitlements.loadEntitlements();
      res.json({ ok: true, ...data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/usage/classify', async (req, res) => {
    try {
      const { homeWorkerId, skillIds, mcpIds } = req.body || {};
      const result = await workerEntitlements.classifyTaskUsage({
        homeWorkerId,
        skillIds: Array.isArray(skillIds) ? skillIds : [],
        mcpIds: Array.isArray(mcpIds) ? mcpIds : [],
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/usage/paygo', async (req, res) => {
    if (!requireBossOnlyRoute(req, res)) return;
    try {
      const paygoMeter = require('./paygo-meter');
      const agentId = String(req.query.agentId || '').trim() || undefined;
      const limit = Number(req.query.limit) || 100;
      res.json({ ok: true, entries: paygoMeter.listUsage({ agentId, limit }) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/usage/meter', async (req, res) => {
    if (!requireBossOnlyRoute(req, res)) return;
    try {
      const agent = registry.getAgent(req.body?.agentId);
      if (!agent) return res.status(404).json({ ok: false, error: 'Agent not found' });
      const bossToken = req.headers['x-boss-token'] || req.body?.bossToken;
      const result = await taskMeter.meterTaskRun(agent, {
        skillIds: req.body?.skillIds,
        mcpIds: req.body?.mcpIds,
        tokens: req.body?.tokens,
        bossToken,
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  voiceService.registerVoiceRoutes(app, upload, { resolveBossOwner });

  // Realtime voice session (OpenAI Realtime API ephemeral token)
  const voiceRealtimeService = require('./voice-realtime-service');
  voiceRealtimeService.registerRealtimeRoutes(app);

  // Voice v2 — 干净的 Realtime + 本地 COO 中转，随主程序启动。/api/voice2/*
  const voice2 = require('./voice2');
  voice2.registerVoice2Routes(app, { resolveBossOwner });
}

function attachAntlerOffice(httpServer) {
  attachPaBridge(httpServer);
  const mcpPort = Number(process.env.ANTLEROFFICE_MCP_PORT) || 8931;
  antlerofficeMcp.startStandaloneServer(mcpPort);
  // Voice sidecars start after HTTP binds (see index.js onServerListening).
}

function attachGatewayOfficeSync(gateway) {
  return gatewayOfficeAdapter.attachGateway(gateway);
}

module.exports = { registerAntlerRoutes, attachAntlerOffice, attachGatewayOfficeSync };

async function extractText(filename, buffer) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.txt' || ext === '.md' || ext === '.csv' || ext === '.json') return buffer.toString('utf8');
  if (ext === '.pdf') {
    try {
      const d = await pdfParse(buffer);
      return d.text || '';
    } catch {
      return '';
    }
  }
  return ''; // other types are stored but not text-extracted
}

// Crude HTML -> text: drop scripts/styles/tags, collapse whitespace. Good enough
// to feed the RAG chunker for learn-from-URL / ClawHub imports.
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Hide a user agent's Telegram bot token; report whether one is set.
function redactMcpAccount(account) {
  if (!account) return null;
  const auth = account.auth && typeof account.auth === 'object' ? account.auth : {};
  const oauth = auth.oauth && typeof auth.oauth === 'object' ? auth.oauth : {};
  const authConnected =
    account.authType === 'none' ||
    (account.authType === 'api_key' && !!auth.apiKey) ||
    (account.authType === 'bearer' && !!auth.bearerToken) ||
    (account.authType === 'oauth' && !!oauth.accessToken);
  return {
    id: account.id,
    label: account.label,
    authType: account.authType,
    connectedAt: account.connectedAt,
    authConnected,
    auth: {
      apiKeySet: !!auth.apiKey,
      bearerSet: !!auth.bearerToken,
      oauthConnected: !!oauth.accessToken,
      oauth: {
        clientId: oauth.clientId || '',
        scopes: oauth.scopes || '',
        authorizeUrl: oauth.authorizeUrl || '',
        tokenUrl: oauth.tokenUrl || '',
        clientSecretSet: !!oauth.clientSecret,
        accessTokenSet: !!oauth.accessToken,
      },
    },
  };
}

function redactMcp(m) {
  const accounts = Array.isArray(m.accounts)
    ? m.accounts.map(redactMcpAccount)
    : [];
  const legacyAuth = m.auth && typeof m.auth === 'object' ? m.auth : {};
  const legacyOauth = legacyAuth.oauth && typeof legacyAuth.oauth === 'object' ? legacyAuth.oauth : {};
  return {
    ...m,
    authRequired: !!m.authRequired,
    suggestedAuthType: m.suggestedAuthType || 'none',
    lastProbeAt: m.lastProbeAt || null,
    defaultAccountId: m.defaultAccountId || null,
    accountCount: m.accountCount ?? accounts.length,
    connectedAccountCount: m.connectedAccountCount ?? accounts.filter((a) => a.authConnected).length,
    accounts,
    auth: {
      apiKeySet: !!legacyAuth.apiKey,
      bearerSet: !!legacyAuth.bearerToken,
      oauthConnected: !!legacyOauth.accessToken,
      oauth: {
        clientId: legacyOauth.clientId || '',
        scopes: legacyOauth.scopes || '',
        authorizeUrl: legacyOauth.authorizeUrl || '',
        tokenUrl: legacyOauth.tokenUrl || '',
        clientSecretSet: !!legacyOauth.clientSecret,
        accessTokenSet: !!legacyOauth.accessToken,
      },
    },
  };
}

function redactAgent(a) {
  const out = JSON.parse(JSON.stringify(a));
  const tg = out.channels?.telegram;
  if (tg) {
    out.channels.telegram = { ...tg, botToken: '', botTokenSet: Boolean(tg.botToken) };
  }
  return out;
}

// On update, keep the existing bot token if the incoming one is blank.
function mergeAgentIncoming(existing, incoming) {
  const next = { ...incoming };
  if (next.channels?.telegram && !next.channels.telegram.botToken) {
    next.channels.telegram.botToken = existing.channels?.telegram?.botToken || '';
  }
  return next;
}

// Don't ship secrets back to the browser; send a boolean "isSet" instead.
function redact(settings) {
  const out = JSON.parse(JSON.stringify(settings));
  for (const key of Object.keys(out.providers || {})) {
    const p = out.providers[key];
    p.hasKey = Boolean(p.apiKey);
    delete p.apiKey;
  }
  if (out.notifications?.telegram) {
    out.notifications.telegram.botTokenSet = Boolean(out.notifications.telegram.botToken);
    delete out.notifications.telegram.botToken;
  }
  return out;
}

// Keep existing secrets if the incoming payload omits them.
function mergeIncoming(current, incoming) {
  const next = JSON.parse(JSON.stringify(current));
  if (incoming.defaultProvider) next.defaultProvider = incoming.defaultProvider;
  if (incoming.npcBrains) next.npcBrains = { ...next.npcBrains, ...incoming.npcBrains };
  if (incoming.auth) next.auth = { ...next.auth, ...incoming.auth };
  if (incoming.providers) {
    for (const key of Object.keys(incoming.providers)) {
      const inc = incoming.providers[key];
      if (!next.providers[key]) next.providers[key] = {};
      if (typeof inc.model === 'string') next.providers[key].model = inc.model;
      if (typeof inc.apiKey === 'string' && inc.apiKey.length > 0) {
        next.providers[key].apiKey = inc.apiKey;
      }
    }
  }
  if (incoming.notifications) {
    const n = incoming.notifications;
    if (typeof n.forwardDeliverables === 'boolean') next.notifications.forwardDeliverables = n.forwardDeliverables;
    if (n.telegram) {
      if (typeof n.telegram.enabled === 'boolean') next.notifications.telegram.enabled = n.telegram.enabled;
      if (typeof n.telegram.chatId === 'string') next.notifications.telegram.chatId = n.telegram.chatId;
      if (typeof n.telegram.botToken === 'string' && n.telegram.botToken.length > 0) {
        next.notifications.telegram.botToken = n.telegram.botToken;
      }
    }
  }
  if (incoming.runtimes) {
    for (const name of ['openclaw', 'hermes']) {
      const inc = incoming.runtimes[name];
      if (!inc) continue;
      next.runtimes[name] = { ...next.runtimes[name], ...inc };
    }
  }
  if (incoming.sync) {
    if (typeof incoming.sync.enabled === 'boolean') next.sync.enabled = incoming.sync.enabled;
    if (Number.isFinite(incoming.sync.intervalMs)) next.sync.intervalMs = incoming.sync.intervalMs;
  }
  if (incoming.advanced && typeof incoming.advanced.showRawOutput === 'boolean') {
    next.advanced.showRawOutput = incoming.advanced.showRawOutput;
  }
  if (incoming.office) {
    next.office = { ...next.office, ...incoming.office };
    if (typeof incoming.office.bossDisplayName === 'string') {
      next.office.bossDisplayName = incoming.office.bossDisplayName.trim().slice(0, 80);
    }
    if (typeof incoming.office.desktopDisplayName === 'string') {
      next.office.desktopDisplayName = incoming.office.desktopDisplayName.trim().slice(0, 80);
    }
    if (incoming.office.models && typeof incoming.office.models === 'object') {
      next.office.models = { ...(next.office.models || {}), ...incoming.office.models };
    }
    if (incoming.office.companyFramework && typeof incoming.office.companyFramework === 'object') {
      const companyFramework = require('./company-framework');
      next.office.companyFramework = companyFramework.normalizeFramework({
        ...(next.office.companyFramework || {}),
        ...incoming.office.companyFramework,
      });
    }
  }
  return next;
}

function resolveBossDisplayName(session) {
  const custom = String(store.readSettings().office?.bossDisplayName || '').trim();
  if (custom) return custom;
  if (session?.user?.name) return String(session.user.name).trim();
  if (session?.username) return String(session.username).trim();
  return 'Boss';
}

function resolveDesktopDisplayName() {
  const custom = String(store.readSettings().office?.desktopDisplayName || '').trim();
  if (custom) return custom;
  return require('node:os').hostname();
}

async function syncDesktopDisplayNameToEcs(req, displayName) {
  const token = req.headers['x-boss-token'] || req.body?.bossToken;
  const s = auth.session(token);
  if (!s?.ecsAccessToken || !displayName) return;
  const base = auth.ecsBaseUrl();
  if (!base) return;
  const desktopId = ecssync.desktopId();
  try {
    await fetch(`${base}/api/desktops/${encodeURIComponent(desktopId)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${s.ecsAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName }),
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    /* ECS sync best-effort */
  }
}

