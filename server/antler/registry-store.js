// Persistent registry for the AntlerOffice control plane: user-created agents,
// the skill catalog, the MCP-server catalog, per-agent knowledge files, and the
// deliverables index. Everything is plain JSON under the data dir so it survives
// restarts and is easy to inspect.

const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');
const { resolveMcpRuntimeFromBindings } = require('./mcp-runtime-helper');

function dataPath(...p) {
  return path.join(getDataDir(), ...p);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(dataPath(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  fs.writeFileSync(dataPath(name), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

let seq = 0;
function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

// ── Skills catalog ─────────────────────────────────────────────────────────
// "My Skills" starts empty — the client adds their own (or installs from the
// Browse tab). The bundled catalog is NOT auto-seeded here; it still powers the
// COO's temp-worker execution separately via server/skills.js (registry.json).
function listSkills() {
  const skills = readJson('skills.json', null);
  return Array.isArray(skills) ? skills : [];
}

function addSkill({ name, system, mcpIds } = {}) {
  const skills = listSkills();
  const item = {
    id: newId('skill'),
    name: name || 'New Skill',
    system: system || '',
    mcpIds: Array.isArray(mcpIds) ? mcpIds.filter(Boolean) : [],
  };
  skills.push(item);
  writeJson('skills.json', skills);
  return item;
}

function updateSkill(id, patch = {}) {
  const skills = listSkills();
  const s = skills.find((x) => x.id === id);
  if (!s) return null;
  if (typeof patch.name === 'string') s.name = patch.name;
  if (typeof patch.system === 'string') s.system = patch.system;
  if (Array.isArray(patch.mcpIds)) s.mcpIds = patch.mcpIds.filter(Boolean);
  writeJson('skills.json', skills);
  return s;
}

function removeSkill(id) {
  writeJson(
    'skills.json',
    listSkills().filter((s) => s.id !== id),
  );
}

function ensureSkill({ id, name, system } = {}) {
  const sid = String(id || '').trim();
  if (!sid) return null;
  const skills = listSkills();
  const existing = skills.find((s) => s.id === sid);
  if (existing) return existing;
  const item = { id: sid, name: name || sid, system: system || '' };
  skills.push(item);
  writeJson('skills.json', skills);
  return item;
}

// ── MCP server catalog ──────────────────────────────────────────────────────
const MCP_AUTH_TYPES = new Set(['none', 'api_key', 'bearer', 'oauth']);

function normalizeMcpAuth(auth = {}) {
  const oauth = auth.oauth && typeof auth.oauth === 'object' ? auth.oauth : {};
  return {
    apiKey: typeof auth.apiKey === 'string' ? auth.apiKey : '',
    bearerToken: typeof auth.bearerToken === 'string' ? auth.bearerToken : '',
    oauth: {
      clientId: typeof oauth.clientId === 'string' ? oauth.clientId : '',
      clientSecret: typeof oauth.clientSecret === 'string' ? oauth.clientSecret : '',
      accessToken: typeof oauth.accessToken === 'string' ? oauth.accessToken : '',
      refreshToken: typeof oauth.refreshToken === 'string' ? oauth.refreshToken : '',
      scopes: typeof oauth.scopes === 'string' ? oauth.scopes : '',
      authorizeUrl: typeof oauth.authorizeUrl === 'string' ? oauth.authorizeUrl : '',
      tokenUrl: typeof oauth.tokenUrl === 'string' ? oauth.tokenUrl : '',
    },
  };
}

function mcpAccountConnected(account) {
  if (!account || account.authType === 'none') return true;
  const auth = normalizeMcpAuth(account.auth);
  if (account.authType === 'api_key') return !!auth.apiKey;
  if (account.authType === 'bearer') return !!auth.bearerToken;
  if (account.authType === 'oauth') return !!auth.oauth.accessToken;
  return false;
}

function normalizeMcpAccount(raw = {}) {
  const authType = MCP_AUTH_TYPES.has(raw.authType) ? raw.authType : 'none';
  const connected = mcpAccountConnected({ authType, auth: raw.auth });
  return {
    id: raw.id || newId('mcpacc'),
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : 'Account',
    authType,
    auth: normalizeMcpAuth(raw.auth),
    connectedAt:
      typeof raw.connectedAt === 'number' ? raw.connectedAt : connected ? Date.now() : null,
  };
}

function migrateMcpRecord(raw) {
  const m = { ...raw };
  if (Array.isArray(m.accounts) && m.accounts.length) {
    m.accounts = m.accounts.map(normalizeMcpAccount);
  } else {
    const legacyType = MCP_AUTH_TYPES.has(m.authType) ? m.authType : 'none';
    const legacyAuth = normalizeMcpAuth(m.auth);
    const hadLegacyAuth =
      legacyType !== 'none' &&
      (legacyAuth.apiKey ||
        legacyAuth.bearerToken ||
        legacyAuth.oauth.accessToken ||
        legacyAuth.oauth.clientId);
    if (hadLegacyAuth) {
      const acc = normalizeMcpAccount({
        id: newId('mcpacc'),
        label: 'Default',
        authType: legacyType,
        auth: legacyAuth,
        connectedAt: typeof m.authConnectedAt === 'number' ? m.authConnectedAt : Date.now(),
      });
      m.accounts = [acc];
      m.defaultAccountId = acc.id;
    } else {
      m.accounts = [];
      m.defaultAccountId = null;
    }
  }
  if (typeof m.authRequired !== 'boolean') {
    m.authRequired =
      m.suggestedAuthType && m.suggestedAuthType !== 'none'
        ? true
        : MCP_AUTH_TYPES.has(m.authType) && m.authType !== 'none';
  }
  if (!MCP_AUTH_TYPES.has(m.suggestedAuthType)) {
    m.suggestedAuthType =
      m.authRequired && MCP_AUTH_TYPES.has(m.authType) && m.authType !== 'none' ? m.authType : 'none';
  }
  if (m.defaultAccountId && !m.accounts.some((a) => a.id === m.defaultAccountId)) {
    m.defaultAccountId = m.accounts[0]?.id || null;
  }
  return m;
}

function enrichMcp(raw) {
  const m = migrateMcpRecord(raw);
  const accounts = m.accounts || [];
  const connectedCount = accounts.filter(mcpAccountConnected).length;
  const defaultAccount =
    accounts.find((a) => a.id === m.defaultAccountId) || accounts.find(mcpAccountConnected) || null;
  return {
    ...m,
    accounts,
    defaultAccountId: defaultAccount?.id || m.defaultAccountId || null,
    accountCount: accounts.length,
    connectedAccountCount: connectedCount,
    authConnected: connectedCount > 0 || (!m.authRequired && accounts.length === 0),
    authType: defaultAccount?.authType || m.suggestedAuthType || 'none',
    auth: defaultAccount?.auth || normalizeMcpAuth({}),
  };
}

function mcpAuthConnected(m) {
  return enrichMcp(m).authConnected;
}

function listMcpsRaw() {
  return readJson('mcps.json', []);
}

function listMcps() {
  return listMcpsRaw().map(enrichMcp);
}

function getMcp(id) {
  const m = listMcpsRaw().find((x) => x.id === id);
  return m ? enrichMcp(m) : null;
}

function stripMcpForDisk(m) {
  const enriched = enrichMcp(m);
  const { authConnected, accountCount, connectedAccountCount, auth, authType, ...rest } = enriched;
  return rest;
}

function addMcp({
  name,
  transport,
  command,
  args,
  env,
  url,
  description,
  authType,
  authRequired,
  suggestedAuthType,
  lastProbeAt,
} = {}) {
  const mcps = listMcpsRaw();
  const urlTrim = typeof url === 'string' ? url.trim() : '';
  const useHttp = urlTrim.length > 0 || transport === 'http';
  const suggested = MCP_AUTH_TYPES.has(suggestedAuthType)
    ? suggestedAuthType
    : MCP_AUTH_TYPES.has(authType)
      ? authType
      : 'none';
  const item = enrichMcp({
    id: newId('mcp'),
    name: name || 'New MCP',
    transport: useHttp ? 'http' : 'stdio',
    command: command || '',
    args: Array.isArray(args) ? args : [],
    env: env && typeof env === 'object' ? env : {},
    url: urlTrim,
    description: description || '',
    authRequired: typeof authRequired === 'boolean' ? authRequired : suggested !== 'none',
    suggestedAuthType: suggested,
    lastProbeAt: typeof lastProbeAt === 'number' ? lastProbeAt : null,
    accounts: [],
    defaultAccountId: null,
  });
  mcps.push(stripMcpForDisk(item));
  writeJson('mcps.json', mcps);
  return item;
}

function stripMcpRuntime(m) {
  return stripMcpForDisk(m);
}

function mergeMcpAuth(existing, incoming) {
  const next = normalizeMcpAuth(existing);
  const inc = normalizeMcpAuth(incoming);
  if (inc.apiKey) next.apiKey = inc.apiKey;
  if (inc.bearerToken) next.bearerToken = inc.bearerToken;
  if (inc.oauth.clientId) next.oauth.clientId = inc.oauth.clientId;
  if (inc.oauth.clientSecret) next.oauth.clientSecret = inc.oauth.clientSecret;
  if (inc.oauth.accessToken) next.oauth.accessToken = inc.oauth.accessToken;
  if (inc.oauth.refreshToken) next.oauth.refreshToken = inc.oauth.refreshToken;
  if (inc.oauth.scopes) next.oauth.scopes = inc.oauth.scopes;
  if (inc.oauth.authorizeUrl) next.oauth.authorizeUrl = inc.oauth.authorizeUrl;
  if (inc.oauth.tokenUrl) next.oauth.tokenUrl = inc.oauth.tokenUrl;
  return next;
}

function updateMcp(id, patch = {}) {
  const mcps = listMcpsRaw();
  const idx = mcps.findIndex((x) => x.id === id);
  if (idx < 0) return null;
  const m = enrichMcp(mcps[idx]);
  for (const key of ['name', 'transport', 'command', 'url', 'description']) {
    if (typeof patch[key] === 'string') m[key] = patch[key];
  }
  if (typeof patch.lastProbeAt === 'number') m.lastProbeAt = patch.lastProbeAt;
  if (Array.isArray(patch.args)) m.args = patch.args;
  if (patch.env && typeof patch.env === 'object') m.env = patch.env;
  if (typeof patch.authRequired === 'boolean') m.authRequired = patch.authRequired;
  if (patch.suggestedAuthType && MCP_AUTH_TYPES.has(patch.suggestedAuthType)) {
    m.suggestedAuthType = patch.suggestedAuthType;
  }
  if (patch.defaultAccountId !== undefined) m.defaultAccountId = patch.defaultAccountId || null;
  mcps[idx] = stripMcpForDisk(m);
  writeJson('mcps.json', mcps);
  return enrichMcp(mcps[idx]);
}

function getMcpAccount(mcpId, accountId) {
  const m = getMcp(mcpId);
  if (!m) return null;
  return m.accounts.find((a) => a.id === accountId) || null;
}

function addMcpAccount(mcpId, { label, authType } = {}) {
  const mcps = listMcpsRaw();
  const idx = mcps.findIndex((x) => x.id === mcpId);
  if (idx < 0) return null;
  const m = enrichMcp(mcps[idx]);
  const account = normalizeMcpAccount({
    label: label || `Account ${m.accounts.length + 1}`,
    authType: MCP_AUTH_TYPES.has(authType) ? authType : m.suggestedAuthType || 'none',
    auth: {},
  });
  m.accounts.push(account);
  if (!m.defaultAccountId) m.defaultAccountId = account.id;
  mcps[idx] = stripMcpForDisk(m);
  writeJson('mcps.json', mcps);
  return { mcp: enrichMcp(mcps[idx]), account };
}

function updateMcpAccount(mcpId, accountId, patch = {}) {
  const mcps = listMcpsRaw();
  const idx = mcps.findIndex((x) => x.id === mcpId);
  if (idx < 0) return null;
  const m = enrichMcp(mcps[idx]);
  const acc = m.accounts.find((a) => a.id === accountId);
  if (!acc) return null;
  if (typeof patch.label === 'string' && patch.label.trim()) acc.label = patch.label.trim();
  if (patch.authType && MCP_AUTH_TYPES.has(patch.authType)) acc.authType = patch.authType;
  if (patch.auth && typeof patch.auth === 'object') acc.auth = mergeMcpAuth(acc.auth, patch.auth);
  if (mcpAccountConnected(acc) && !acc.connectedAt) acc.connectedAt = Date.now();
  if (!mcpAccountConnected(acc)) acc.connectedAt = null;
  mcps[idx] = stripMcpForDisk(m);
  writeJson('mcps.json', mcps);
  return { mcp: enrichMcp(mcps[idx]), account: acc };
}

function removeMcpAccount(mcpId, accountId) {
  const mcps = listMcpsRaw();
  const idx = mcps.findIndex((x) => x.id === mcpId);
  if (idx < 0) return null;
  const m = enrichMcp(mcps[idx]);
  m.accounts = m.accounts.filter((a) => a.id !== accountId);
  if (m.defaultAccountId === accountId) {
    m.defaultAccountId = m.accounts[0]?.id || null;
  }
  mcps[idx] = stripMcpForDisk(m);
  writeJson('mcps.json', mcps);
  return enrichMcp(mcps[idx]);
}

function connectMcpAccountAuth(mcpId, accountId, body = {}) {
  const mcps = listMcpsRaw();
  const idx = mcps.findIndex((x) => x.id === mcpId);
  if (idx < 0) return null;
  const m = enrichMcp(mcps[idx]);
  const acc = m.accounts.find((a) => a.id === accountId);
  if (!acc) return null;
  if (body.authType && MCP_AUTH_TYPES.has(body.authType)) acc.authType = body.authType;
  if (body.auth && typeof body.auth === 'object') acc.auth = mergeMcpAuth(acc.auth, body.auth);
  acc.connectedAt = mcpAccountConnected(acc) ? Date.now() : null;
  mcps[idx] = stripMcpForDisk(m);
  writeJson('mcps.json', mcps);
  const enriched = enrichMcp(mcps[idx]);
  const authorizeUrl =
    acc.authType === 'oauth' && !mcpAccountConnected(acc) && acc.auth.oauth.authorizeUrl
      ? acc.auth.oauth.authorizeUrl
      : '';
  return { mcp: enriched, account: acc, authorizeUrl };
}

function disconnectMcpAccountAuth(mcpId, accountId) {
  const mcps = listMcpsRaw();
  const idx = mcps.findIndex((x) => x.id === mcpId);
  if (idx < 0) return null;
  const m = enrichMcp(mcps[idx]);
  const acc = m.accounts.find((a) => a.id === accountId);
  if (!acc) return null;
  acc.auth = normalizeMcpAuth({});
  acc.connectedAt = null;
  mcps[idx] = stripMcpForDisk(m);
  writeJson('mcps.json', mcps);
  return { mcp: enrichMcp(mcps[idx]), account: acc };
}

function connectMcpAuth(id, body = {}) {
  const m = getMcp(id);
  if (!m) return null;
  let accountId = body.accountId;
  if (!accountId) {
    if (m.defaultAccountId) accountId = m.defaultAccountId;
    else {
      const created = addMcpAccount(id, {
        label: body.label || 'Default',
        authType: body.authType || m.suggestedAuthType || 'none',
      });
      if (!created) return null;
      accountId = created.account.id;
    }
  }
  return connectMcpAccountAuth(id, accountId, body);
}

function disconnectMcpAuth(id, accountId) {
  const m = getMcp(id);
  if (!m) return null;
  const targetId = accountId || m.defaultAccountId || m.accounts[0]?.id;
  if (!targetId) {
    const mcps = listMcpsRaw();
    const idx = mcps.findIndex((x) => x.id === id);
    if (idx < 0) return null;
    const raw = enrichMcp(mcps[idx]);
    raw.accounts = [];
    raw.defaultAccountId = null;
    mcps[idx] = stripMcpForDisk(raw);
    writeJson('mcps.json', mcps);
    return enrichMcp(mcps[idx]);
  }
  const result = disconnectMcpAccountAuth(id, targetId);
  return result?.mcp || null;
}

function resolveMcpAccountsForBinding(mcpId, accountIds = []) {
  const m = getMcp(mcpId);
  if (!m) return [];
  const ids = Array.isArray(accountIds) ? accountIds.filter(Boolean) : [];
  if (!ids.length) {
    return m.accounts.filter(mcpAccountConnected);
  }
  return ids.map((id) => m.accounts.find((a) => a.id === id)).filter(Boolean);
}

function buildMcpAccountHeaders(account) {
  if (!account) return {};
  const auth = normalizeMcpAuth(account.auth);
  if (account.authType === 'api_key' && auth.apiKey) {
    return {
      'X-Api-Key': auth.apiKey,
      Authorization: `ApiKey ${auth.apiKey}`,
    };
  }
  if (account.authType === 'bearer' && auth.bearerToken) {
    return { Authorization: `Bearer ${auth.bearerToken}` };
  }
  if (account.authType === 'oauth' && auth.oauth.accessToken) {
    return { Authorization: `Bearer ${auth.oauth.accessToken}` };
  }
  return {};
}

function resolveAgentMcpRuntimeSpec(agentId) {
  const agent = getAgent(agentId);
  if (!agent) return { mcpBindings: [], mcpServers: [] };
  const bindings = agent.mcpBindings?.length
    ? agent.mcpBindings
    : (agent.mcpIds || []).map((mcpId) => ({ mcpId, accountIds: [] }));
  return resolveMcpRuntimeFromBindings(bindings);
}

function removeMcp(id) {
  writeJson(
    'mcps.json',
    listMcpsRaw().filter((m) => m.id !== id),
  );
}

// ── Skins catalog (static: pixel-agents palettes + hue shifts) ──────────────
const BUILTIN_SKINS = [
  { id: 'classic', name: 'Classic', palette: 0, hueShift: 0 },
  { id: 'crimson', name: 'Crimson', palette: 1, hueShift: 0 },
  { id: 'forest', name: 'Forest', palette: 2, hueShift: 0 },
  { id: 'ocean', name: 'Ocean', palette: 3, hueShift: 0 },
  { id: 'violet', name: 'Violet', palette: 4, hueShift: 0 },
  { id: 'amber', name: 'Amber', palette: 5, hueShift: 0 },
  { id: 'mint', name: 'Mint', palette: 2, hueShift: 60 },
  { id: 'rose', name: 'Rose', palette: 1, hueShift: 200 },
];

function listCustomSkins() {
  return readJson('custom-skins.json', []);
}

function skinRenames() {
  return readJson('skin-renames.json', {});
}

const EDITABLE_BUILTIN_ROLES = ['coo'];

function builtinAgentLabels() {
  return readJson('builtin-agent-labels.json', {});
}

function normalizeBuiltinEntry(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') return { label: raw };
  return raw;
}

function getBuiltinAgentSettings(role) {
  return normalizeBuiltinEntry(builtinAgentLabels()[role]);
}

function getBuiltinAgentLabel(role) {
  return getBuiltinAgentSettings(role).label || null;
}

function updateBuiltinAgent(role, patch = {}) {
  if (!EDITABLE_BUILTIN_ROLES.includes(role)) throw new Error('Builtin agent cannot be edited');
  const labels = builtinAgentLabels();
  const cur = normalizeBuiltinEntry(labels[role]);
  if (patch.label !== undefined) {
    const label = String(patch.label).trim();
    if (!label) throw new Error('Name cannot be empty.');
    cur.label = label;
  }
  if (patch.sprite !== undefined) {
    cur.sprite = Number(patch.sprite);
  }
  if (patch.hueShift !== undefined) {
    cur.hueShift = Number(patch.hueShift);
  }
  labels[role] = cur;
  writeJson('builtin-agent-labels.json', labels);
  return { role, ...cur };
}

function listSkins() {
  const renames = skinRenames();
  const builtins = BUILTIN_SKINS.map((s) => ({
    ...s,
    name: renames[s.id] || s.name,
  }));
  return [...builtins, ...listCustomSkins()];
}

function getSkin(id) {
  return listSkins().find((s) => s.id === id) || null;
}

function updateSkin(id, patch = {}) {
  const custom = listCustomSkins();
  const idx = custom.findIndex((s) => s.id === id);
  if (idx >= 0) {
    if (patch.name !== undefined) {
      const label = String(patch.name).trim();
      if (!label) throw new Error('Name cannot be empty.');
      custom[idx].name = label;
    }
    writeJson('custom-skins.json', custom);
    return custom[idx];
  }

  if (BUILTIN_SKINS.some((s) => s.id === id)) {
    if (patch.name !== undefined) {
      const label = String(patch.name).trim();
      if (!label) throw new Error('Name cannot be empty.');
      const renames = skinRenames();
      renames[id] = label;
      writeJson('skin-renames.json', renames);
    }
    return getSkin(id);
  }

  return null;
}

function charactersDir() {
  return path.join(__dirname, '..', 'web', 'office-pa', 'assets', 'characters');
}

function nextCustomPalette() {
  const custom = listCustomSkins();
  const used = new Set([...BUILTIN_SKINS, ...custom].map((s) => s.palette));
  for (let p = 6; p < 64; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error('Too many custom character skins (max 58).');
}

function addCustomSkin({ name, pngBuffer }) {
  const label = String(name || '').trim();
  if (!label) throw new Error('Name is required.');
  if (!pngBuffer?.length) throw new Error('Sprite PNG is required (112×96 px).');

  const palette = nextCustomPalette();
  const dir = charactersDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `char_${palette}.png`), pngBuffer);

  const skin = {
    id: newId('skin'),
    name: label,
    palette,
    hueShift: 0,
    custom: true,
    createdAt: Date.now(),
  };
  const custom = listCustomSkins();
  custom.push(skin);
  writeJson('custom-skins.json', custom);
  return skin;
}

// ── User-created agents ─────────────────────────────────────────────────────
function normalizeMcpBindings(agent) {
  if (Array.isArray(agent.mcpBindings) && agent.mcpBindings.length) {
    return agent.mcpBindings
      .filter((b) => b && b.mcpId)
      .map((b) => ({
        mcpId: b.mcpId,
        accountIds: Array.isArray(b.accountIds) ? b.accountIds.filter(Boolean) : [],
      }));
  }
  if (Array.isArray(agent.mcpIds) && agent.mcpIds.length) {
    return agent.mcpIds.map((mcpId) => ({ mcpId, accountIds: [] }));
  }
  return [];
}

function enrichAgent(raw) {
  const mcpBindings = normalizeMcpBindings(raw);
  const mcpIds = mcpBindings.length
    ? mcpBindings.map((b) => b.mcpId)
    : Array.isArray(raw.mcpIds)
      ? raw.mcpIds.filter(Boolean)
      : [];
  return {
    ...raw,
    mcpIds,
    mcpBindings,
  };
}

function listAgents() {
  return readJson('agents.json', []).map(enrichAgent);
}

function getAgent(id) {
  const a = readJson('agents.json', []).find((x) => x.id === id);
  return a ? enrichAgent(a) : null;
}

function addAgent(def = {}) {
  const agents = listAgents();
  const mcpBindings = normalizeMcpBindings(def);
  const item = {
    id: newId('uagent'),
    name: def.name || 'New Agent',
    role: def.role || 'worker',
    runtime: def.runtime || 'demo', // openclaw | hermes | demo
    sprite: Number.isInteger(def.sprite) ? def.sprite : 0,
    hueShift: Number.isInteger(def.hueShift) ? def.hueShift : 0,
    skillIds: Array.isArray(def.skillIds) ? def.skillIds : [],
    openclawSkillNames: Array.isArray(def.openclawSkillNames) ? def.openclawSkillNames : [],
    mcpIds: mcpBindings.map((b) => b.mcpId),
    mcpBindings,
    channels: def.channels || { internal: true, telegram: { enabled: false, botToken: '', allowedChats: [] } },
    openclawAgentId: def.openclawAgentId || null, // real OpenClaw agent id (1 NPC = 1 agent)
    templateId: def.templateId || null,
    hiredAt: typeof def.hiredAt === 'number' ? def.hiredAt : null,
    salaryCreditsPerMonth: Number.isFinite(def.salaryCreditsPerMonth) ? def.salaryCreditsPerMonth : null,
    nextSalaryDueAt: typeof def.nextSalaryDueAt === 'number' ? def.nextSalaryDueAt : null,
    lastSalaryPaidAt: typeof def.lastSalaryPaidAt === 'number' ? def.lastSalaryPaidAt : null,
    payrollStatus: def.payrollStatus || null,
    fireAt: typeof def.fireAt === 'number' ? def.fireAt : null,
    ecsSubscriptionId: def.ecsSubscriptionId || null,
    createdAt: Date.now(),
  };
  agents.push(item);
  writeJson('agents.json', agents);
  return item;
}

function updateAgent(id, patch = {}) {
  const agents = listAgents();
  const a = agents.find((x) => x.id === id);
  if (!a) return null;
  for (const k of [
    'name',
    'role',
    'runtime',
    'sprite',
    'hueShift',
    'skillIds',
    'openclawSkillNames',
    'mcpIds',
    'mcpBindings',
    'channels',
    'openclawAgentId',
    'templateId',
    'hiredAt',
    'salaryCreditsPerMonth',
    'nextSalaryDueAt',
    'lastSalaryPaidAt',
    'payrollStatus',
    'fireAt',
    'ecsSubscriptionId',
  ]) {
    if (patch[k] !== undefined) a[k] = patch[k];
  }
  if (patch.mcpBindings !== undefined || patch.mcpIds !== undefined) {
    const merged = enrichAgent({ ...a, ...patch });
    a.mcpBindings = merged.mcpBindings;
    a.mcpIds = merged.mcpIds;
  }
  writeJson('agents.json', agents);
  return a;
}

function removeAgent(id) {
  writeJson(
    'agents.json',
    listAgents().filter((a) => a.id !== id),
  );
}

// ── Channel routing (which agent an inbound channel talks to) ───────────────
// Map of "<provider>:<account>" -> agentId. Default front door is the COO, who
// then delegates to subagents — so a channel need not target a specialist.
function getChannelRoutes() {
  const m = readJson('channel-routes.json', {});
  return m && typeof m === 'object' ? m : {};
}

function setChannelRoute(provider, account, agentId) {
  const key = `${provider}:${account || 'default'}`;
  const routes = getChannelRoutes();
  routes[key] = agentId || 'coo';
  return writeJson('channel-routes.json', routes)[key];
}

function getChannelRoute(provider, account) {
  return getChannelRoutes()[`${provider}:${account || 'default'}`] || 'coo';
}

// ── Per-agent knowledge (files dragged in to "teach" an agent) ──────────────
function knowledgeDir(agentId) {
  const dir = dataPath('knowledge', String(agentId).replace(/[^a-z0-9_:-]+/gi, '_'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listKnowledge(agentId) {
  const dir = knowledgeDir(agentId);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => !f.endsWith('.extracted.txt'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { file: f, size: st.size, addedAt: st.mtimeMs };
      });
  } catch {
    return [];
  }
}

function knowledgeText(agentId, limitChars = 6000) {
  const dir = knowledgeDir(agentId);
  let out = '';
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.extracted.txt')) continue;
      out += `\n# ${f.replace(/\.extracted\.txt$/, '')}\n${fs.readFileSync(path.join(dir, f), 'utf8')}\n`;
      if (out.length > limitChars) break;
    }
  } catch {
    /* none */
  }
  return out.slice(0, limitChars).trim();
}

function removeKnowledge(agentId, file) {
  const dir = knowledgeDir(agentId);
  const safe = path.basename(String(file));
  for (const name of [safe, `${safe}.extracted.txt`]) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      /* ignore */
    }
  }
}

