// Browse catalog + hire flow for templated NPCs (Graphic Design, etc.).

const fs = require('node:fs');
const path = require('node:path');
const registry = require('./registry-store');
const billing = require('./billing');
const openclaw = require('./openclaw-config');
const office = require('./office-state');
const mcpProbe = require('./mcp-probe');
const ecsBundle = require('./ecs-bundle');
const auth = require('./auth');
const defaultMcpPack = require('./default-mcp-pack');
const ceoPricing = require('./ceo-pricing');

function catalogPath() {
  const primary = path.join(__dirname, '..', '..', 'agents', 'catalog.json');
  const fallback = path.join(__dirname, '..', 'agents', 'catalog.json');
  if (fs.existsSync(primary)) return primary;
  if (fs.existsSync(fallback)) return fallback;
  return primary;
}

function loadCatalog() {
  try {
    const data = JSON.parse(fs.readFileSync(catalogPath(), 'utf8'));
    return Array.isArray(data.templates) ? data.templates : [];
  } catch {
    return [];
  }
}

function getTemplate(templateId) {
  return loadCatalog().find((t) => t.id === templateId) || null;
}

function isTemplateHired(templateId) {
  return registry.listAgents().some((a) => a.templateId === templateId);
}

function ensureBundledSkill(skillId, templateId) {
  const candidates = [];
  if (templateId) {
    const bundled = ecsBundle.skillFilePath(templateId, skillId);
    if (bundled) candidates.push(bundled);
  }
  const skillsRoot = path.join(__dirname, '..', '..', 'skills');
  candidates.push(path.join(skillsRoot, `${skillId.replace(/_/g, '-')}.json`));

  let def = null;
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed?.id === skillId) {
        def = parsed;
        break;
      }
    } catch {
      /* try next */
    }
  }
  if (!def?.id) return null;
  return registry.ensureSkill({ id: def.id, name: def.name, system: def.system });
}

function installOpenClawSkill(workspace, folderName, templateId) {
  if (!workspace || !folderName) return { ok: false, error: 'missing workspace' };
  let src = templateId ? ecsBundle.openclawSkillDir(templateId, folderName) : null;
  if (!src) src = path.join(__dirname, '..', 'openclaw-skills', folderName);
  if (!fs.existsSync(src)) return { ok: false, error: 'skill bundle missing' };
  const dest = path.join(workspace, 'skills', folderName);
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, name), path.join(dest, name));
  }
  return { ok: true, dest };
}

function findBundledMcp(def) {
  const url = typeof def.url === 'string' ? def.url.trim() : '';
  const command = typeof def.command === 'string' ? def.command.trim() : '';
  const slug = typeof def.slug === 'string' ? def.slug.trim() : '';
  for (const m of registry.listMcps()) {
    if (url && (m.url || '').trim() === url) return m;
    if (
      command &&
      m.transport === 'stdio' &&
      (m.command || '').trim() === command &&
      JSON.stringify(m.args || []) === JSON.stringify(Array.isArray(def.args) ? def.args : [])
    ) {
      return m;
    }
    if (slug && typeof m.description === 'string' && m.description.includes(`bundled:${slug}`)) {
      return m;
    }
  }
  return null;
}

