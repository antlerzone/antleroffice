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

async function injectChatLine(sessionKey, message, role = 'assistant') {
  const text = String(message || '').trim();
  if (!text) return { ok: false, skipped: true, reason: 'empty' };
  const params = { sessionKey, message: text, role };
  try {
    const injected = await oc.gatewayCall('chat.inject', params, { timeoutMs: 10000 });
    if (injected?.ok !== false && !injected?.error) return { ok: true };
  } catch {
    /* try legacy single-param inject */
  }
  const legacy = await oc.gatewayCall('chat.inject', { sessionKey, message: text }, { timeoutMs: 10000 });
  if (legacy?.ok !== false && !legacy?.error) return { ok: true };
  return { ok: false, reason: legacy?.error || 'inject_failed' };
}

/**
 * Append one intake exchange as two separate messages (Boss user + Secretary assistant).
 */
async function syncIntakeTurnToOpenClaw({ sessionKey, userText, assistantText } = {}) {
  const key = String(sessionKey || '').trim();
  const boss = String(userText || '').trim();
  const secretary = String(assistantText || '').trim();
  if (!key || !boss || !secretary) return { ok: false, skipped: true, reason: 'missing_fields' };
  if (!(await oc.isAvailable())) return { ok: false, skipped: true, reason: 'openclaw_unavailable' };

  const hasHistory = await sessionHasHistory(key);
  if (!hasHistory) return { ok: false, skipped: true, reason: 'session_not_started' };

  const isStatusOnly = boss === '[系统状态]' || boss.startsWith('[CEO') || boss.startsWith('[系统]');
  if (isStatusOnly) {
    const one = await injectChatLine(key, secretary, 'assistant');
    return one.ok ? { ok: true, sessionKey: key } : { ok: false, skipped: true, reason: one.reason };
  }

  const bossLine = await injectChatLine(key, boss, 'user');
  const secLine = await injectChatLine(key, secretary, 'assistant');
  if (bossLine.ok && secLine.ok) return { ok: true, sessionKey: key };

  const block = formatIntakeContextBlock(boss, secretary);
  const fallback = await oc.gatewayCall('chat.inject', { sessionKey: key, message: block }, { timeoutMs: 10000 });
  if (fallback?.ok !== false && !fallback?.error) return { ok: true, sessionKey: key, legacy: true };
  return { ok: false, skipped: true, reason: fallback?.error || 'inject_failed' };
}

/**
 * Run CEO pipeline after Secretary delegates; mirror completion back to Live Chat session.
 */
async function runDelegatedCooTask({
  taskText,
  threadId = null,
  ownerKey = 'local:boss',
  sessionKey = '',
  label = '任务',
} = {}) {
  const bossChat = require('./boss-chat-store');
  const workBoard = require('./work-board');
  const { handleInstruction } = require('./agent-runtime');
  const key = String(sessionKey || '').trim();
  const tid = threadId || bossChat.resolveThreadId('secretary', threadId, ownerKey);
  workBoard.createCeoInboxCard({
    task: taskText,
    threadId: tid,
    shortTask: String(taskText || '').slice(0, 80),
    ownerKey,
  });

  const pushStatus = async (assistantText) => {
    if (!key) return;
    await injectChatLine(key, String(assistantText || '').trim(), 'assistant');
  };

  try {
    const outcome = await handleInstruction(String(taskText || '').trim(), {
      threadId: tid,
      ownerKey,
      mode: 'agent',
      awaitCompletion: true,
    });
    const resultThreadId = outcome.threadId || tid;
    const msgs = resultThreadId ? bossChat.getMessages(resultThreadId) : [];
    const summary = msgs
      .slice(-6)
      .map((m) => {
        const who = m.authorName || m.from || 'agent';
        return `**${who}**: ${String(m.text || '').slice(0, 900)}`;
      })
      .join('\n\n');
    if (summary) {
      await pushStatus(`**COO 执行完成**（${label}）\n\n${summary}`);
    } else {
      await pushStatus(`**COO 执行完成**（${label}）。请到 **办公室 (Office)** 查看 COO / 各部门的详细结果。`);
    }
    return outcome;
  } catch (e) {
    await pushStatus(`**COO 执行失败**（${label}）：${e.message}`);
    throw e;
  }
}

module.exports = {
  syncIntakeTurnToOpenClaw,
  formatIntakeContextBlock,
  sessionHasHistory,
  runDelegatedCooTask,
  runDelegatedCeoTask: runDelegatedCooTask,
};
