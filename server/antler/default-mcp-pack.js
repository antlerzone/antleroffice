// Default MCP Pack: Playwright → IT; Perplexity + Firecrawl → COO + Admin.
// Installed from the onboarding wizard (opt-in). Registers MCP servers in the
// AntlerOffice registry and binds them to builtin COO + hired role agents.

const { spawnCmd } = require('./spawn-util');
const store = require('./store');
const registry = require('./registry-store');
const { resolveMcpRuntimeFromBindings } = require('./mcp-runtime-helper');
const onboard = require('./onboard');

function ensureBundledMcpRef() {
  return require('./agent-catalog').ensureBundledMcp;
}

const PACK_VERSION = 1;

const MCP_PORT = Number(process.env.ANTLEROFFICE_MCP_PORT) || 8931;

// Instagram (ig-mcp) is a vendored Python MCP server. Paths/runtime are
// overridable via env so packaged (Electron resources) builds can relocate it.
const path = require('node:path');
const IG_MCP_PYTHON = process.env.ANTLEROFFICE_PYTHON || 'python';
const IG_MCP_ENTRY =
  process.env.ANTLEROFFICE_IG_MCP_PATH ||
  path.join(__dirname, '..', '..', 'vendor', 'ig-mcp', 'src', 'instagram_mcp_server.py');

// Credential env vars expected by ig-mcp (filled later in Integrations → MCP).
const IG_ENV_KEYS = [
  'INSTAGRAM_ACCESS_TOKEN',
  'FACEBOOK_APP_ID',
  'FACEBOOK_APP_SECRET',
  'INSTAGRAM_BUSINESS_ACCOUNT_ID',
];

const MCP_DEFS = {
  'antleroffice-tools': {
    slug: 'antleroffice-tools',
    name: 'AntlerOffice Tools',
    url: `http://127.0.0.1:${MCP_PORT}/mcp`,
    transport: 'http',
    suggestedAuthType: 'none',
    skipProbeOnHire: true,
  },
  playwright: {
    slug: 'playwright',
    name: 'Playwright Browser',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', '--headless'],
    suggestedAuthType: 'none',
    skipProbeOnHire: true,
  },
  perplexity: {
    slug: 'perplexity',
    name: 'Perplexity Search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@perplexity-ai/mcp-server'],
    suggestedAuthType: 'api_key',
    skipProbeOnHire: true,
  },
  firecrawl: {
    slug: 'firecrawl',
    name: 'Firecrawl Web',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'firecrawl-mcp'],
    suggestedAuthType: 'api_key',
    skipProbeOnHire: true,
  },
  instagram: {
    slug: 'instagram',
    name: 'Instagram Business',
    transport: 'stdio',
    command: IG_MCP_PYTHON,
    args: [IG_MCP_ENTRY],
    suggestedAuthType: 'api_key',
    skipProbeOnHire: true,
  },
  // Candidate MCP: only installed when the user picks Bukku during onboarding.
  // Verified 2026-06-28 against @centry-digital/bukku-mcp README (169 tools).
  bukku: {
    slug: 'bukku',
    name: 'Bukku Accounting',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@centry-digital/bukku-mcp'],
    suggestedAuthType: 'api_key',
    skipProbeOnHire: true,
    // Saved account (username = company subdomain, password = API token) -> MCP env.
    accountEnv: { username: 'BUKKU_COMPANY_SUBDOMAIN', password: 'BUKKU_API_TOKEN' },
  },
};

const ROLE_SLUGS = {
  secretary: ['antleroffice-tools'],
  ceo: ['antleroffice-tools', 'perplexity', 'firecrawl'],
  coo: ['antleroffice-tools', 'perplexity', 'firecrawl'],
  admin: ['antleroffice-tools', 'perplexity', 'firecrawl', 'instagram'],
  it: ['playwright'],
};

function mergeBindings(existing, addIds) {
  const out = [...(existing || [])];
  const seen = new Set(out.map((b) => b.mcpId));
  for (const mcpId of addIds) {
    if (!mcpId || seen.has(mcpId)) continue;
    out.push({ mcpId, accountIds: [] });
    seen.add(mcpId);
  }
  return out;
}

function readPackSettings() {
  const s = store.readSettings();
  return s.defaultMcpPack || { enabled: false, version: 0, slugToMcpId: {} };
}

function writePackSettings(patch) {
  const s = store.readSettings();
  s.defaultMcpPack = { ...readPackSettings(), ...patch };
  store.writeSettings(s);
  return s.defaultMcpPack;
}

