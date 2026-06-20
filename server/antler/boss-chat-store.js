// Persistent boss ↔ agent chat threads — scoped per ECS user (each account = own chats).

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const ocSession = require('./openclaw-session');

let cache = null;

function filePath() {
  return path.join(store.getDataDir(), 'boss-chats.json');
}

function migrateLegacyAgentIds(data) {
  let changed = false;
  for (const t of data.threads) {
    if (t.agentId === 'coo') {
      t.agentId = 'secretary';
      changed = true;
    }
  }
  if (changed) persist();
}

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch {
    cache = { seq: 1, threads: [], migrated: false };
  }
  if (!Array.isArray(cache.threads)) cache.threads = [];
  if (!cache.seq) cache.seq = 1;
  migrateLegacyAgentIds(cache);
  return cache;
}

function persist() {
  fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2), 'utf8');
}

function uid(prefix = 'thread') {
  const data = load();
  return `${prefix}-${Date.now().toString(36)}-${data.seq++}`;
}

function titleFromText(text) {
  const t = String(text || '').trim();
  if (!t) return 'New chat';
  return t.length > 42 ? `${t.slice(0, 42)}…` : t;
}

function normalizeOwnerKey(ownerKey) {
  return String(ownerKey || 'local:boss');
}

function threadOwnerKey(thread) {
  return thread.ownerKey || 'legacy:office';
}

function claimLegacyThreads(ownerKey, ownerName) {
  const key = normalizeOwnerKey(ownerKey);
  if (key === 'local:boss' || key === 'legacy:office') return;
  const data = load();
  let changed = false;
  for (const thread of data.threads) {
    const ok = threadOwnerKey(thread);
    if (!thread.ownerKey || ok === 'legacy:office') {
      thread.ownerKey = key;
      if (ownerName) thread.ownerName = ownerName;
      changed = true;
    }
  }
  if (changed) persist();
}

function listThreads(agentId, ownerKey) {
  const key = normalizeOwnerKey(ownerKey);
  const data = load();
  return data.threads
    .filter((t) => t.agentId === agentId && threadOwnerKey(t) === key)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
}

function listInboxThreads(ownerKey) {
  const key = normalizeOwnerKey(ownerKey);
  const data = load();
  return data.threads
    .filter((t) => threadOwnerKey(t) === key)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
}

function getThread(id) {
  return load().threads.find((t) => t.id === id) || null;
}

function getThreadForOwner(id, ownerKey) {
  const thread = getThread(id);
  if (!thread) return null;
  if (threadOwnerKey(thread) !== normalizeOwnerKey(ownerKey)) return null;
  return thread;
}

function ensureDefaultThread(agentId, ownerKey, ownerName) {
  const existing = listThreads(agentId, ownerKey);
  if (existing.length) return existing[0];
  return createThread(agentId, 'New chat', { ownerKey, ownerName });
}

function isDefaultThread(thread) {
  const threads = listThreads(thread.agentId, threadOwnerKey(thread));
  if (!threads.length) return true;
  const oldest = [...threads].sort((a, b) => a.createdAt - b.createdAt)[0];
  return oldest.id === thread.id;
}

function buildOpenClawSessionKey({ threadId, openclawAgentId = 'main', isDefault = false }) {
  return ocSession.buildBossThreadSessionKey({ openclawAgentId, threadId, isDefault });
}

function ensureOpenClawSessionKey(threadId, ownerKey, { openclawAgentId } = {}) {
  const thread = getThreadForOwner(threadId, ownerKey);
  if (!thread) return null;
  const agent = String(openclawAgentId || thread.openclawAgentId || 'main').trim() || 'main';
  const wantKey = buildOpenClawSessionKey({
    threadId: thread.id,
    openclawAgentId: agent,
    isDefault: isDefaultThread(thread),
  });
  const stale =
    !thread.openclawSessionKey ||
    thread.openclawAgentId !== agent ||
    ocSession.isLegacyBossSessionKey(thread.openclawSessionKey) ||
    thread.openclawSessionKey !== wantKey;
  if (stale) {
    thread.openclawAgentId = agent;
    thread.openclawSessionKey = wantKey;
    persist();
  }
  return thread.openclawSessionKey;
}

function createThread(agentId, title = 'New chat', { ownerKey, ownerName, openclawAgentId } = {}) {
  const data = load();
  const owner = normalizeOwnerKey(ownerKey);
  const existing = data.threads.filter(
    (t) => t.agentId === agentId && threadOwnerKey(t) === owner,
  );
  const isDefault = existing.length === 0;
  let resolved = openclawAgentId || null;
  if (!resolved) {
    try {
      resolved = require('./office-state').resolveOpenClawAgentId(agentId);
    } catch {
      resolved = null;
    }
  }
  const thread = {
    id: uid('thread'),
    agentId,
    ownerKey: owner,
    ownerName: ownerName || null,
    title: title || 'New chat',
    pinned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    openclawAgentId: resolved,
    openclawSessionKey: null,
  };
  if (resolved) {
    thread.openclawSessionKey = buildOpenClawSessionKey({
      threadId: thread.id,
      openclawAgentId: resolved,
      isDefault,
    });
  }
  data.threads.push(thread);
  persist();
  return thread;
}

