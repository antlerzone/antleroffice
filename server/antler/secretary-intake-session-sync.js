/**
 * Mirror AntlerOffice secretary intake turns into OpenClaw session history
 * so follow-up messages that reach the Gateway still have context.
 */

const oc = require('./openclaw-config');

async function sessionHasHistory(sessionKey) {
  if (!sessionKey) return false;
  try {
    const h = await oc.gatewayCall('chat.history', { sessionKey, limit: 1 }, { timeoutMs: 8000 });
    return Array.isArray(h.messages) && h.messages.length > 0;
  } catch {
    return false;
  }
}

function formatIntakeContextBlock(userText, assistantText) {
  return (
    `[AntlerOffice secretary intake — already handled, do not re-run tools for this turn]\n` +
    `Boss: ${String(userText || '').trim()}\n` +
    `Secretary: ${String(assistantText || '').trim()}`
  );
}

/**
 * Append one intake exchange to an existing OpenClaw session (best-effort).
 * Skips when session does not exist yet — UI still passes recentConversation to intake.
 */
async function syncIntakeTurnToOpenClaw({ sessionKey, userText, assistantText } = {}) {
  const key = String(sessionKey || '').trim();
  if (!key || !userText || !assistantText) return { ok: false, skipped: true, reason: 'missing_fields' };
  if (!(await oc.isAvailable())) return { ok: false, skipped: true, reason: 'openclaw_unavailable' };

  const hasHistory = await sessionHasHistory(key);
  if (!hasHistory) return { ok: false, skipped: true, reason: 'session_not_started' };

  const block = formatIntakeContextBlock(userText, assistantText);
  const injected = await oc.gatewayCall('chat.inject', { sessionKey: key, message: block }, { timeoutMs: 10000 });
  if (injected?.ok !== false && !injected?.error) return { ok: true, sessionKey: key };
  return { ok: false, skipped: true, reason: injected?.error || 'inject_failed' };
}

module.exports = {
  syncIntakeTurnToOpenClaw,
  formatIntakeContextBlock,
  sessionHasHistory,
};
