const office = require('./office-state');
const registry = require('./registry-store');
const standupConfig = require('./daily-standup-config-store');
const { deliverablesContextForParticipant } = require('./standup-deliverable-context');
const bossChat = require('./boss-chat-store');
const { runStandupAgentTurn, runStandupCeoSummary } = require('./agent-runtime');
const orgRoles = require('./org-roles');

const STANDUP_PERIODS = new Set(['yesterday', 'last_week', 'last_7_days']);

let activeRun = null;

function startOfLocalDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function formatLocalDate(ts) {
  try {
    return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

function resolveReportPeriod(period) {
  const key = STANDUP_PERIODS.has(period) ? period : 'yesterday';
  const now = new Date();
  const todayStart = startOfLocalDay(now);

  if (key === 'yesterday') {
    const from = new Date(todayStart);
    from.setDate(from.getDate() - 1);
    const to = new Date(todayStart);
    to.setMilliseconds(-1);
    return { from: from.getTime(), to: to.getTime(), label: 'Yesterday', key };
  }

  if (key === 'last_7_days') {
    const from = startOfLocalDay(now);
    from.setDate(from.getDate() - 6);
    return { from: from.getTime(), to: now.getTime(), label: 'Last 7 days', key };
  }

  const day = todayStart.getDay();
  const daysFromMonday = (day + 6) % 7;
  const thisMonday = new Date(todayStart);
  thisMonday.setDate(thisMonday.getDate() - daysFromMonday);
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(lastMonday.getDate() - 7);
  const lastSundayEnd = new Date(thisMonday);
  lastSundayEnd.setMilliseconds(-1);
  return {
    from: lastMonday.getTime(),
    to: lastSundayEnd.getTime(),
    label: 'Last week',
    key: 'last_week',
  };
}

function buildStandupMarkdown({ reportPeriod, sections, cooSummary }) {
  const lines = [
    `# Department standup — ${reportPeriod.label}`,
    '',
    `Period: ${formatLocalDate(reportPeriod.from)} – ${formatLocalDate(reportPeriod.to)}`,
    '',
  ];
  for (const s of sections) {
    lines.push(`## ${s.label}`, '', s.text, '');
  }
  lines.push('## COO summary', '', cooSummary);
  return lines.join('\n');
}

function getStatus() {
  if (!activeRun) return { running: false };
  return {
    running: true,
    runId: activeRun.runId,
    period: activeRun.period,
    trigger: activeRun.trigger,
    startedAt: activeRun.startedAt,
    currentDepartment: activeRun.currentDepartment || null,
    completedDepartments: activeRun.completedDepartments || 0,
    totalDepartments: activeRun.totalDepartments || 0,
  };
}

async function runStandup({
  period,
  participantIds,
  ownerKey = null,
  threadId = null,
  trigger = 'manual',
  wait = false,
} = {}) {
  if (activeRun) {
    const err = new Error('A standup is already running');
    err.code = 'STANDUP_BUSY';
    throw err;
  }

  const reportPeriod = resolveReportPeriod(period || standupConfig.getConfig().defaultPeriod);
  const participants = standupConfig.enabledParticipants(participantIds);
  if (!participants.length) {
    const err = new Error('No enabled departments for standup');
    err.code = 'NO_PARTICIPANTS';
    throw err;
  }

  const runId = `standup-${Date.now().toString(36)}`;
  const job = async () => {
    activeRun = {
      runId,
      period: reportPeriod.key,
      trigger,
      startedAt: Date.now(),
      totalDepartments: participants.length,
      completedDepartments: 0,
      currentDepartment: null,
    };

    const config = standupConfig.getConfig();
    const templateVars = {
      periodLabel: reportPeriod.label,
      fromDate: formatLocalDate(reportPeriod.from),
      toDate: formatLocalDate(reportPeriod.to),
    };

    const sections = [];
    try {
      for (const participant of participants) {
        const agent = office.getAgent(participant.agentId);
        if (!agent) continue;

        activeRun.currentDepartment = participant.label;
        const deptVars = {
          ...templateVars,
          departmentLabel: participant.label,
        };
        const instruction = standupConfig.applyTemplate(config.prompts.department, deptVars);
        const deliverableBlock = deliverablesContextForParticipant(participant, reportPeriod);
        const fullInstruction = deliverableBlock
          ? `${instruction}\n\n---\n\n${deliverableBlock}`
          : instruction;

        const { text } = await runStandupAgentTurn({
          agent,
          instruction: fullInstruction,
          ownerKey,
          threadId,
        });

        sections.push({
          agentId: participant.agentId,
          role: participant.role,
          label: participant.label,
          text: String(text || '').trim() || '(No report generated)',
          voice: participant.voice || null,
        });
        activeRun.completedDepartments += 1;
      }

      activeRun.currentDepartment = 'COO summary';
      const deptBlock = sections
        .map((s) => `### ${s.label}\n${s.text}`)
        .join('\n\n');
      const cooInstruction =
        standupConfig.applyTemplate(config.prompts.cooSummary || config.prompts.ceoSummary, templateVars) +
        `\n\n---\n\nDepartment reports:\n\n${deptBlock}`;

      const { text: cooSummaryText } = await runStandupCeoSummary({
        instruction: cooInstruction,
        ownerKey,
        threadId,
      });

      const coo = orgRoles.cooAgentOrFallback();
      const sec = orgRoles.findSecretary();
      const hostIntro =
        `Good morning. This is ${sec?.label || 'your Secretary'}. ` +
        `Here is the ${reportPeriod.label} standup with ${sections.length} department report(s).`;

      const markdown = buildStandupMarkdown({
        reportPeriod,
        sections,
        cooSummary: String(cooSummaryText || '').trim() || '(No summary generated)',
      });

      const standupSections = [
        {
          agentId: sec?.id || 'secretary',
          role: 'secretary',
          label: sec?.label || 'Secretary',
          text: hostIntro,
          voice: config.hostVoice || null,
        },
        ...sections,
        {
          agentId: coo?.id || 'coo',
          role: 'coo',
          label: coo?.label || 'COO',
          text: String(cooSummaryText || '').trim() || '(No summary generated)',
          voice: config.ceoVoice || null,
        },
      ];

      const kind = reportPeriod.key === 'last_week' ? 'daily_report' : 'daily_report';
      const deliverable = registry.addBossSummary({
        kind,
        summary: `${reportPeriod.label} standup — ${sections.length} departments`,
        task: `Department standup (${reportPeriod.label})`,
        agentId: coo?.id || null,
        agentLabel: coo?.label || 'COO',
        department: 'multi',
        departmentLabel: 'Multi-department',
        content: markdown,
        standupSections,
        reportPeriod: {
          from: reportPeriod.from,
          to: reportPeriod.to,
          label: reportPeriod.label,
        },
      });

      const result = { ok: true, runId, deliverable, reportPeriod };
      activeRun.result = result;
      return result;
    } catch (err) {
      activeRun.error = err.message || String(err);
      throw err;
    } finally {
      const done = activeRun;
      activeRun = null;
      if (done?.error) {
        office.addChat('system', `Standup failed: ${done.error}`, threadId);
      } else if (done?.result?.deliverable) {
        office.addChat(
          'system',
          `Standup saved to Complete Job — ${done.result.deliverable.summary || reportPeriod.label}.`,
          threadId,
        );
        try {
          const voiceListenerManager = require('./voice-listener-manager');
          voiceListenerManager.publishListenerEvent({
            type: 'standup_complete',
            deliverableId: done.result.deliverable.id,
            summary: done.result.deliverable.summary,
            trigger: done.trigger,
            at: Date.now(),
          });
        } catch {
          /* optional SSE */
        }
      }
    }
  };

  if (wait) {
    return job();
  }

  const promise = job();
  promise.catch(() => {});
  return { ok: true, runId, status: 'started', period: reportPeriod.key };
}

async function runStandupFollowUp({
  deliverableId,
  sectionIndex = 0,
  userText,
  ownerKey = null,
  ownerName = 'Boss',
  threadId = null,
} = {}) {
  const question = String(userText || '').trim();
  if (!question) {
    const err = new Error('Follow-up question is required');
    err.code = 'EMPTY_QUESTION';
    throw err;
  }

  const deliverable = registry.getDeliverable(deliverableId);
  if (!deliverable) {
    const err = new Error('Standup deliverable not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const sections = [...(deliverable.standupSections || [])];
  const index = Number(sectionIndex);
  const section = sections[index];
  if (!section) {
    const err = new Error('Standup section not found');
    err.code = 'SECTION_NOT_FOUND';
    throw err;
  }

  const agent =
    (section.agentId && office.getAgent(section.agentId)) ||
    (section.role && office.getAgent(section.role)) ||
    orgRoles.findSecretary();

  if (!agent) {
    const err = new Error('Agent for section not found');
    err.code = 'NO_AGENT';
    throw err;
  }

  const instruction =
    `The boss is listening to a department standup playback and asked a follow-up.\n\n` +
    `Department: ${section.label}\n\nOriginal report:\n${section.text}\n\n` +
    `Boss follow-up: ${question}\n\n` +
    `Reply concisely for spoken delivery. Address the boss directly.`;

  const { text } = await runStandupAgentTurn({
    agent,
    instruction,
    ownerKey,
    threadId,
  });

  const answer = String(text || '').trim() || '(No response generated)';
  const followUps = [
    ...(Array.isArray(section.followUps) ? section.followUps : []),
    { text: question, answer, at: Date.now() },
  ];
  sections[index] = { ...section, followUps };

  registry.updateDeliverableProgress(deliverableId, { standupSections: sections });

  const chatAgentId = agent.id || agent.role || section.role || 'secretary';
  try {
    const chatThreadId = bossChat.resolveThreadId(chatAgentId, threadId, ownerKey, ownerName);
    if (chatThreadId) {
      bossChat.addMessage(chatThreadId, 'boss', question, { authorName: ownerName || 'Boss' });
      bossChat.addMessage(chatThreadId, chatAgentId, answer, { authorName: section.label || agent.label });
    }
  } catch {
    /* Boss Chat archive is best-effort */
  }

  return {
    ok: true,
    text: answer,
    sectionIndex: index,
    deliverableId,
    section: sections[index],
  };
}

module.exports = {
  runStandup,
  runStandupFollowUp,
  getStatus,
  resolveReportPeriod,
  STANDUP_PERIODS,
};
