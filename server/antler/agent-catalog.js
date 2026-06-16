// Browse catalog + hire flow for templated NPCs (Graphic Design, etc.).

const fs = require('node:fs');
const path = require('node:path');
const registry = require('./registry-store');
const billing = require('./billing');
const payroll = require('./payroll');
const openclaw = require('./openclaw-config');
const office = require('./office-state');
const mcpProbe = require('./mcp-probe');
const ecsBundle = require('./ecs-bundle');
const auth = require('./auth');
const defaultMcpPack = require('./default-mcp-pack');

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
  candidates.push(path.join(skillsRoot, 'create-npc-skin.json'));

  let def = null;
  for (const p of candidates) {
    try {
      def = JSON.parse(fs.readFileSync(p, 'utf8'));
      break;
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

async function hireFromTemplate({ templateId, name, bossToken, hirePassword } = {}) {
  const template = await resolveTemplate(templateId);
  if (!template) {
    const err = new Error('Unknown NPC template.');
    err.code = 'UNKNOWN_TEMPLATE';
    throw err;
  }

  const ecsSubscriptions = require('./ecs-subscriptions');
  const ecsToken = bossToken ? ecsSubscriptions.ecsTokenFromBossToken(bossToken) : null;
  const useEcsBilling = ecsSubscriptions.isEcsBillingEnabled(bossToken);

  const hirePasswordMod = require('./hire-password');
  await hirePasswordMod.verifyHirePassword(template, hirePassword, { deferToEcs: useEcsBilling });

  const salary = Number(template.salaryCreditsPerMonth) || 0;
  if (!useEcsBilling && salary > 0 && billing.getBalance() < salary) {
    const err = new Error('Insufficient credits for first month salary.');
    err.code = 'INSUFFICIENT_CREDITS';
    err.balance = billing.getBalance();
    err.required = salary;
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
  let nextSalaryDueAt = payroll.addOneMonth(hiredAt);
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
    nextSalaryDueAt,
    lastSalaryPaidAt: null,
    payrollStatus: salary > 0 ? 'active' : null,
    ecsSubscriptionId: null,
    baselineSkillIds: [...skillIds],
    baselineOpenclawSkillNames: [...(template.openclawSkillNames || [])],
    baselineMcpIds: [...mcpIds],
  });

  if (useEcsBilling) {
    const ecsResult = await ecsSubscriptions.notifyHire({
      ecsToken,
      departmentId: template.id,
      templateId: template.id,
      localAgentId: agent.id,
      agentName: displayName,
      hirePassword,
    });
    if (!ecsResult.ok) {
      registry.removeAgent(agent.id);
      if (openclawAgentId) await openclaw.agentsDelete(openclawAgentId).catch(() => {});
      office.removeAgent(`user:${agent.id}`);
      const err = new Error(ecsResult.error || 'ECS hire failed');
      err.code = ecsResult.code || 'ECS_HIRE_FAILED';
      err.balance = ecsResult.balance;
      err.required = ecsResult.required;
      throw err;
    }
    ecsSubscriptionId = ecsResult.subscription?.id || null;
    if (typeof ecsResult.creditBalance === 'number') {
      billing.setBalance(ecsResult.creditBalance, { reason: 'ecs_hire' });
      creditBalance = ecsResult.creditBalance;
    }
    if (ecsResult.subscription?.nextSalaryDueAt) {
      nextSalaryDueAt = ecsResult.subscription.nextSalaryDueAt;
    }
    registry.updateAgent(agent.id, {
      ecsSubscriptionId,
      nextSalaryDueAt,
      lastSalaryPaidAt: hiredAt,
    });
  } else if (salary > 0) {
    billing.deductCredits(salary, {
      reason: 'hire_first_month',
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
  office.loadUserAgents([withMcp]);
  return {
    agent: withMcp,
    bundle: bundleInfo,
    postInstall: postInstallMcps.length ? { mcps: postInstallMcps } : null,
    openclaw: { available: oc.available !== false, agentId: openclawAgentId, error: oc.error },
    balance: creditBalance,
  };
}

function bundledSkillDef(skillId, templateId) {
  if (templateId) {
    const bundled = ecsBundle.skillFilePath(templateId, skillId);
    if (bundled) {
      try {
        return JSON.parse(fs.readFileSync(bundled, 'utf8'));
      } catch {
        /* fall through */
      }
    }
  }
  const slug = String(skillId || '').replace(/_/g, '-');
  const skillsRoot = path.join(__dirname, '..', '..', 'skills');
  for (const file of [
    path.join(skillsRoot, `${slug}.json`),
    path.join(skillsRoot, 'create-npc-skin.json'),
  ]) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* try next */
    }
  }
  return null;
}

function catalogWithStatus() {
  const hired = new Set(registry.listAgents().map((a) => a.templateId).filter(Boolean));
  return loadCatalog().map((t) => {
    const skillNames = (t.skillIds || [])
      .map((id) => bundledSkillDef(id)?.name || registry.listSkills().find((s) => s.id === id)?.name)
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
  ensureBundledSkill,
  installOpenClawSkill,
  ensureBundledMcp,
  importTemplateMcps,
};
