const debugLog = require('./debug-log');
const office = require('./office-state');
const orgRoles = require('./org-roles');
const registry = require('./registry-store');
const ceoPending = require('./ceo-pipeline-pending');
const heartbeatConfig = require('./coo-heartbeat-config-store');
const departmentStandup = require('./department-standup-service');
const companyFramework = require('./company-framework');
const cooCeoFuturePlan = require('./coo-ceo-future-plan');
const skillUpdateNotify = require('./coo-skill-update-notify');
const templateSync = require('./coo-template-sync');
const { runAsCoo } = require('./agent-runtime');

let activeRun = null;
let lastDiscovery = null;
let lastRunAt = null;

function describePending(pending) {
  const phase = String(pending?.phase || 'unknown');
  const task = pending?.shortTask || pending?.rawTask || pending?.instruction || 'pipeline task';
  if (phase === 'plan_approval') {
    return `Plan awaiting CEO approval: ${task}`;
  }
  if (phase === 'push_approval') {
    return `Dev branch awaiting CEO push approval: ${pending?.branchName || task}`;
  }
  if (phase === 'it_scan_ceo_gate') {
    return `IT security scan awaiting CEO fix approval: ${task}`;
  }
  if (phase === 'project_path') {
    return `Dev pipeline needs project path from CEO: ${task}`;
  }
  return `Pipeline gate (${phase}): ${task}`;
}

function discoverWork(config = heartbeatConfig.getConfig()) {
  const now = Date.now();
  const staleMs = Math.max(1, Number(config.staleJobHours) || 24) * 3600 * 1000;
  const items = [];

  const hbConfig = config;
  if (hbConfig.autonomousLoop && !companyFramework.isConfigured()) {
    items.push({
      priority: 0,
      kind: 'framework_missing',
      summary: 'Configure Company framework (Settings) — CEO sets product scope before COO runs',
      autoRunnable: false,
      needsCeo: true,
    });
  } else if (
    hbConfig.autonomousLoop &&
    companyFramework.isConfigured() &&
    !companyFramework.hasPendingFuturePlan()
  ) {
    items.push({
      priority: 0,
      kind: 'future_plan_empty',
      summary: 'Add CEO Future Plan items (Settings) — COO will not self-brainstorm new direction',
      autoRunnable: false,
      needsCeo: true,
    });
  }

  for (const pending of ceoPending.listAll()) {
    items.push({
      priority: 0,
      kind: 'pipeline_gate',
      threadId: pending.threadId,
      phase: pending.phase,
      summary: describePending(pending),
      autoRunnable: false,
      needsCeo: pending.phase === 'it_scan_ceo_gate' || pending.phase === 'push_approval' || pending.phase === 'plan_approval' || pending.phase === 'project_path',
    });
  }

  for (const d of registry.listDeliverables()) {
    if (d.kind === 'it_scan' && d.status === 'pending') {
      items.push({
        priority: 1,
        kind: 'it_scan',
        deliverableId: d.id,
        summary: d.summary || 'IT scan awaiting decision',
        autoRunnable: false,
        needsCeo: true,
      });
    }
  }

  for (const d of registry.listDeliverables()) {
    if (d.kind === 'alert') {
      items.push({
        priority: 1,
        kind: 'alert',
        deliverableId: d.id,
        summary: d.summary || d.task || 'Alert',
        autoRunnable: false,
        needsCeo: true,
      });
    }
  }

  for (const d of registry.listDeliverables()) {
    if (d.kind !== 'job') continue;
    if (d.status === 'in_progress') {
      const age = now - (d.createdAt || 0);
      if (age >= staleMs) {
        items.push({
          priority: 2,
          kind: 'stale_job',
          deliverableId: d.id,
          summary: d.summary || d.task || 'Stalled job',
          autoRunnable: !!config.autonomousLoop,
          instruction:
            `Heartbeat triage: continue stalled work.\n\n` +
            `Deliverable: ${d.summary || d.task || d.id}\n` +
            `Progress: ${d.progressPercent ?? '?'}%\n\n` +
            `Review status, unblock workers, and advance remaining plan steps.`,
        });
      }
    } else if (d.status === 'pending' && d.planSteps?.length) {
      items.push({
        priority: 3,
        kind: 'pending_job',
        deliverableId: d.id,
        summary: d.summary || d.task || 'Pending job',
        autoRunnable: !!config.autonomousLoop,
        instruction:
          `Heartbeat triage: start or resume delegated work.\n\n` +
          `Task: ${d.task || d.summary || d.id}\n\n` +
          `Execute the plan steps and update progress.`,
      });
    }
  }

  for (const d of registry.listDeliverables()) {
    if (d.kind === 'plan_complete' && d.status !== 'complete') {
      items.push({
        priority: 4,
        kind: 'plan_ready',
        deliverableId: d.id,
        summary: d.summary || d.task || 'Plan ready',
        autoRunnable: !!config.autonomousLoop,
        instruction:
          `Heartbeat triage: plan is ready — delegate execution to department workers.\n\n` +
          `Original task: ${d.task || d.summary || d.id}`,
      });
    }
  }

  items.sort((a, b) => a.priority - b.priority || String(a.summary).localeCompare(String(b.summary)));

  for (const planItem of cooCeoFuturePlan.discoverCeoFuturePlanItems(items, config)) {
    items.push(planItem);
  }

  lastDiscovery = {
    at: now,
    items,
    config: {
      autonomousLoop: config.autonomousLoop,
      idleBrainstorm: config.idleBrainstorm,
      staleJobHours: config.staleJobHours,
    },
  };
  return items;
}

