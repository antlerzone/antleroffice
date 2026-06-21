// In-memory office state. Single source of truth that the pixel renderer polls
// via /api/office/snapshot. Compatible with the OpenClaw command contract.

let seq = 1;
function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${seq++}`;
}

const state = {
  agents: [],
  chat: [],
  selectedAgentId: null,
  updatedAt: Date.now(),
};

function touch() {
  state.updatedAt = Date.now();
}

function notifyAgentActivity(agent) {
  if (!agent) return;
  try {
    require('./office-events').notifyOfficeUpdate({
      agentId: agent.id,
      role: agent.role,
      npcState: agent.npcState,
    });
  } catch {
    /* office-events optional at import time */
  }
}

function addAgent({
  id,
  label,
  role,
  charSprite,
  hueShift = 0,
  npcState = 'resting',
  bubbleText = '',
  runtime = null,
  skillIds = [],
  openclawSkillNames = [],
  mcpIds = [],
  mcpBindings = [],
  channels = null,
  userAgentId = null,
  openclawAgentId = null,
  devEngine = null,
  devScope = null,
}) {
  const agent = {
    id: id || uid('npc'),
    label: label || role || 'NPC',
    role: role || 'worker',
    charSprite: typeof charSprite === 'number' ? charSprite : pickSprite(),
    hueShift,
    npcState,
    bubbleText,
    currentJob: null,
    runtime,
    skillIds,
    openclawSkillNames,
    mcpIds,
    mcpBindings,
    channels,
    userAgentId,
    openclawAgentId,
    devEngine,
    devScope: devScope || { canWrite: true, canReview: true },
  };
  state.agents.push(agent);
  touch();
  return agent;
}

function agentPatchFromDef(d) {
  return {
    label: d.name || d.role,
    role: d.role || 'worker',
    charSprite: Number.isInteger(d.sprite) ? d.sprite : 0,
    hueShift: Number.isInteger(d.hueShift) ? d.hueShift : 0,
    runtime: d.runtime || 'demo',
    skillIds: d.skillIds || [],
    openclawSkillNames: d.openclawSkillNames || [],
    mcpIds: d.mcpIds || [],
    mcpBindings: d.mcpBindings || [],
    channels: d.channels || null,
    userAgentId: d.id,
    openclawAgentId: d.openclawAgentId || null,
    devEngine: d.devEngine || null,
    devScope: d.devScope || { canWrite: true, canReview: true },
  };
}

/** CEO uses a fixed office station; other hires get user:{id} NPCs. */
function attachHiredAgent(def) {
  if (!def?.id) return null;
  const orgRoles = require('./org-roles');
  if (orgRoles.isCooRole(def.role)) {
    const station = state.agents.find((a) => orgRoles.isCooRole(a.role) && !a.external);
    if (station) {
      setAgent(station.id, agentPatchFromDef(def));
      removeAgent(`user:${def.id}`);
      return station;
    }
  }
  const id = `user:${def.id}`;
  if (state.agents.find((a) => a.id === id)) return getAgent(id);
  return addAgent({ id, ...agentPatchFromDef(def) });
}

function clearRoleStation(role, { label, charSprite } = {}) {
  const station = state.agents.find((a) => a.role === role && !a.external && a.userAgentId);
  if (!station) return null;
  const roster = require('./roster');
  const dept = roster.byRole(role);
  setAgent(station.id, {
    userAgentId: null,
    label: label || dept?.label || role,
    charSprite: Number.isInteger(charSprite) ? charSprite : dept?.charSprite ?? station.charSprite,
    openclawAgentId: null,
    runtime: null,
    skillIds: [],
    openclawSkillNames: [],
    mcpIds: [],
    mcpBindings: [],
    channels: null,
    npcState: 'resting',
    bubbleText: '',
    currentJob: null,
    awaitingBossInput: false,
  });
  return station;
}

// Mirror the persisted user-created agents into the office on boot (idempotent).
function loadUserAgents(defs = []) {
  for (const d of defs) {
    attachHiredAgent(d);
  }
}

function setSelected(id) {
  state.selectedAgentId = id || null;
  touch();
  return state.selectedAgentId;
}

let spriteCounter = 0;
function pickSprite() {
  return spriteCounter++ % 6;
}

function getAgent(idOrRole) {
  const key = String(idOrRole || '');
  const roleAlias = key === 'ceo' ? 'coo' : key;
  return (
    state.agents.find((a) => a.id === key) ||
    state.agents.find((a) => a.role === key) ||
    state.agents.find((a) => a.role === roleAlias) ||
    null
  );
}

/** OpenClaw Gateway agent id for a boss-chat office NPC, or null if not gateway-backed. */
function resolveOpenClawAgentId(agentIdOrRole) {
  const agent = getAgent(agentIdOrRole);
  if (!agent || agent.external) return null;
  if (agent.openclawAgentId) return agent.openclawAgentId;
  if (agent.role === 'secretary') return 'main';
  return null;
}

function ensureRole(role, label, charSprite) {
  let a = state.agents.find((x) => x.role === role);
  if (!a) a = addAgent({ role, label, charSprite });
  return a;
}

function setAgent(idOrRole, patch) {
  const a = getAgent(idOrRole);
  if (!a) return null;
  const prevState = a.npcState;
  const prevBubble = a.bubbleText;
  Object.assign(a, patch);
  touch();
  if (patch.npcState !== undefined || patch.bubbleText !== undefined || patch.currentJob !== undefined) {
    if (a.npcState !== prevState || a.bubbleText !== prevBubble) notifyAgentActivity(a);
  }
  return a;
}

function removeAgent(id) {
  const i = state.agents.findIndex((a) => a.id === id);
  if (i >= 0) {
    state.agents.splice(i, 1);
    touch();
  }
}

function rest(idOrRole, bubbleText = '') {
  return setAgent(idOrRole, { npcState: 'resting', bubbleText, currentJob: null, awaitingBossInput: false });
}

function work(idOrRole, bubbleText, currentJob = null) {
  return setAgent(idOrRole, { npcState: 'working', bubbleText, currentJob, awaitingBossInput: false });
}

// ── External OpenClaw agents (imported from other desktops) ────────────────
// A remote OpenClaw on another machine registers its agents here; they become
// NPCs in this office and animate via the same office-state → pixel pipeline.
function hashSprite(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 6;
}

function registerExternalAgent({ source, agentId, name, role, skill, charSprite } = {}) {
  const src = String(source || 'remote');
  const aid = String(agentId || uid('a'));
  const id = `ext:${src}:${aid}`;
  const label = `${name || role || skill || 'Agent'} @${src}`;
  let a = state.agents.find((x) => x.id === id);
  if (!a) {
    a = addAgent({
      id,
      label,
      role: role || skill || 'worker',
      charSprite: typeof charSprite === 'number' ? charSprite : hashSprite(id),
    });
  } else {
    a.label = label;
  }
  a.external = true;
  a.source = src;
  a.skill = skill || null;
  a.lastSeen = Date.now();
  touch();
  return a;
}

function externalStatus(id, { state: st, note } = {}) {
  const a = getAgent(id);
  if (!a) return null;
  a.lastSeen = Date.now();
  return st === 'working'
    ? work(a.id, note || `${a.label} working…`)
    : rest(a.id, note || '');
}

function heartbeat(id) {
  const a = getAgent(id);
  if (a) {
    a.lastSeen = Date.now();
    touch();
  }
  return a;
}

// Drop external agents whose desktop stopped reporting (offline).
function pruneExternal(ttlMs = 30000) {
  const now = Date.now();
  for (const a of [...state.agents]) {
    if (a.external && a.lastSeen && now - a.lastSeen > ttlMs) removeAgent(a.id);
  }
}

function addChat(from, text, threadId, meta) {
  if (threadId) {
    const bossChat = require('./boss-chat-store');
    const msg = bossChat.addMessage(threadId, from, text, meta);
    if (msg) touch();
    return msg;
  }
  const msg = {
    id: uid('msg'),
    from,
    text,
    ts: Date.now(),
    authorName: meta?.authorName || null,
  };
  state.chat.push(msg);
  if (state.chat.length > 200) state.chat.shift();
  touch();
  return msg;
}

function snapshot({ agentId, threadId, ownerKey, ownerName } = {}) {
  const bossChat = require('./boss-chat-store');
  bossChat.migrateFromLegacy(state.chat);

  let chat = [];
  const key = ownerKey || 'local:boss';
  const threads = bossChat.inboxSummaries(key, ownerName);
  let activeThreadId = null;

  if (agentId) {
    activeThreadId = bossChat.resolveThreadId(agentId, threadId, key, ownerName);
    if (activeThreadId) {
      chat = bossChat.getMessages(activeThreadId);
    }
  }

  return {
    agents: state.agents,
    chat,
    threads,
    ownerKey: key,
    ownerName: ownerName || null,
    activeThreadId,
    selectedAgentId: state.selectedAgentId,
    updatedAt: state.updatedAt,
  };
}

module.exports = {
  state,
  uid,
  addAgent,
  loadUserAgents,
  attachHiredAgent,
  clearRoleStation,
  setSelected,
  getAgent,
  resolveOpenClawAgentId,
  ensureRole,
  setAgent,
  removeAgent,
  rest,
  work,
  registerExternalAgent,
  externalStatus,
  heartbeat,
  pruneExternal,
  addChat,
  snapshot,
};