function addMessage(threadId, from, text, meta = {}) {
  const data = load();
  const thread = data.threads.find((t) => t.id === threadId);
  if (!thread) return null;
  const msg = {
    id: uid('msg'),
    from,
    text,
    ts: Date.now(),
    authorName: meta.authorName || null,
  };
  thread.messages.push(msg);
  if (thread.messages.length > 200) thread.messages.shift();
  thread.updatedAt = Date.now();
  if (thread.title === 'New chat' && from === 'boss') {
    thread.title = titleFromText(text);
  }
  persist();
  try {
    require('./office-events').notifyChatUpdate({ threadId, agentId: thread.agentId });
  } catch {
    /* optional */
  }
  return msg;
}

function getMessages(threadId) {
  const thread = getThread(threadId);
  return thread ? thread.messages : [];
}

function setPinned(threadId, ownerKey, pinned) {
  const data = load();
  const thread = data.threads.find(
    (t) => t.id === threadId && threadOwnerKey(t) === normalizeOwnerKey(ownerKey),
  );
  if (!thread) return null;
  thread.pinned = !!pinned;
  thread.updatedAt = Date.now();
  persist();
  return thread;
}

function setThreadSessionKey(threadId, ownerKey, openclawSessionKey) {
  const thread = getThreadForOwner(threadId, ownerKey);
  if (!thread) return null;
  const key = String(openclawSessionKey || '').trim();
  if (!key) return null;
  thread.openclawSessionKey = key;
  thread.updatedAt = Date.now();
  persist();
  return thread;
}

function setThreadTitle(threadId, ownerKey, title) {
  const thread = getThreadForOwner(threadId, ownerKey);
  if (!thread) return null;
  const next = String(title || '').trim();
  if (!next) return null;
  thread.title = next;
  thread.updatedAt = Date.now();
  persist();
  return thread;
}

function findThreadBySessionKey(ownerKey, sessionKey) {
  const key = normalizeOwnerKey(ownerKey);
  const normalized = ocSession.normalizeSessionKey(sessionKey);
  const data = load();
  return (
    data.threads.find((t) => {
      if (threadOwnerKey(t) !== key || !t.openclawSessionKey) return false;
      const threadNorm = ocSession.normalizeSessionKey(t.openclawSessionKey, t.openclawAgentId || 'main');
      return threadNorm === normalized || t.openclawSessionKey === sessionKey;
    }) || null
  );
}

function deleteThread(threadId, ownerKey) {
  const data = load();
  const idx = data.threads.findIndex(
    (t) => t.id === threadId && threadOwnerKey(t) === normalizeOwnerKey(ownerKey),
  );
  if (idx < 0) return false;
  data.threads.splice(idx, 1);
  persist();
  return true;
}

function migrateFromLegacy(legacyMessages = []) {
  const data = load();
  if (data.migrated || !legacyMessages.length) return null;
  const thread = {
    id: uid('thread'),
    agentId: 'secretary',
    ownerKey: 'legacy:office',
    ownerName: null,
    title: titleFromText(legacyMessages[0]?.text) || 'Previous chats',
    pinned: false,
    createdAt: legacyMessages[0]?.ts || Date.now(),
    updatedAt: legacyMessages[legacyMessages.length - 1]?.ts || Date.now(),
    messages: legacyMessages.map((m) => ({ ...m })),
  };
  data.threads.push(thread);
  data.migrated = true;
  persist();
  return thread;
}

function resolveThreadId(agentId, threadId, ownerKey, ownerName) {
  const key = normalizeOwnerKey(ownerKey);
  if (threadId) {
    const owned = getThreadForOwner(threadId, key);
    if (owned) return owned.id;
  }
  if (!agentId) return null;
  const threads = listThreads(agentId, key);
  if (threads.length) return threads[0].id;
  return createThread(agentId, 'New chat', { ownerKey: key, ownerName }).id;
}

function threadGatewayBacked(thread) {
  try {
    return !!require('./office-state').resolveOpenClawAgentId(thread.agentId);
  } catch {
    return false;
  }
}

function threadSummaryRow(thread) {
  const gatewayBacked = threadGatewayBacked(thread);
  return {
    id: thread.id,
    agentId: thread.agentId,
    ownerKey: threadOwnerKey(thread),
    ownerName: thread.ownerName,
    title: thread.title,
    pinned: thread.pinned,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messageCount: gatewayBacked ? null : (thread.messages || []).length,
    gatewayBacked,
    openclawSessionKey: thread.openclawSessionKey || null,
    openclawAgentId: thread.openclawAgentId || null,
  };
}

function threadSummaries(agentId, ownerKey) {
  return listThreads(agentId, ownerKey).map(threadSummaryRow);
}

function inboxSummaries(ownerKey, ownerName) {
  claimLegacyThreads(ownerKey, ownerName);
  return listInboxThreads(ownerKey).map(threadSummaryRow);
}

module.exports = {
  claimLegacyThreads,
  listThreads,
  listInboxThreads,
  getThread,
  getThreadForOwner,
  ensureDefaultThread,
  createThread,
  addMessage,
  getMessages,
  setPinned,
  setThreadSessionKey,
  setThreadTitle,
  findThreadBySessionKey,
  deleteThread,
  migrateFromLegacy,
  resolveThreadId,
  threadSummaries,
  inboxSummaries,
  buildOpenClawSessionKey,
  ensureOpenClawSessionKey,
};