async function ensureBundledMcp(def = {}) {
  const url = typeof def.url === 'string' ? def.url.trim() : '';
  const command = typeof def.command === 'string' ? def.command.trim() : '';
  const useStdio = !url && (command || def.transport === 'stdio');
  if (!url && !useStdio) return { mcp: null, needsSetup: false };

  const existing = findBundledMcp(def);
  if (existing) {
    const enriched = registry.getMcp(existing.id);
    const needsSetup =
      !!enriched?.authRequired &&
      !(enriched.connectedAccountCount > 0 || enriched.authConnected);
    return { mcp: enriched, needsSetup };
  }

  const slug = typeof def.slug === 'string' ? def.slug.trim() : '';

  if (useStdio) {
    const addBody = {
      name: def.name || slug || 'Bundled MCP',
      command,
      args: Array.isArray(def.args) ? def.args : [],
      env: def.env && typeof def.env === 'object' ? def.env : {},
      transport: 'stdio',
      description: slug ? `bundled:${slug}` : def.description || '',
      authRequired: false,
      suggestedAuthType: def.suggestedAuthType || 'none',
    };
    const mcp = registry.getMcp(registry.addMcp(addBody).id);
    return { mcp, needsSetup: false, probeError: '' };
  }

  const addBody = {
    name: def.name || slug || 'Bundled MCP',
    url,
    transport: 'http',
    description: slug ? `bundled:${slug}` : def.description || '',
    authRequired: typeof def.authRequired === 'boolean' ? def.authRequired : undefined,
    suggestedAuthType: def.suggestedAuthType || 'none',
  };

  let needsSetup = false;
  let probeError = '';

  if (!def.skipProbeOnHire) {
    try {
      const probeResult = await mcpProbe.probe({ url });
      if (probeResult.reachable) {
        Object.assign(addBody, mcpProbe.applyProbeToMcpBody(addBody, probeResult));
      } else {
        probeError = probeResult.error || 'Unreachable during hire';
        addBody.authRequired = typeof def.authRequired === 'boolean' ? def.authRequired : true;
        addBody.suggestedAuthType = def.suggestedAuthType || addBody.suggestedAuthType || 'oauth';
        needsSetup = true;
      }
    } catch (e) {
      probeError = e instanceof Error ? e.message : 'Probe failed during hire';
      addBody.authRequired = typeof def.authRequired === 'boolean' ? def.authRequired : true;
      addBody.suggestedAuthType = def.suggestedAuthType || 'oauth';
      needsSetup = true;
    }
  } else {
    addBody.authRequired = typeof def.authRequired === 'boolean' ? def.authRequired : false;
    addBody.suggestedAuthType = def.suggestedAuthType || 'none';
    needsSetup = !!def.authRequired;
  }

  let mcp = registry.addMcp(addBody);

  if (def.oauth || def.authRequired) {
    const created = registry.addMcpAccount(mcp.id, {
      label: def.defaultAccountLabel || 'Default',
      authType: def.suggestedAuthType || mcp.suggestedAuthType || 'oauth',
    });
    if (def.oauth && typeof def.oauth === 'object') {
      registry.updateMcpAccount(mcp.id, created.account.id, {
        auth: {
          oauth: {
            clientId: def.oauth.clientId || '',
            authorizeUrl: def.oauth.authorizeUrl || '',
            tokenUrl: def.oauth.tokenUrl || '',
            scopes: def.oauth.scopes || '',
          },
        },
      });
    }
    needsSetup = true;
  }

  mcp = registry.getMcp(mcp.id);
  if (needsSetup && mcp?.connectedAccountCount > 0) needsSetup = false;

  return { mcp, needsSetup, probeError };
}

async function importTemplateMcps(template) {
  const mcpIds = [];
  const mcpBindings = [];
  const postInstallMcps = [];

  for (const def of template.mcps || []) {
    const { mcp, needsSetup, probeError } = await ensureBundledMcp(def);
    if (!mcp) continue;
    mcpIds.push(mcp.id);
    mcpBindings.push({ mcpId: mcp.id, accountIds: [] });
    if (needsSetup) {
      postInstallMcps.push({
        mcpId: mcp.id,
        name: mcp.name,
        slug: def.slug || '',
        hint: probeError || `Add account for ${mcp.name}`,
      });
    }
  }

  for (const req of template.requiredAccounts || []) {
    const slug = req.mcpSlug;
    const hit = postInstallMcps.find((p) => p.slug === slug);
    if (hit && req.label) hit.hint = req.label;
  }

  return { mcpIds, mcpBindings, postInstallMcps };
}

async function resolveTemplate(templateId) {
  const ecsCatalog = require('./ecs-catalog');
  const templates = await ecsCatalog.loadCatalogMerged();
  return templates.find((t) => t.id === templateId) || getTemplate(templateId);
}

