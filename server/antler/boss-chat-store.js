// Persistent boss ↔ agent chat threads — scoped per ECS user (each account = own chats).

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');

let cache = null;

function filePath() {
  return path.join(store.getDataDir(), 'boss-chats.json');
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

function createThread(agentId, title = 'New chat', { ownerKey, ownerName } = {}) {
  const data = load();
  const thread = {
    id: uid('thread'),
    agentId,
    ownerKey: normalizeOwnerKey(ownerKey),
    ownerName: ownerName || null,
    title: title || 'New chat',
    pinned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
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
    agentId: 'coo',
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

function threadSummaries(agentId, ownerKey) {
  return listThreads(agentId, ownerKey).map(
    ({ id, agentId: aid, ownerKey: ok, ownerName, title, pinned, createdAt, updatedAt, messages }) => ({
      id,
      agentId: aid,
      ownerKey: ok,
      ownerName,
      title,
      pinned,
      createdAt,
      updatedAt,
      messageCount: messages.length,
    }),
  );
}

module.exports = {
  listThreads,
  getThread,
  getThreadForOwner,
  ensureDefaultThread,
  createThread,
  addMessage,
  getMessages,
  setPinned,
  deleteThread,
  migrateFromLegacy,
  resolveThreadId,
  threadSummaries,
};