// ── Deliverables index (the "agent complete job" inbox) ─────────────────────
function deliverablesIndexPath() {
  return path.join('deliverables', 'index.json');
}

const DELIVERABLE_KINDS = new Set(['plan_complete', 'daily_report', 'alert', 'job']);

function stripPlanInstruction(task) {
  return String(task || '')
    .replace(/^Produce a clear, step-by-step PLAN[\s\S]*?\n\nTask:\s*/i, '')
    .trim();
}

function defaultDeliverableSummary(kind, agentLabel, task) {
  const short = stripPlanInstruction(task);
  const clip = short.length > 100 ? `${short.slice(0, 97)}…` : short;
  switch (kind) {
    case 'plan_complete':
      return clip ? `Plan ready: ${clip}` : 'Your plan is ready to review.';
    case 'daily_report':
      return clip ? `Daily report: ${clip}` : 'Daily report is ready.';
    case 'alert':
      return clip || 'Something needs your attention.';
    default:
      return clip ? `${agentLabel || 'Agent'} completed: ${clip}` : `${agentLabel || 'Agent'} completed a task.`;
  }
}

function enrichDeliverable(item) {
  const kind = DELIVERABLE_KINDS.has(item.kind) ? item.kind : 'job';
  const task = stripPlanInstruction(item.task);
  return {
    ...item,
    kind,
    task,
    summary: item.summary || defaultDeliverableSummary(kind, item.agentLabel, task),
  };
}

