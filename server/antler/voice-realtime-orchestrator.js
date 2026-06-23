const { routeVoiceIntent } = require('./voice-intent-router');
const { fetchAllDepartmentsParallel } = require('./voice-department-data');
const { resolveReportPeriod } = require('./department-standup-service');
const standupConfig = require('./daily-standup-config-store');
const { callOpenAI, streamOpenAI } = require('./llm');
const ocGatewayChat = require('./runtime/openclaw-gateway-chat');
const voicePersona = require('./voice-persona');

const VOICE_MODEL = 'gpt-4o-mini';

function langHint(replyLanguage) {
  if (replyLanguage === 'zh') return 'Reply in Simplified Chinese. Short spoken sentences.';
  if (replyLanguage === 'en') return 'Reply in English. Short spoken sentences.';
  return 'Match the boss language. Short spoken sentences.';
}

function buildPersonaSystem({ personaEnabled, honorific, personaPrompt, replyLanguage }) {
  if (!personaEnabled) return langHint(replyLanguage);
  const base = voicePersona.buildJarvisPersonaSnippet(honorific || 'boss', personaPrompt, replyLanguage);
  return `${langHint(replyLanguage)}\n\n${base}`;
}

function emit(onEvent, payload) {
  if (typeof onEvent === 'function') onEvent(payload);
}

async function summarizeDepartmentForVoice({
  apiKey,
  label,
  periodLabel,
  contextText,
  replyLanguage,
  signal,
}) {
  const system =
    'You are a voice executive assistant. Compress department activity into 2–4 short sentences for spoken delivery. ' +
    'No bullet points, no greeting, facts only from the data. If no data, say briefly that nothing was recorded.';
  const prompt =
    `Department: ${label}\nPeriod: ${periodLabel}\n\n` +
    `${contextText || 'No Complete Job entries in this period.'}\n\nSpoken summary:`;
  return callOpenAI({
    apiKey,
    model: VOICE_MODEL,
    system: `${system}\n${langHint(replyLanguage)}`,
    prompt,
    maxTokens: 280,
    signal,
  });
}

async function runSummaryIntent({
  text,
  routed,
  apiKey,
  replyLanguage,
  honorific,
  onEvent,
  signal,
}) {
  const reportPeriod = resolveReportPeriod(routed.period || 'yesterday');
  const participants = standupConfig.enabledParticipants();
  if (!participants.length) {
    const msg =
      replyLanguage === 'zh'
        ? '目前没有可汇报的部门，请先在晨会设置里启用部门。'
        : 'No departments are enabled for reporting. Enable them in standup settings.';
    emit(onEvent, { type: 'speak', section: 'system', text: msg });
    return { ok: true, text: msg, intent: 'summary' };
  }

  emit(onEvent, {
    type: 'status',
    step: 'fetch',
    message: replyLanguage === 'zh' ? '正在并行查询各部门…' : 'Fetching departments in parallel…',
    departmentCount: participants.length,
  });

  const deptDataList = await fetchAllDepartmentsParallel(participants, reportPeriod);
  for (const dept of deptDataList) {
    emit(onEvent, {
      type: 'department_data',
      agentId: dept.agentId,
      label: dept.label,
      itemCount: dept.itemCount,
    });
  }

  const intro =
    replyLanguage === 'zh'
      ? `好的，${honorific || '老板'}。${reportPeriod.label}的工作汇报如下。`
      : `Right, ${honorific || 'boss'}. Here is the ${reportPeriod.label} update.`;
  emit(onEvent, { type: 'speak', section: 'intro', text: intro });

  const spokenParts = [intro];
  const summaryJobs = deptDataList.map((dept) =>
  (async () => {
    const spoken = await summarizeDepartmentForVoice({
      apiKey,
      label: dept.label,
      periodLabel: reportPeriod.label,
      contextText: dept.contextText,
      replyLanguage,
      signal,
    });
    const line = spoken.trim() || (replyLanguage === 'zh' ? `${dept.label}：本时段无记录。` : `${dept.label}: nothing recorded.`);
    emit(onEvent, {
      type: 'speak',
      section: 'department',
      label: dept.label,
      agentId: dept.agentId,
      text: line,
    });
    return { label: dept.label, text: line };
  })());

  const deptSummaries = await Promise.all(summaryJobs);
  spokenParts.push(...deptSummaries.map((d) => d.text));

  emit(onEvent, { type: 'status', step: 'executive', message: 'Wrapping up…' });

  const deptBlock = deptSummaries.map((d) => `${d.label}:\n${d.text}`).join('\n\n');
  const execSystem =
    'You are the COO giving a 2–3 sentence executive wrap-up for voice. Highlight wins, risks, and one priority. No bullets.';
  const execPrompt = `Period: ${reportPeriod.label}\nBoss asked: ${text}\n\nDepartment lines:\n${deptBlock}\n\nExecutive wrap-up:`;

  let execText = '';
  await streamOpenAI({
    apiKey,
    model: VOICE_MODEL,
    system: `${execSystem}\n${langHint(replyLanguage)}`,
    prompt: execPrompt,
    maxTokens: 200,
    signal,
    onDelta: (delta) => {
      execText += delta;
      emit(onEvent, { type: 'speak_delta', section: 'executive', delta });
    },
  });

  const fullText = [...spokenParts, execText.trim()].filter(Boolean).join('\n\n');
  return { ok: true, intent: 'summary', text: fullText, period: reportPeriod.key };
}