function isEcsDepartmentMissing(ecsResult = {}) {
  return (
    ecsResult.code === 'UNKNOWN_DEPARTMENT' ||
    ecsResult.status === 404 ||
    /department not found/i.test(String(ecsResult.error || ''))
  );
}

function isLocalMonorepoTemplate(template = {}) {
  const ecsBundle = require('./ecs-bundle');
  const bundleId = template.bundleTemplateId || template.templateId || template.id;
  return !!ecsBundle.installFromMonorepo(bundleId);
}

function chargeLocalFirstPeriod({ template, templateId, displayName, charge, bill, hiredAt, agentId }) {
  const billingIntervalMod = require('./billing-interval');
  const billing = require('./billing');
  if (charge <= 0) return billing.getBalance();
  billing.deductCredits(charge, {
    reason: billingIntervalMod.firstChargeReason(bill),
    templateId: templateId || template.id,
    agentName: displayName,
    period: new Date(hiredAt).toISOString().slice(0, 7),
  });
  registry.updateAgent(agentId, { lastSalaryPaidAt: hiredAt, ecsSubscriptionId: null });
  return billing.getBalance();
}

async function hireFromTemplate({ templateId, name, bossToken, hirePassword, billingInterval, autoRenew, devScope } = {}) {
  const template = await resolveTemplate(templateId);
  if (!template) {
    const err = new Error('Unknown NPC template.');
    err.code = 'UNKNOWN_TEMPLATE';
    throw err;
  }

  const billingIntervalMod = require('./billing-interval');
  const ecsSubscriptions = require('./ecs-subscriptions');
  const ecsToken = bossToken ? ecsSubscriptions.ecsTokenFromBossToken(bossToken) : null;
  const useEcsBilling = ecsSubscriptions.isEcsBillingEnabled(bossToken);

  const hirePasswordMod = require('./hire-password');
  await hirePasswordMod.verifyHirePassword(template, hirePassword, { deferToEcs: useEcsBilling });

  const portalPartnerOAuth = require('./portal-partner-oauth');
  if (portalPartnerOAuth.templateRequiresPortalOAuth(template) && !portalPartnerOAuth.templatePortalOAuthConnected(template)) {
    const partner = portalPartnerOAuth.partnerForTemplate(template);
    const label = portalPartnerOAuth.partnerConfig(partner)?.label || 'Partner portal';
    const err = new Error(`${label} sign-in is required before hiring this worker.`);
    err.code = 'PORTAL_OAUTH_REQUIRED';
    err.partner = partner;
    throw err;
  }

  const salaryBase = Number(template.salaryCreditsPerMonth) || 0;
  let salary = salaryBase;
  let billingCredits = template.billingCreditsByInterval || null;
  let ceoDepartmentCount = null;
  if (ceoPricing.isPerDepartmentCeoTemplate(template)) {
    const p = ceoPricing.buildCeoPricing();
    salary = p.salaryCreditsPerMonth;
    billingCredits = p.billingCreditsByInterval;
    ceoDepartmentCount = p.departmentCount;
  }
  const bill = ceoPricing.isPerDepartmentCeoTemplate(template)
    ? ceoPricing.CEO_BILLING_INTERVAL
    : billingIntervalMod.normalizeBillingInterval(billingInterval);
  const renew = autoRenew !== false;
  const charge = billingIntervalMod.creditsPerPeriod(salary, bill, billingCredits);
  if (billingIntervalMod.isPaygo(bill)) {
    if (ecsSubscriptions.ecsBaseUrl() && !useEcsBilling) {
      const err = new Error('Pay-as-you-go requires ECS login and an online connection.');
      err.code = 'ECS_REQUIRED';
      throw err;
    }
    if (!useEcsBilling && billing.getBalance() < 1) {
      const err = new Error('Insufficient credits — need at least 1 credit for pay-as-you-go.');
      err.code = 'INSUFFICIENT_CREDITS';
      err.balance = billing.getBalance();
      err.required = 1;
      throw err;
    }
  } else if (!useEcsBilling && charge > 0 && billing.getBalance() < charge) {
    const err = new Error(`Insufficient credits for first ${billingIntervalMod.intervalLabel(bill)} salary.`);
    err.code = 'INSUFFICIENT_CREDITS';
    err.balance = billing.getBalance();
    err.required = charge;
    throw err;
  }

  const bundleKey = template.bundleTemplateId || template.id;
  let bundleInfo = null;
  if (auth.ecsBaseUrl() || template.bundleUrl) {
    bundleInfo = await ecsBundle.downloadAndInstall({ ...template, id: bundleKey });
    if (!bundleInfo.ok && !bundleInfo.skipped) {
      throw new Error('Could not install agent bundle from ECS');
    }
  }

  const skillIds = [];
  for (const sid of template.skillIds || []) {
    const skill = ensureBundledSkill(sid, bundleKey);
    if (skill) skillIds.push(skill.id);
  }

  let openclawAgentId = null;
  let runtime = template.runtime || 'openclaw';
  let workspace = null;
  const displayName = String(name || template.name).trim() || template.name;
  const oc = await openclaw.agentsAdd({ name: displayName });
  if (oc.ok) {
    openclawAgentId = oc.agentId;
    workspace = oc.workspace;
    runtime = 'openclaw';
    for (const skillName of template.openclawSkillNames || []) {
      installOpenClawSkill(workspace, skillName, bundleKey);
    }
  } else {
    runtime = 'demo';
  }

  const hiredAt = Date.now();
  let nextSalaryDueAt = billingIntervalMod.isPaygo(bill)
    ? null
    : ceoPricing.isPerDepartmentCeoTemplate(template)
      ? ceoPricing.nextLocalMidnightMs(hiredAt)
      : billingIntervalMod.addBillingPeriod(hiredAt, bill);
  let ecsSubscriptionId = null;
  let creditBalance = billing.getBalance();

  let sprite = template.sprite;
  let hueShift = template.hueShift ?? 0;
  if (template.defaultSkinId) {
    const skin = registry.listSkins().find((s) => s.id === template.defaultSkinId);
    if (skin) {
      sprite = skin.palette;
      hueShift = skin.hueShift || 0;
    }
  }

  const { mcpIds, mcpBindings, postInstallMcps } = await importTemplateMcps(template);

  const devTeamResolver = require('./runtime/dev-team-resolver');
  const isDevHire =
    devTeamResolver.isDevTemplate(template.id) || template.role === 'it' || !!template.devEngine;
  const resolvedDevEngine =
    template.devEngine || devTeamResolver.engineForTemplate(template.id) || null;
  const resolvedDevScope = devTeamResolver.normalizeDevScope(
    devScope || template.devScopeDefault || { canWrite: true, canReview: true },
  );

  const agent = registry.addAgent({
    name: displayName,
    role: template.role,
    runtime,
    sprite,
    hueShift,
    skillIds,
    openclawSkillNames: template.openclawSkillNames || [],
    mcpIds,
    mcpBindings,
    openclawAgentId,
    templateId: template.id,
    hiredAt,
    salaryCreditsPerMonth: salary,
    salaryUsdPerMonth: ceoPricing.isPerDepartmentCeoTemplate(template) ? salary : template.salaryUsdPerMonth,
    billingInterval: bill,
    billingCreditsByInterval: billingCredits,
    ceoDepartmentCount,
    autoRenew: renew,
    nextSalaryDueAt,
    lastSalaryPaidAt: null,
    payrollStatus: salary > 0 ? 'active' : null,
    ecsSubscriptionId: null,
    baselineSkillIds: [...skillIds],
    baselineOpenclawSkillNames: [...(template.openclawSkillNames || [])],
    baselineMcpIds: [...mcpIds],
    homeWorkerId: template.role || template.id,
    devEngine: isDevHire ? resolvedDevEngine : null,
    devScope: isDevHire ? resolvedDevScope : null,
  });

  if (useEcsBilling) {
    const ecsResult = await ecsSubscriptions.notifyHire({
      ecsToken,
      bossToken,
      departmentId: template.departmentId || template.id,
      templateId: template.templateId || template.bundleTemplateId || template.id,
      localAgentId: agent.id,
      agentName: displayName,
      hirePassword,
      billingInterval: bill,
      autoRenew: renew,
    });
    if (!ecsResult.ok) {
      if (isLocalMonorepoTemplate(template) && isEcsDepartmentMissing(ecsResult)) {
        creditBalance = chargeLocalFirstPeriod({
          template,
          templateId,
          displayName,
          charge,
          bill,
          hiredAt,
          agentId: agent.id,
        });
      } else {
        registry.removeAgent(agent.id);
        if (openclawAgentId) await openclaw.agentsDelete(openclawAgentId).catch(() => {});
        office.removeAgent(`user:${agent.id}`);
        const err = new Error(ecsResult.error || 'ECS hire failed');
        err.code = ecsResult.code || 'ECS_HIRE_FAILED';
        err.balance = ecsResult.balance;
        err.required = ecsResult.required;
        throw err;
      }
    } else {
    ecsSubscriptionId = ecsResult.subscription?.id || null;
    if (typeof ecsResult.creditBalance === 'number') {
      billing.setBalance(ecsResult.creditBalance, { reason: 'ecs_hire' });
      creditBalance = ecsResult.creditBalance;
    }
    if (ecsResult.subscription?.nextSalaryDueAt) {
      nextSalaryDueAt = ecsResult.subscription.nextSalaryDueAt;
    }
    const ecsBill = ecsResult.subscription?.billingInterval
      ? billingIntervalMod.normalizeBillingInterval(ecsResult.subscription.billingInterval)
      : bill;
    registry.updateAgent(agent.id, {
      ecsSubscriptionId,
      billingInterval: ecsBill,
      autoRenew: ecsResult.subscription?.autoRenew !== false,
      nextSalaryDueAt,
      lastSalaryPaidAt: hiredAt,
    });
    }
  } else if (charge > 0) {
    billing.deductCredits(charge, {
      reason: billingIntervalMod.firstChargeReason(bill),
      templateId,
      agentName: displayName,
      period: new Date(hiredAt).toISOString().slice(0, 7),
    });
    registry.updateAgent(agent.id, {
      lastSalaryPaidAt: hiredAt,
    });
    creditBalance = billing.getBalance();
  }

  const saved = registry.getAgent(agent.id);
  const withMcp = defaultMcpPack.applyRoleDefaultsToAgent(saved) || saved;
  office.attachHiredAgent(withMcp);
  ceoPricing.syncHiredCeoAgent();

  let codexInstall = null;
  let cursorInstall = null;
  let claudeInstall = null;
  if (isDevHire && resolvedDevEngine) {
    try {
      const onboard = require('./onboard');
      const engine = resolvedDevEngine;
      if (engine === 'cursor') {
        const cursorCli = require('./runtime/cursor-cli');
        const cursorProbed = await cursorCli.probe();
        cursorInstall = cursorProbed.installed
          ? { ok: true, skipped: true, alreadyInstalled: true }
          : onboard.install('cursor');
      } else if (engine === 'codex') {
        const codexCli = require('./runtime/codex-cli');
        const codexProbed = await codexCli.probe();
        codexInstall = codexProbed.installed
          ? { ok: true, skipped: true, alreadyInstalled: true }
          : onboard.install('codex');
      } else if (engine === 'claude') {
        const claudeCli = require('./runtime/claude-cli');
        const claudeProbed = await claudeCli.probe();
        claudeInstall = claudeProbed.installed
          ? { ok: true, skipped: true, alreadyInstalled: true }
          : onboard.install('claude');
      }
    } catch {
      /* non-fatal */
    }
  }

  return {
    agent: withMcp,
    bundle: bundleInfo,
    postInstall: postInstallMcps.length ? { mcps: postInstallMcps } : null,
    openclaw: { available: oc.available !== false, agentId: openclawAgentId, error: oc.error },
    balance: creditBalance,
    codexInstall,
    cursorInstall,
    claudeInstall,
    devCliInstall:
      cursorInstall || codexInstall || claudeInstall
        ? { cursor: cursorInstall, codex: codexInstall, claude: claudeInstall }
        : null,
    devEngine: resolvedDevEngine,
  };
}