function listDeliverables() {
  return readJson(deliverablesIndexPath(), []).map(enrichDeliverable);
}

function addDeliverable({ agentId, agentLabel, task, file, kind, summary } = {}) {
  const normalizedKind = DELIVERABLE_KINDS.has(kind) ? kind : 'job';
  const cleanTask = stripPlanInstruction(task);
  const item = {
    id: newId('job'),
    kind: normalizedKind,
    agentId: agentId || null,
    agentLabel: agentLabel || 'Agent',
    task: cleanTask,
    summary: summary || defaultDeliverableSummary(normalizedKind, agentLabel, cleanTask),
    file: file ? path.basename(file) : null,
    createdAt: Date.now(),
    forwarded: false,
    read: false,
  };
  const list = readJson(deliverablesIndexPath(), []);
  list.unshift(item);
  if (list.length > 500) list.length = 500;
  writeJson(deliverablesIndexPath(), list);
  return enrichDeliverable(item);
}

function addBossSummary({ kind, summary, task, agentId, agentLabel, file, content } = {}) {
  const normalizedKind = DELIVERABLE_KINDS.has(kind) ? kind : 'alert';
  let savedFile = file || null;
  if (!savedFile && content) {
    try {
      const dir = dataPath('deliverables');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      savedFile = path.join(dir, `${normalizedKind}-${stamp}.md`);
      fs.writeFileSync(savedFile, String(content), 'utf8');
    } catch {
      savedFile = null;
    }
  }
  return addDeliverable({
    agentId,
    agentLabel: agentLabel || (normalizedKind === 'daily_report' ? 'Schedule' : 'Office'),
    task: task || summary || '',
    file: savedFile,
    kind: normalizedKind,
    summary,
  });
}