async function runQueryIntent({
  text,
  routed,
  apiKey,
  replyLanguage,
  personaEnabled,
  honorific,
  personaPrompt,
  onEvent,
  signal,
}) {
  const { buildOfficeContext } = require('./voice-realtime-service');
  const snapshot = await buildOfficeContext();
  const system = buildPersonaSystem({ personaEnabled, honorific, personaPrompt, replyLanguage });
  const prompt =
    `[Office snapshot — factual source, not a document search]\n${snapshot}\n\n` +
    `Boss question: ${routed.query || text}\n\nConcise spoken answer:`;

  emit(onEvent, { type: 'status', step: 'query', message: 'Answering…' });

  let full = '';
  await streamOpenAI({
    apiKey,
    model: VOICE_MODEL,
    system,
    prompt,
    maxTokens: 400,
    signal,
    onDelta: (delta) => {
      full += delta;
      emit(onEvent, { type: 'speak_delta', section: 'answer', delta });
    },
  });

  return { ok: true, intent: 'query', text: full.trim() };
}

async function runActionIntent({
  text,
  routed,
  replyLanguage,
  personaEnabled,
  honorific,
  personaPrompt,
  ownerKey,
  threadId,
  onEvent,
}) {
  emit(onEvent, {
    type: 'status',
    step: 'action',
    message: replyLanguage === 'zh' ? '正在执行…' : 'Running action…',
  });

  const system = buildPersonaSystem({ personaEnabled, honorific, personaPrompt, replyLanguage });
  const result = await ocGatewayChat.run({
    instruction: routed.instruction || text,
    system,
    agentId: 'main',
    threadId,
    ownerKey,
    timeoutMs: 120000,
  });

  if (!result.ok) {
    const err = result.error || 'Action failed';
    emit(onEvent, { type: 'error', error: err });
    return { ok: false, intent: 'action', error: err };
  }

  const reply = String(result.text || '').trim();
  if (reply) {
    emit(onEvent, { type: 'speak', section: 'action', text: reply });
  }
  return {
    ok: true,
    intent: 'action',
    text: reply,
    needsBossInput: result.needsBossInput,
    provider: result.provider,
  };
}

/**
 * Voice OS orchestrator — intent route → parallel data → stream speak events.
 * @param {function} onEvent - ({ type, ... }) => void
 */
async function runRealtimeTurn({
  text,
  ownerKey = 'local:boss',
  ownerName = 'Boss',
  threadId,
  replyLanguage = null,
  personaEnabled = true,
  honorific = 'boss',
  personaPrompt = '',
  apiKey,
  onEvent,
  signal,
} = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    emit(onEvent, { type: 'error', error: 'empty utterance' });
    return { ok: false, error: 'empty utterance' };
  }
  if (!apiKey) {
    emit(onEvent, { type: 'error', error: 'No OpenAI API key configured' });
    return { ok: false, error: 'No OpenAI API key configured' };
  }

  const routed = routeVoiceIntent(trimmed);
  emit(onEvent, { type: 'intent', ...routed });

  const lang =
    replyLanguage === 'zh' || replyLanguage === 'en'
      ? replyLanguage
      : /[\u4e00-\u9fff]/.test(trimmed)
        ? 'zh'
        : 'en';

  if (routed.intent === 'summary') {
    return runSummaryIntent({
      text: trimmed,
      routed,
      apiKey,
      replyLanguage: lang,
      honorific,
      onEvent,
      signal,
    });
  }

  if (routed.intent === 'action') {
    return runActionIntent({
      text: trimmed,
      routed,
      replyLanguage: lang,
      personaEnabled,
      honorific,
      personaPrompt,
      ownerKey,
      threadId,
      onEvent,
    });
  }

  return runQueryIntent({
    text: trimmed,
    routed,
    apiKey,
    replyLanguage: lang,
    personaEnabled,
    honorific,
    personaPrompt,
    onEvent,
    signal,
  });
}

module.exports = { runRealtimeTurn, routeVoiceIntent };