function bundledSkillDef(skillId, templateId) {
  if (templateId) {
    const bundled = ecsBundle.skillFilePath(templateId, skillId);
    if (bundled) {
      try {
        const parsed = JSON.parse(fs.readFileSync(bundled, 'utf8'));
        if (parsed?.id === skillId) return parsed;
      } catch {
        /* fall through */
      }
    }
  }
  const slug = String(skillId || '').replace(/_/g, '-');
  const skillsRoot = path.join(__dirname, '..', '..', 'skills');
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(skillsRoot, `${slug}.json`), 'utf8'));
    return parsed?.id === skillId ? parsed : null;
  } catch {
    return null;
  }
}

function skillDisplayName(skillId, templateId) {
  return bundledSkillDef(skillId, templateId)?.name || String(skillId || '').replace(/_/g, ' ');
}

function ensureCeoBundleSkills() {
  const ids = ['ceo_brainstorm', 'ceo_writing_plans', 'ceo_executing_plans', 'ceo_review'];
  for (const id of ids) ensureBundledSkill(id, 'ceo');
  return ids;
}

function migrateHiredCeoSkills() {
  ensureCeoBundleSkills();
  const ceo = ceoPricing.findHiredCeoAgent();
  if (!ceo) return null;
  const required = ['ceo_brainstorm', 'ceo_writing_plans', 'ceo_executing_plans', 'ceo_review'];
  const openclaw = [
    'antleroffice-ceo-brainstorm',
    'antleroffice-ceo-writing-plans',
    'antleroffice-ceo-executing-plans',
    'antleroffice-ceo-review',
  ];
  const current = ceo.skillIds || [];
  const merged = [...new Set([...required, ...current.filter((id) => id !== 'general')])];
  const ocMerged = [...new Set([...openclaw, ...(ceo.openclawSkillNames || [])])];
  if (merged.join(',') === current.join(',') && ocMerged.join(',') === (ceo.openclawSkillNames || []).join(',')) {
    return ceo;
  }
  return registry.updateAgent(ceo.id, { skillIds: merged, openclawSkillNames: ocMerged });
}