function getDeliverable(id) {
  const item = listDeliverables().find((d) => d.id === id);
  if (!item) return null;
  let content = '';
  if (item.file) {
    try {
      content = fs.readFileSync(dataPath('deliverables', item.file), 'utf8');
    } catch {
      content = '(file missing)';
    }
  }
  return { ...item, content };
}

function markForwarded(id, forwarded = true) {
  const list = listDeliverables();
  const d = list.find((x) => x.id === id);
  if (!d) return null;
  d.forwarded = forwarded;
  writeJson(deliverablesIndexPath(), list);
  return d;
}

function listAgentReviews() {
  return readJson('agent-reviews.json', {});
}

function getAgentReview(key) {
  const hit = listAgentReviews()[key];
  if (!hit || !Number.isInteger(hit.rating)) return null;
  return hit;
}

function setAgentReview(key, rating) {
  const n = Number(rating);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error('Rating must be 1–5 stars.');
  const all = listAgentReviews();
  all[key] = { rating: n, updatedAt: Date.now() };
  writeJson('agent-reviews.json', all);
  return all[key];
}

function userAgentReviewKey(id) {
  return `user:${id}`;
}

function builtinAgentReviewKey(role) {
  return `builtin:${role}`;
}

function templateReviewKey(templateId) {
  return `template:${templateId}`;
}