function readBuiltinBindings() {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const p = path.join(store.getDataDir(), 'builtin-mcp-bindings.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function writeBuiltinBindings(all) {
  const fs = require('node:fs');
  const path = require('node:path');
  const p = path.join(store.getDataDir(), 'builtin-mcp-bindings.json');
  fs.writeFileSync(p, JSON.stringify(all, null, 2), 'utf8');
}

function setBuiltinRoleBindings(role, bindings) {
  const all = readBuiltinBindings();
  all[role] = bindings;
  writeBuiltinBindings(all);
}

function getBuiltinRoleBindings(role) {
  return Array.isArray(readBuiltinBindings()[role]) ? readBuiltinBindings()[role] : [];
}

function resolveBuiltinMcpRuntimeSpec(role) {
  const key = role === 'ceo' ? 'coo' : role;
  const bindings = getBuiltinRoleBindings(key);
  if (bindings?.length) return resolveMcpRuntimeFromBindings(bindings);
  if (role === 'ceo' || role === 'coo') return resolveMcpRuntimeFromBindings(getBuiltinRoleBindings('coo'));
  return resolveMcpRuntimeFromBindings(bindings);
}

async function ensurePackMcp(slug, { apiKey, envKey, env } = {}) {
  const def = { ...MCP_DEFS[slug] };
  if (!def.slug) return null;
  // Build the credential env: single apiKey/envKey (perplexity/firecrawl) or a
  // full env object (instagram needs token + app id/secret + business account).
  const credEnv = {
    ...(env && typeof env === 'object' ? env : {}),
    ...(apiKey && envKey ? { [envKey]: apiKey } : {}),
  };
  const hasCreds = Object.keys(credEnv).length > 0;
  if (hasCreds) {
    def.env = credEnv;
  }
  const { mcp } = await ensureBundledMcpRef()(def);
  if (mcp && hasCreds) {
    registry.updateMcp(mcp.id, { env: { ...(mcp.env || {}), ...credEnv } });
    return registry.getMcp(mcp.id);
  }
  return mcp;
}

function installPlaywrightBrowsers() {
  if (onboard.isInstalling('playwright-mcp')) {
    return { ok: false, error: 'playwright install already running' };
  }
  onboard.startInstall('playwright-mcp', 'npm', ['install', '-g', '@playwright/mcp'], {
    onDone: (code) => {
      if (code === 0) installPlaywrightChromium();
    },
  });
  return { ok: true };
}

function installPlaywrightChromium() {
  return onboard.startInstall('playwright-chromium', 'npx', ['playwright', 'install', 'chromium']);
}

async function ensureAntlerofficeToolsBinding() {
  const mcp = await ensurePackMcp('antleroffice-tools');
  if (!mcp) return null;

  const pack = readPackSettings();
  const slugToMcpId = { ...(pack.slugToMcpId || {}), 'antleroffice-tools': mcp.id };
  writePackSettings({ slugToMcpId });

  const cooBindings = getBuiltinRoleBindings('coo');
  setBuiltinRoleBindings('coo', mergeBindings(cooBindings, [mcp.id]));
  return mcp;
}

async function applyDefaultMcpPack({
  enableCoo = true,
  enableAdmin = true,
  enableIt = true,
  perplexityApiKey = '',
  firecrawlApiKey = '',
  instagramCreds = null,
  installPlaywright = true,
} = {}) {
  const slugToMcpId = { ...(readPackSettings().slugToMcpId || {}) };
  const warnings = [];

  if (enableIt && installPlaywright) {
    installPlaywrightBrowsers();
  }

  if (enableCoo || enableAdmin) {
    const mPerp = await ensurePackMcp(
      'perplexity',
      perplexityApiKey.trim()
        ? { apiKey: perplexityApiKey.trim(), envKey: 'PERPLEXITY_API_KEY' }
        : {},
    );
    if (mPerp) slugToMcpId.perplexity = mPerp.id;
    else warnings.push('Could not register Perplexity MCP.');

    const mFire = await ensurePackMcp(
      'firecrawl',
      firecrawlApiKey.trim() ? { apiKey: firecrawlApiKey.trim(), envKey: 'FIRECRAWL_API_KEY' } : {},
    );
    if (mFire) slugToMcpId.firecrawl = mFire.id;
    else warnings.push('Could not register Firecrawl MCP.');

    if (!perplexityApiKey.trim()) {
      warnings.push('Perplexity API key not set — add later in Integrations → MCP.');
    }
    if (!firecrawlApiKey.trim()) {
      warnings.push('Firecrawl API key not set — add later in Integrations → MCP.');
    }
  }

  if (enableIt) {
    const m = await ensurePackMcp('playwright');
    if (m) slugToMcpId.playwright = m.id;
    if (installPlaywright) {
      installPlaywrightChromium();
    }
  }

  if (enableCoo) {
    const mTools = await ensurePackMcp('antleroffice-tools');
    if (mTools) slugToMcpId['antleroffice-tools'] = mTools.id;
    const ids = ROLE_SLUGS.ceo.map((s) => slugToMcpId[s]).filter(Boolean);
    const bindings = ids.map((mcpId) => ({ mcpId, accountIds: [] }));
    setBuiltinRoleBindings('ceo', bindings);
    setBuiltinRoleBindings('coo', bindings);
  }

  if (enableAdmin) {
    const igEnv = {};
    if (instagramCreds && typeof instagramCreds === 'object') {
      for (const key of IG_ENV_KEYS) {
        const val = typeof instagramCreds[key] === 'string' ? instagramCreds[key].trim() : '';
        if (val) igEnv[key] = val;
      }
    }
    const mIg = await ensurePackMcp(
      'instagram',
      Object.keys(igEnv).length ? { env: igEnv } : {},
    );
    if (mIg) slugToMcpId.instagram = mIg.id;
    else warnings.push('Could not register Instagram MCP.');
    if (!igEnv.INSTAGRAM_ACCESS_TOKEN) {
      warnings.push('Instagram access token not set — add later in Integrations → MCP.');
    }

    const ids = ROLE_SLUGS.admin.map((s) => slugToMcpId[s]).filter(Boolean);
    setBuiltinRoleBindings('admin', ids.map((mcpId) => ({ mcpId, accountIds: [] })));
    for (const agent of registry.listAgents()) {
      if (agent.role !== 'admin') continue;
      const merged = mergeBindings(agent.mcpBindings, ids);
      registry.updateAgent(agent.id, { mcpBindings: merged });
    }
  }

  if (enableIt) {
    const ids = ROLE_SLUGS.it.map((s) => slugToMcpId[s]).filter(Boolean);
    setBuiltinRoleBindings('it', ids.map((mcpId) => ({ mcpId, accountIds: [] })));
    for (const agent of registry.listAgents()) {
      if (agent.role !== 'it') continue;
      const merged = mergeBindings(agent.mcpBindings, ids);
      registry.updateAgent(agent.id, { mcpBindings: merged });
    }
  }

  writePackSettings({
    enabled: true,
    version: PACK_VERSION,
    installedAt: Date.now(),
    slugToMcpId,
    roles: { coo: enableCoo, admin: enableAdmin, it: enableIt },
  });

  return {
    ok: true,
    slugToMcpId,
    warnings,
    coo: resolveBuiltinMcpRuntimeSpec('coo'),
    admin: resolveBuiltinMcpRuntimeSpec('admin'),
    it: resolveBuiltinMcpRuntimeSpec('it'),
  };
}

function applyRoleDefaultsToAgent(agent) {
  const pack = readPackSettings();
  if (!pack.enabled) return agent;
  const slugs = ROLE_SLUGS[agent.role];
  if (!slugs?.length) return agent;
  const ids = slugs.map((s) => pack.slugToMcpId?.[s]).filter(Boolean);
  if (!ids.length) return agent;
  const merged = mergeBindings(agent.mcpBindings, ids);
  return registry.updateAgent(agent.id, { mcpBindings: merged }) || agent;
}

// Install ONE candidate MCP chosen by the user during onboarding, and bind it to
// that template's hired agent(s). The account token is resolved server-side and
// passed only into the MCP env — it never reaches the AI. Same proven plumbing as
// applyRoleDefaultsToAgent (registry mcpBindings; resolved at run time).
async function installMcpForTemplate({ templateId, slug, account } = {}) {
  const def = MCP_DEFS[slug];
  if (!def) throw new Error(`Unknown MCP slug: ${slug}`);
  const env = {};
  if (account && def.accountEnv) {
    for (const [field, envKey] of Object.entries(def.accountEnv)) {
      const v = account[field];
      if (v) env[envKey] = String(v);
    }
  }
  const mcp = await ensurePackMcp(slug, { env });
  if (!mcp) throw new Error(`Could not register MCP: ${slug}`);
  const slugToMcpId = { ...(readPackSettings().slugToMcpId || {}), [slug]: mcp.id };
  writePackSettings({ slugToMcpId });
  let boundAgents = 0;
  for (const agent of registry.listAgents()) {
    if (agent.templateId !== templateId) continue;
    registry.updateAgent(agent.id, { mcpBindings: mergeBindings(agent.mcpBindings, [mcp.id]) });
    boundAgents += 1;
  }
  return { ok: true, slug, mcpId: mcp.id, boundAgents };
}

async function getStatus() {
  const pack = readPackSettings();
  const mcps = {};
  for (const slug of Object.keys(MCP_DEFS)) {
    const id = pack.slugToMcpId?.[slug];
    mcps[slug] = id ? registry.getMcp(id) : null;
  }
  return {
    pack,
    mcps,
    bindings: {
      coo: getBuiltinRoleBindings('coo'),
      admin: getBuiltinRoleBindings('admin'),
      it: getBuiltinRoleBindings('it'),
    },
    roleSlugs: ROLE_SLUGS,
  };
}

module.exports = {
  MCP_DEFS,
  ROLE_SLUGS,
  ensureAntlerofficeToolsBinding,
  applyDefaultMcpPack,
  applyRoleDefaultsToAgent,
  installMcpForTemplate,
  getStatus,
  resolveBuiltinMcpRuntimeSpec,
  getBuiltinRoleBindings,
  setBuiltinRoleBindings,
};
