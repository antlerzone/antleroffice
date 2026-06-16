// Unified OpenClaw session keys — Boss Chat popup and /chat use the same format.

function primaryAgentSessionKey(openclawAgentId = 'main') {
  const agent = String(openclawAgentId || 'main').trim() || 'main';
  return `agent:${agent}:main`;
}

function normalizeSessionKey(key, openclawAgentId = 'main') {
  const raw = String(key || '').trim();
  if (!raw || raw === 'main') return primaryAgentSessionKey(openclawAgentId);
  return raw;
}

function buildBossThreadSessionKey({ openclawAgentId = 'main', threadId, isDefault = false }) {
  const agent = String(openclawAgentId || 'main').trim() || 'main';
  if (isDefault) return primaryAgentSessionKey(agent);
  const peer = `boss-${String(threadId || '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 64)}`;
  return `agent:${agent}:main:dm:${peer}`;
}

function isLegacyBossSessionKey(key) {
  return /:dm:boss-/.test(String(key || ''));
}

module.exports = {
  primaryAgentSessionKey,
  normalizeSessionKey,
  buildBossThreadSessionKey,
  isLegacyBossSessionKey,
};