function summarizeTemplateReviews(templateId) {
  const all = listAgentReviews();
  const ratings = [];
  const direct = all[templateReviewKey(templateId)];
  if (direct?.rating) ratings.push(direct.rating);
  for (const a of listAgents()) {
    if (a.templateId !== templateId) continue;
    const r = all[userAgentReviewKey(a.id)];
    if (r?.rating) ratings.push(r.rating);
  }
  const hireCount = listAgents().filter((a) => a.templateId === templateId).length;
  if (!ratings.length) return { rating: null, reviewCount: 0, hireCount };
  const sum = ratings.reduce((s, n) => s + n, 0);
  return {
    rating: Math.round((sum / ratings.length) * 10) / 10,
    reviewCount: ratings.length,
    hireCount,
  };
}

function enrichCatalogTemplate(template) {
  const stats = summarizeTemplateReviews(template.id);
  const { trustedBy: _tb, rating: _r, reviewCount: _rc, ...rest } = template;
  return {
    ...rest,
    rating: stats.rating,
    reviewCount: stats.reviewCount,
    hireCount: stats.hireCount,
  };
}

module.exports = {
  listSkills,
  addSkill,
  ensureSkill,
  updateSkill,
  removeSkill,
  listMcps,
  getMcp,
  addMcp,
  updateMcp,
  addMcpAccount,
  updateMcpAccount,
  removeMcpAccount,
  connectMcpAccountAuth,
  disconnectMcpAccountAuth,
  connectMcpAuth,
  disconnectMcpAuth,
  resolveMcpAccountsForBinding,
  buildMcpAccountHeaders,
  resolveAgentMcpRuntimeSpec,
  removeMcp,
  getMcpAccount,
  listSkins,
  getSkin,
  updateSkin,
  addCustomSkin,
  listAgents,
  getAgent,
  addAgent,
  updateAgent,
  removeAgent,
  knowledgeDir,
  listKnowledge,
  knowledgeText,
  removeKnowledge,
  listDeliverables,
  addDeliverable,
  addBossSummary,
  getDeliverable,
  markForwarded,
  getChannelRoutes,
  getChannelRoute,
  setChannelRoute,
  getBuiltinAgentLabel,
  getBuiltinAgentSettings,
  updateBuiltinAgent,
  listAgentReviews,
  getAgentReview,
  setAgentReview,
  userAgentReviewKey,
  builtinAgentReviewKey,
  templateReviewKey,
  summarizeTemplateReviews,
  enrichCatalogTemplate,
};
