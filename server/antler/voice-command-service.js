const voicePersona = require('./voice-persona');
const ocGatewayChat = require('./runtime/openclaw-gateway-chat');
const bossChat = require('./boss-chat-store');
const standupConfig = require('./daily-standup-config-store');
const departmentStandup = require('./department-standup-service');
const standupPdf = require('./standup-pdf-export');
const voiceListenerManager = require('./voice-listener-manager');
const {
  parseStandupPeriod,
  matchStandupIntent,
  matchStandupPdfIntent,
  classifyPlaybackIntent,
} = require('./standup-intent-utils');

const PERIOD_ACK_LABEL = {
  yesterday: '昨天',
  last_week: '上周',
  last_7_days: '近 7 日',
};

function periodAckLabel(period) {
  const key = period || standupConfig.getConfig().defaultPeriod || 'yesterday';
  return PERIOD_ACK_LABEL[key] || key;
}

async function tryStandupVoiceCommand({ text, ownerKey, threadId } = {}) {
  const intent = matchStandupIntent(text);
  if (!intent) return null;

  if (departmentStandup.getStatus().running) {
    return {
      ok: true,
      text: '晨会正在生成中，请稍候。完成后可在 Complete Job 查看。',
      action: 'standup_busy',
    };
  }

  const period = intent.period || standupConfig.getConfig().defaultPeriod || 'yesterday';
  const label = periodAckLabel(period);

  void departmentStandup
    .runStandup({
      period,
      ownerKey,
      threadId,
      trigger: 'voice',
      wait: false,
    })
    .catch(() => {});

  return {
    ok: true,
    text: `正在召集各部门汇报${label}工作情况，完成后会存入 Complete Job。`,
    action: 'standup_started',
    period,
  };
}

function tryStandupPdfCommand(text) {
  const intent = matchStandupPdfIntent(text);
  if (!intent) return null;
  return { ok: true, action: 'standup_export_pdf', async: true };
}

async function runStandupPdfExport({ deliverableId } = {}) {
  const out = await standupPdf.exportStandupPdf(deliverableId, { dest: 'desktop' });
  return {
    ok: true,
    action: 'standup_export_pdf',
    text: `已保存到桌面：${out.fileName}`,
    path: out.path,
    fileName: out.fileName,
    deliverableId: out.deliverableId,
  };
}

async function runStandupPlaybackCommand({
  text,
  deliverableId,
  sectionIndex = 0,
  ownerKey,
  interrupted = false,
} = {}) {
  const intent = classifyPlaybackIntent(text, interrupted);
  if (!intent) return { ok: false, error: 'empty command' };

  if (intent === 'stop') {
    voiceListenerManager.setStandupPlaybackState({ interrupted: true });
    return { ok: true, action: 'standup_stop', text: '已暂停。可以说更多详情，或说继续。' };
  }

  if (intent === 'continue') {
    const nextIndex = sectionIndex + 1;
    voiceListenerManager.setStandupPlaybackState({
      interrupted: false,
      sectionIndex: nextIndex,
    });
    return { ok: true, action: 'standup_continue', text: '继续。', sectionIndex: nextIndex };
  }

  try {
    const out = await departmentStandup.runStandupFollowUp({
      deliverableId,
      sectionIndex,
      userText: text,
      ownerKey,
    });
    voiceListenerManager.setStandupPlaybackState({ interrupted: true });
    return {
      ok: true,
      action: 'standup_follow_up',
      text: out.text,
      sectionIndex: out.sectionIndex,
      deliverableId: out.deliverableId,
    };
  } catch (e) {
    return { ok: false, action: 'standup_follow_up_failed', error: e.message };
  }
}

const LOCAL_SHORTCUTS = new Map([
  ['静音', { action: 'mute' }],
  ['停止播放', { action: 'stop_tts' }],
  ['停止', { action: 'stop_tts' }],
  ['打开设置', { action: 'open_settings' }],
  ['mute', { action: 'mute' }],
  ['stop', { action: 'stop_tts' }],
  ['open settings', { action: 'open_settings' }],
]);

function matchLocalShortcut(text) {
  const t = String(text || '').trim().toLowerCase();
  for (const [phrase, cmd] of LOCAL_SHORTCUTS) {
    if (t === phrase.toLowerCase() || t.startsWith(`${phrase.toLowerCase()} `)) {
      return cmd;
    }
  }
  return null;
}

function buildSystemPrompt({ personaEnabled, honorific, personaPrompt }) {
  if (!personaEnabled) return '';
  return voicePersona.buildJarvisPersonaSnippet(honorific || 'boss', personaPrompt);
}

async function runVoiceCommand({
  text,
  ownerKey = 'local:boss',
  ownerName = 'Boss',
  personaEnabled = true,
  honorific = 'boss',
  personaPrompt,
  threadId,
  agentId = 'main',
} = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: false, error: 'empty command' };

  const shortcut = matchLocalShortcut(trimmed);
  if (shortcut) {
    return { ok: true, local: true, action: shortcut.action, text: trimmed };
  }

  const pdf = tryStandupPdfCommand(trimmed);
  if (pdf?.async) {
    try {
      return await runStandupPdfExport({});
    } catch (e) {
      return { ok: false, error: e.message || 'PDF export failed', action: 'standup_export_pdf' };
    }
  }
  if (pdf) return pdf;

  const standup = await tryStandupVoiceCommand({ text: trimmed, ownerKey, threadId });
  if (standup) return standup;

  const cooAgentId = 'coo';
  const activeThreadId = bossChat.resolveThreadId(cooAgentId, threadId, ownerKey, ownerName);
  const system = buildSystemPrompt({ personaEnabled, honorific, personaPrompt });

  const result = await ocGatewayChat.run({
    instruction: trimmed,
    system,
    agentId: agentId || 'main',
    threadId: activeThreadId,
    ownerKey,
    timeoutMs: 180000,
  });

  if (!result.ok) {
    return { ok: false, error: result.error || 'COO command failed', available: result.available };
  }

  return {
    ok: true,
    text: result.text,
    provider: result.provider,
    threadId: activeThreadId,
    needsBossInput: result.needsBossInput,
  };
}

module.exports = {
  runVoiceCommand,
  matchLocalShortcut,
  buildSystemPrompt,
  matchStandupIntent,
  matchStandupPdfIntent,
  parseStandupPeriod,
  classifyPlaybackIntent,
  tryStandupVoiceCommand,
  tryStandupPdfCommand,
  runStandupPdfExport,
  runStandupPlaybackCommand,
};
