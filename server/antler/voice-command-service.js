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

function normalizeVoiceCommand(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[,.!?；，。！？]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchStartWorkIntent(text) {
  const t = normalizeVoiceCommand(text);
  if (!t) return false;
  const exact = new Set([
    'start work',
    'start working',
    'begin work',
    '开始工作',
    '开始上班',
    '开始干活',
    'good morning jarvis start work now',
    'good morning jarvis',
    'jarvis start work',
    'jarvis start work now',
    'hey jarvis start work',
    '贾维斯开始工作',
    'jarvis 开始工作',
  ]);
  if (exact.has(t)) return true;
  return (
    /^good morning jarvis\b/.test(t) ||
    /^(hey |ok )?jarvis[,. ]+(start work|start working|begin work)/.test(t) ||
    /^(贾维斯|jarvis)[,. ]*(开始工作|开始上班)/.test(t)
  );
}

function startWorkAckText(honorific = 'boss', lang = 'en') {
  const h = String(honorific || 'boss').trim() || 'boss';
  if (lang === 'zh') {
    return `好的，${h}。COO 已开始巡检待办，有进展会向您汇报。`;
  }
  return `Right away, ${h}. COO is scanning your queue — I'll report back with progress.`;
}

function detectCommandLang(text) {
  return /[\u4e00-\u9fff]/.test(String(text || '')) ? 'zh' : 'en';
}

function tryStartWorkCommand(text, honorific = 'boss') {
  if (!matchStartWorkIntent(text)) return null;
  const lang = detectCommandLang(text);
  return {
    ok: true,
    local: true,
    action: 'start_work',
    text: startWorkAckText(honorific, lang),
  };
}

function matchLocalShortcut(text) {
  const t = String(text || '').trim().toLowerCase();
  for (const [phrase, cmd] of LOCAL_SHORTCUTS) {
    if (t === phrase.toLowerCase() || t.startsWith(`${phrase.toLowerCase()} `)) {
      return cmd;
    }
  }
  return null;
}

function buildSystemPrompt({ personaEnabled, honorific, personaPrompt, replyLanguage }) {
  const langHintZh = '必须用简体中文回复。句子要短，适合朗读。';
  const langHintEn = 'Always reply in English. Keep sentences short and spoken-aloud friendly.';
  if (!personaEnabled) {
    if (replyLanguage === 'zh') return langHintZh;
    if (replyLanguage === 'en') return langHintEn;
    return '';
  }
  const base = voicePersona.buildJarvisPersonaSnippet(honorific || 'boss', personaPrompt, replyLanguage);
  if (replyLanguage === 'zh') return `${langHintZh}\n\n${base}`;
  if (replyLanguage === 'en') return `${langHintEn}\n\n${base}`;
  return base;
}

async function runVoiceCommand({
  text,
  ownerKey = 'local:boss',
  ownerName = 'Boss',
  personaEnabled = true,
  honorific = 'boss',
  personaPrompt,
  replyLanguage,
  threadId,
  agentId = 'main',
} = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: false, error: 'empty command' };

  const shortcut = matchLocalShortcut(trimmed);
  if (shortcut) {
    return { ok: true, local: true, action: shortcut.action, text: trimmed };
  }

  const startWork = tryStartWorkCommand(trimmed, honorific);
  if (startWork) return startWork;

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

  const secretaryAgentId = 'secretary';
  const activeThreadId = bossChat.resolveThreadId(secretaryAgentId, threadId, ownerKey, ownerName);
  const system = buildSystemPrompt({ personaEnabled, honorific, personaPrompt, replyLanguage });

  const result = await ocGatewayChat.run({
    instruction: trimmed,
    system,
    agentId: agentId || 'main',
    threadId: activeThreadId,
    ownerKey,
    timeoutMs: 180000,
  });

  if (!result.ok) {
    return { ok: false, error: result.error || 'Voice command failed', available: result.available };
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
  matchStartWorkIntent,
  tryStartWorkCommand,
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