function isCooBusy() {
  return require('./coo-run-tracker').isActive();
}

function buildTriageReport(items) {
  if (!items.length) {
    return 'COO heartbeat: no actionable items. Office is clear.';
  }
  const lines = ['COO heartbeat triage', ''];
  for (const item of items) {
    const tag = item.needsCeo ? 'CEO' : item.autoRunnable ? 'AUTO' : 'WATCH';
    lines.push(`- [${tag}] ${item.summary}`);
  }
  return lines.join('\n');
}

async function maybeRunAutonomousLoop(items, config) {
  if (!config.autonomousLoop) return { ran: false, reason: 'autonomous_loop_off' };
  if (!orgRoles.findHiredCoo()) return { ran: false, reason: 'coo_not_hired' };
  if (isCooBusy()) return { ran: false, reason: 'coo_busy' };
  if (departmentStandup.getStatus().running) return { ran: false, reason: 'standup_running' };

  const candidates = items.filter((i) => i.autoRunnable && i.instruction);
  if (!candidates.length) return { ran: false, reason: 'no_auto_items' };

  const maxRuns = Math.max(1, Number(config.maxAutoRunsPerTick) || 1);
  const picked = candidates.slice(0, maxRuns);
  const results = [];

  for (const item of picked) {
    const threadId = `heartbeat:${Date.now()}:${item.kind}`;
    debugLog.logInfo('coo-heartbeat', 'autonomous_run', item.kind, item.deliverableId || item.threadId || '');
    try {
      await runAsCoo({
        instruction: item.instruction,
        shortTask: item.summary?.slice(0, 80) || 'Heartbeat task',
        rawTask: item.summary || item.instruction,
        threadId,
        autonomous: true,
        trigger: 'heartbeat',
      });
      if (item.kind === 'ceo_future_plan' && item.futurePlanItem) {
        cooCeoFuturePlan.markFuturePlanItemCompleted(item.futurePlanItem);
      }
      results.push({ ok: true, kind: item.kind, threadId });
    } catch (e) {
      results.push({ ok: false, kind: item.kind, error: e.message || String(e) });
    }
  }

  return { ran: results.length > 0, results };
}

async function runHeartbeat({ trigger = 'manual', wait = true } = {}) {
  if (activeRun) {
    const err = new Error('COO heartbeat already running');
    err.code = 'busy';
    throw err;
  }

  const config = heartbeatConfig.getConfig();
  const runId = `coo-hb-${Date.now()}`;
  activeRun = { runId, trigger, startedAt: Date.now() };

  try {
    const items = discoverWork(config);
    const triageText = buildTriageReport(items);
    debugLog.logInfo('coo-heartbeat', 'discover', items.length, trigger);

    // Built-in skill update notices — COO tells the boss when a worker has a new
    // free skill it can learn. Best-effort: never let it break the heartbeat.
    let skillUpdates = { ok: false, posted: 0 };
    try {
      skillUpdates = await skillUpdateNotify.runSkillUpdateNotifications({ trigger });
    } catch (e) {
      debugLog.logInfo('coo-heartbeat', 'skill-update-error', e?.message || 'failed');
    }

    // Auto-sync in-service workers to their role's latest template (free, additive
    // openclaw workflows + devScope; never serverAccess). Best-effort.
    try {
      await templateSync.runTemplateSync({ trigger });
    } catch (e) {
      debugLog.logInfo('coo-heartbeat', 'template-sync-error', e?.message || 'failed');
    }

    let autonomous = { ran: false, reason: 'skipped' };
    const loopTriggers = new Set(['loop', 'interval', 'after_coo', 'boot', 'manual']);
    const shouldAutonomous =
      config.autonomousLoop &&
      (loopTriggers.has(trigger) || config.enabled);
    if (shouldAutonomous) {
      autonomous = await maybeRunAutonomousLoop(items, config);
    }

    lastRunAt = Date.now();
    return {
      ok: true,
      runId,
      trigger,
      itemCount: items.length,
      items,
      triageText,
      autonomous,
      skillUpdates,
    };
  } finally {
    activeRun = null;
  }
}

function getStatus() {
  return {
    running: !!activeRun,
    runId: activeRun?.runId || null,
    trigger: activeRun?.trigger || null,
    lastRunAt,
    lastDiscovery,
    config: heartbeatConfig.getConfig(),
    cooBusy: isCooBusy(),
    cooHired: !!orgRoles.findHiredCoo(),
  };
}

module.exports = {
  discoverWork,
  runHeartbeat,
  getStatus,
  buildTriageReport,
};
