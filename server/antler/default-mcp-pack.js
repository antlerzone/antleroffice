// Default MCP Pack: Playwright → IT; Perplexity + Firecrawl → COO + Admin.
// Installed from the onboarding wizard (opt-in). Registers MCP servers in the
// AntlerOffice registry and binds them to builtin COO + hired role agents.

const { spawnCmd } = require('./spawn-util');
const store = require('./store');
const registry = require('./registry-store');
const { ensureBundledMcp } = require('./agent-catalog');
const { resolveMcpRuntimeFromBindings } = require('./mcp-runtime-helper');
const onboard = require('./onboard');

const PACK_VERSION = 1;

const MCP_DEFS = {
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
};

const ROLE_SLUGS = {
  coo: ['perplexity', 'firecrawl'],
  admin: ['perplexity', 'firecrawl'],
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
  return resolveMcpRuntimeFromBindings(getBuiltinRoleBindings(role));
}

async function ensurePackMcp(slug, { apiKey, envKey } = {}) {
  const def = { ...MCP_DEFS[slug] };
  if (!def.slug) return null;
  if (apiKey && envKey) {
    def.env = { [envKey]: apiKey };
  }
  const { mcp } = await ensureBundledMcp(def);
  if (mcp && apiKey && envKey) {
    registry.updateMcp(mcp.id, { env: { ...(mcp.env || {}), [envKey]: apiKey } });
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

async function applyDefaultMcpPack({
  enableCoo = true,
  enableAdmin = true,
  enableIt = true,
  perplexityApiKey = '',
  firecrawlApiKey = '',
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
    const ids = ROLE_SLUGS.coo.map((s) => slugToMcpId[s]).filter(Boolean);
    setBuiltinRoleBindings('coo', ids.map((mcpId) => ({ mcpId, accountIds: [] })));
  }

  if (enableAdmin) {
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
  applyDefaultMcpPack,
  applyRoleDefaultsToAgent,
  getStatus,
  resolveBuiltinMcpRuntimeSpec,
  getBuiltinRoleBindings,
  setBuiltinRoleBindings,
};
