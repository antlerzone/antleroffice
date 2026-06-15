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
const billing = require('./billing');
const payroll = require('./payroll');
const agentCatalog = require('./agent-catalog');
const mcpProbe = require('./mcp-probe');
const mcpOAuth = require('./mcp-oauth');
const { handleInstruction } = require('./agent-runtime');
const bossChat = require('./boss-chat-store');
const { attachPaBridge, getOfficePresence } = require('./pa-bridge');
const gatewayOfficeAdapter = require('./gateway-office-adapter');
const materials = require('./materials.cjs');

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
        ownerName: s.user.name || s.user.email || 'Boss',
      };
    }
    if (s?.user?.email) {
      return {
        ownerKey: `email:${s.user.email}`,
        ownerName: s.user.name || s.user.email,
      };
    }
  }
  if (req.officeMember?.userId) {
    return {
      ownerKey: `user:${req.officeMember.userId}`,
      ownerName: req.officeMember.name || 'Member',
    };
  }
  return { ownerKey: 'local:boss', ownerName: 'Boss' };
}

function registerAntlerRoutes(app) {
  store.setDataDir();
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

  // Seed only the COO · OpenClaw supervisor. Every other worker is hired (added)
  // by the client from the Agents page, then mirrored into the office below.
  for (const d of roster.defaults()) {
    const a = office.ensureRole(d.role, d.label, d.charSprite);
    const saved = registry.getBuiltinAgentSettings(d.role);
    const bootPatch = {};
    if (saved.label) bootPatch.label = saved.label;
    if (Number.isInteger(saved.sprite)) bootPatch.charSprite = saved.sprite;
    if (Number.isInteger(saved.hueShift)) bootPatch.hueShift = saved.hueShift;
    if (Object.keys(bootPatch).length) office.setAgent(a.id, bootPatch);
  }
  // Hydrate user-created agents persisted from previous sessions.
  office.loadUserAgents(registry.listAgents());
  for (const a of registry.listAgents()) {
    if (a.payrollStatus === 'suspended') payroll.syncOfficePayroll(a);
  }

  async function refreshBillingAndFires() {
    try {
      await payroll.processPendingFires(openclaw);
      payroll.runPayrollDue();
    } catch (e) {
      debugLog.logWarn('payroll', e.message);
    }
    auth.refreshAllSessionCredits();
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
      await auth.refreshSessionFromEcs(s);
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
      const ecsResult = await ecsSubscriptions.payrollHeartbeat({
        ecsToken: s.ecsAccessToken,
        agents,
      });
      if (ecsResult.ok) {
        if (typeof ecsResult.creditBalance === 'number') {
          billing.setBalance(ecsResult.creditBalance, { reason: 'ecs_heartbeat' });
          s.creditBalance = ecsResult.creditBalance;
        }
        await applyEcsPayrollResults(ecsResult.payrollResults || []);
      }
    }

    auth.syncSessionCredits(s);
    return { ok: true, session: auth.publicView(s) };
  }
  refreshBillingAndFires();
  setInterval(refreshBillingAndFires, 15 * 60 * 1000).unref();
  setInterval(() => payroll.processPendingFires(openclaw).catch(() => {}), 60 * 60 * 1000).unref();

  // Remove imported agents whose desktop stopped sending heartbeats (offline).
  setInterval(() => office.pruneExternal(30000), 10000).unref();

  // Start the ECS mirror (no-op until sync is enabled + auth.baseUrl is set).
  ecssync.refresh();

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
    const frontend = process.env.OAUTH_FRONTEND_ORIGIN || process.env.DEV_FRONTEND_URL || 'http://localhost:3001';
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
    if (!agentId) return res.status(400).json({ ok: false, error: 'agentId required' });
    const owner = resolveBossOwner(req);
    res.json({
      ok: true,
      ownerKey: owner.ownerKey,
      ownerName: owner.ownerName,
      threads: bossChat.threadSummaries(agentId, owner.ownerKey),
    });
  });
  app.post('/api/boss-chats', (req, res) => {
    const agentId = String(req.body?.agentId || '').trim();
    if (!agentId) return res.status(400).json({ ok: false, error: 'agentId required' });
    const owner = resolveBossOwner(req);
    const thread = bossChat.createThread(agentId, req.body?.title, owner);
    res.json({ ok: true, thread: { ...thread, messageCount: 0 } });
  });
  app.patch('/api/boss-chats/:id', (req, res) => {
    const threadId = String(req.params.id || '').trim();
    const owner = resolveBossOwner(req);
    if (req.body?.pinned !== undefined) {
      const thread = bossChat.setPinned(threadId, owner.ownerKey, !!req.body.pinned);
      if (!thread) return res.status(404).json({ ok: false, error: 'thread not found' });
      return res.json({
        ok: true,
        thread: {
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
    return res.status(400).json({ ok: false, error: 'nothing to update' });
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

  // ── OpenClaw-compatible command channel ───────────────────────────────────
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
      const templates = await ecsCatalog.catalogWithStatusMerged();
      res.json({ templates, source: ecsCatalog.ecsBaseUrl() ? 'ecs' : 'local' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  app.post('/api/config/agents/hire', async (req, res) => {
    try {
      const { templateId, name } = req.body || {};
      const bossToken = req.headers['x-boss-token'] || req.body?.token;
      const result = await agentCatalog.hireFromTemplate({ templateId, name, bossToken });
      auth.refreshAllSessionCredits();
      res.json({
        ok: true,
        agent: redactAgent(result.agent),
        creditBalance: result.balance,
        openclaw: result.openclaw,
        postInstall: result.postInstall || null,
      });
    } catch (e) {
      const status =
        e.code === 'INSUFFICIENT_CREDITS' ? 409 : e.code === 'ALREADY_HIRED' ? 409 : e.code === 'UNKNOWN_TEMPLATE' ? 404 : 400;
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
    office.loadUserAgents([a]); // mirror into the office immediately
    res.json({ ok: true, agent: redactAgent(a), openclaw: { available: oc.available !== false, agentId: openclawAgentId, error: oc.error } });
  });
  app.get('/api/config/agents/:id', (req, res) => {
    const a = registry.getAgent(req.params.id);
    if (!a) return res.status(404).json({ ok: false });
    res.json({ agent: redactAgent(a), knowledge: registry.listKnowledge(a.id) });
  });
  app.put('/api/config/agents/:id', (req, res) => {
    const existing = registry.getAgent(req.params.id);
    if (!existing) return res.status(404).json({ ok: false });
    const patch = mergeAgentIncoming(existing, req.body || {});
    const a = registry.updateAgent(req.params.id, patch);
    // Keep the live office NPC in sync (label, costume).
    office.setAgent(`user:${a.id}`, {
      label: a.name,
      role: a.role,
      charSprite: a.sprite,
      hueShift: a.hueShift,
      skillIds: a.skillIds,
      openclawSkillNames: a.openclawSkillNames || [],
      mcpIds: a.mcpIds,
      mcpBindings: a.mcpBindings,
      channels: a.channels,
    });
    res.json({ ok: true, agent: redactAgent(a) });
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
    res.json({
      ok: true,
      agent: redactAgent(a),
      live: liveNpc
        ? {
            npcState: liveNpc.npcState,
            bubbleText: liveNpc.bubbleText || '',
            currentJob: liveNpc.currentJob || null,
          }
        : { npcState: 'resting', bubbleText: '', currentJob: null },
      openclawSkills: a.openclawSkillNames || [],
      knowledge: registry.listKnowledge(a.id),
      recentDeliverables,
      openclawAvailable: !!oc.available,
    });
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
  // Set which agent an inbound channel routes to (COO by default; COO delegates).
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
    res.json({ memory: memory.list(key) });
  });
  app.delete('/api/config/agents/:id/memory', (req, res) => {
    const a = registry.getAgent(req.params.id);
    memory.clear(a ? a.id : req.params.id);
    res.json({ ok: true, memory: [] });
  });

  // ── Deliverables inbox ("agent complete job") ─────────────────────────────
  app.get('/api/deliverables', (_req, res) => res.json({ deliverables: registry.listDeliverables() }));
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

  // ── Materials library (shared folder browser for boss + OpenClaw) ───────────
  app.get('/api/materials', (_req, res) => {
    res.json(materials.workspaceInfo());
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
  app.post('/api/materials/root', (req, res) => {
    const result = materials.setRootPath(req.body?.rootPath);
    if (!result.ok) return res.status(400).json(result);
    res.json({ ...materials.workspaceInfo(), ...result });
  });

  // ── Boss instruction (optional targetAgentId for directed chat) ───────────
  app.post('/api/chat', async (req, res) => {
    const owner = resolveBossOwner(req);
    const result = await handleInstruction(req.body?.text, {
      targetAgentId: req.body?.targetAgentId,
      mode: req.body?.mode,
      threadId: req.body?.threadId,
      authorName: owner.ownerName,
      ownerKey: owner.ownerKey,
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });

  // ── Onboarding: detect + install OpenClaw (execution) + Hermes (memory) ───
  app.get('/api/onboard/status', async (_req, res) => {
    res.json(await onboard.detect());
  });
  app.post('/api/onboard/install', (req, res) => {
    res.json(onboard.install((req.body || {}).name));
  });
  app.get('/api/onboard/log', (_req, res) => {
    res.json(onboard.getLog());
  });
  // Save the OpenAI API key into OpenClaw's config (no CLI for the user).
  app.post('/api/onboard/openclaw-key', async (req, res) => {
    const { provider, apiKey, model } = req.body || {};
    res.json(await onboard.setOpenClawKey({ provider, apiKey, model }));
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
        perplexityApiKey: String(body.perplexityApiKey || '').trim(),
        firecrawlApiKey: String(body.firecrawlApiKey || '').trim(),
        installPlaywright: body.installPlaywright !== false,
      });
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
      for (const label of p.profiles?.labels || []) keys.push({ provider: p.provider, label });
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
  app.post('/api/antler/settings', (req, res) => {
    const saved = store.writeSettings(mergeIncoming(store.readSettings(), req.body || {}));
    openclaw.invalidate();
    ecssync.refresh();
    res.json(redact(saved));
  });
}

function attachAntlerOffice(httpServer) {
  attachPaBridge(httpServer);
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
  return next;
}

