// Notify CEO via chat / channel / Telegram when COO needs a decision — without blocking other COO work.

const store = require('./store');
const office = require('./office-state');
const orgRoles = require('./org-roles');
const ceoPending = require('./ceo-pipeline-pending');
const cooRunTracker = require('./coo-run-tracker');

function describePending(pending) {
  const phase = String(pending?.phase || 'unknown');
  const task = pending?.shortTask || pending?.rawTask || pending?.instruction || 'pipeline task';
  if (phase === 'plan_approval') return `Plan approval: ${task}`;
  if (phase === 'push_approval') return `Push approval: ${pending?.branchName || task}`;
  if (phase === 'it_scan_ceo_gate') return `IT scan decision: ${task}`;
  if (phase === 'project_path') return `Project path needed: ${task}`;
  if (phase === 'future_plan_confirm') return `Future Plan confirmation: ${task}`;
  return `${phase}: ${task}`;
}

function isCeoDecisionReply(raw) {
  const body = String(raw || '');
  if (/\bAPPROVED\b/i.test(body)) return true;
  if (/\bREVISION\s*:/i.test(body)) return true;
  if (/\bSKIP\b/i.test(body)) return true;
  return false;
}

function matchPendingForReply(raw, threadId) {
  const onThread = ceoPending.get(threadId);
  if (onThread?.phase) {
    return { pending: onThread, threadId };
  }

  if (!isCeoDecisionReply(raw)) return null;

  const all = ceoPending.listAll();
  if (!all.length) return null;
  if (all.length === 1) {
    return { pending: all[0], threadId: all[0].threadId };
  }

  const blob = String(raw || '').toLowerCase();
  const matched = all.filter((p) => {
    const task = String(p.shortTask || p.rawTask || '').toLowerCase();
    return task.length >= 8 && blob.includes(task.slice(0, Math.min(24, task.length)));
  });
  if (matched.length === 1) {
    return { pending: matched[0], threadId: matched[0].threadId };
  }

  const lines = all.map((p, i) => `${i + 1}. ${describePending(p)}`);
  return {
    promptMultiple:
      `**CEO:** ${all.length} decisions pending — reply in the matching chat thread:\n` +
      `${lines.join('\n')}\n\n` +
      'Use **APPROVED**, **REVISION:** …, or **SKIP** (IT scan only).',
  };
}

async function sendTelegram(text) {
  const n = store.readSettings().notifications?.telegram;
  if (!n?.enabled || !n.botToken || !n.chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${n.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: n.chatId,
        text: String(text || '').slice(0, 3900),
        disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function refreshCooOfficeState(hint = '') {
  const coo = orgRoles.cooAgentOrFallback();
  if (!coo?.id) return;
  const pending = ceoPending.listAll();
  const running = cooRunTracker.isActive();

  if (running) {
    office.setAgent(coo.id, { awaitingBossInput: pending.length > 0 });
    return;
  }

  office.setAgent(coo.id, {
    npcState: 'resting',
    currentJob: null,
    awaitingBossInput: pending.length > 0,
    bubbleText:
      hint ||
      (pending.length
        ? `${pending.length} awaiting CEO`
        : ''),
  });
}

function releaseCooForParallelWork(hint = '') {
  refreshCooOfficeState(hint);
  try {
    require('./coo-autonomous-loop').scheduleAfterCooWork(4000);
  } catch {
    /* optional at boot */
  }
}

function notifyCeoDecisionRequired({
  threadId,
  phase,
  shortTask,
  rawTask,
  ownerKey,
  chatPreview,
} = {}) {
  const summary = describePending({ phase, shortTask, rawTask, instruction: rawTask });
  const taskLine = shortTask || rawTask || 'Office task';

  try {
    const bossChat = require('./boss-chat-store');
    if (threadId && ownerKey) {
      bossChat.setPinned(threadId, ownerKey, true);
    }
  } catch {
    /* optional */
  }

  try {
    require('./office-events').notifyCeoDecision({
      threadId: threadId || null,
      phase: phase || 'unknown',
      summary,
      at: Date.now(),
    });
  } catch {
    /* optional */
  }

  const telegramBody = [
    'AntlerOffice — CEO decision needed',
    '',
    summary,
    '',
    `Reply in Boss Chat (or your connected channel): APPROVED / REVISION: / SKIP`,
    chatPreview ? `\n${String(chatPreview).slice(0, 500)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  void sendTelegram(telegramBody);

  try {
    const workBoard = require('./work-board');
    workBoard.upsertCeoDecisionCard({ threadId, phase, shortTask, rawTask, ownerKey });
  } catch {
    /* optional */
  }

  releaseCooForParallelWork(`Awaiting CEO: ${taskLine.slice(0, 40)}`);
}

module.exports = {
  describePending,
  isCeoDecisionReply,
  matchPendingForReply,
  notifyCeoDecisionRequired,
  releaseCooForParallelWork,
  refreshCooOfficeState,
  sendTelegram,
};