function catalogWithStatus() {
  const hired = new Set(
    registry
      .listAgents()
      .filter((a) => registry.isOnTeamAgent(a))
      .map((a) => a.templateId)
      .filter(Boolean),
  );
  return loadCatalog().map((t) => {
    const bundleId = t.bundleTemplateId || t.id;
    const skillNames = (t.skillIds || [])
      .map(
        (id) =>
          skillDisplayName(id, bundleId)
          || registry.listSkills().find((s) => s.id === id)?.name,
      )
      .filter(Boolean);
    const mcpNames = (t.mcps || []).map((m) => m.name || m.slug).filter(Boolean);
    return registry.enrichCatalogTemplate({
      ...t,
      skillNames,
      mcpNames,
      includesLabel: [
        skillNames.length ? `${skillNames.length} skill${skillNames.length === 1 ? '' : 's'}` : '',
        mcpNames.length ? `${mcpNames.length} MCP${mcpNames.length === 1 ? '' : 's'}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      hired: hired.has(t.id),
    });
  });
}

module.exports = {
  loadCatalog,
  getTemplate,
  isTemplateHired,
  hireFromTemplate,
  catalogWithStatus,
  bundledSkillDef,
  skillDisplayName,
  ensureBundledSkill,
  ensureCeoBundleSkills,
  migrateHiredCeoSkills,
  installOpenClawSkill,
  ensureBundledMcp,
  importTemplateMcps,
};
