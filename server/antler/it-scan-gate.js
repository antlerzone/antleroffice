// IT scan → COO report → fix/skip/CEO gate before dev-pipeline.

const store = require('./store');
const registry = require('./registry-store');
const itSecurityScan = require('./runtime/it-security-scan');
const projectResolver = require('./runtime/dev-project-resolver');

function devSettings() {
  return store.readSettings().dev || {};
}

function instructionNeedsCeoGate(text) {
  return /\b(delete|remove all|drop table|force push|force-push|rm -rf|wipe|purge|destroy)\b/i.test(
    String(text || ''),
  );
}

function cooDecideScanAction(report, { instruction = '', autonomous = false } = {}) {
  if (report.skipped && !report.findings?.length) {
    return { action: 'proceed', reason: report.skipReason || 'Nothing to scan', escalateCeo: false };
  }
  if (!report.findings?.length) {
    return { action: 'proceed', reason: 'Clean scan — no issues', escalateCeo: false };
  }

  const critical = report.totals?.critical || 0;
  const high = report.totals?.high || 0;
  const destructive = instructionNeedsCeoGate(instruction);

  if (destructive || critical >= 1) {
    return {
      action: 'fix',
      reason: destructive
        ? 'Fix may involve destructive changes — CEO approval required'
        : `${critical} critical finding(s) — CEO approval before IT fix`,
      escalateCeo: true,
    };
  }

  if (high > 0 || (report.totals?.moderate || 0) > 0) {
    return {
      action: 'fix',
      reason: `${report.totals.total} finding(s) — COO recommends IT fix`,
      escalateCeo: false,
    };
  }

  if (autonomous) {
    return { action: 'fix', reason: 'Autonomous loop — patch low-severity issues', escalateCeo: false };
  }

  return {
    action: 'fix',
    reason: 'Low-severity findings — COO recommends optional fix',
    escalateCeo: false,
  };
}

async function resolveProjectRoot(projectRootIn, threadId) {
  if (projectRootIn) return { ok: true, projectRoot: projectRootIn };
  const ceoPending = require('./ceo-pipeline-pending');
  const pending = ceoPending.get(threadId);
  if (pending?.projectRoot) return { ok: true, projectRoot: pending.projectRoot };
  return projectResolver.resolveDevProjectRoot();
}

async function runItScanGate({
  projectRoot: projectRootIn,
  threadId,
  instruction = '',
  rawTask = '',
  shortTask = '',
  autonomous = false,
  agentLabel = 'IT',
} = {}) {
  const settings = devSettings();
  if (settings.scanBeforeItFix === false) {
    return { skipped: true, proceed: true, reason: 'scan disabled in settings' };
  }

  const resolved = await resolveProjectRoot(projectRootIn, threadId);
  if (!resolved.ok) {
    return { ok: false, needsProjectPath: true, resolver: resolved };
  }

  const report = await itSecurityScan.scanProject(resolved.projectRoot);
  const decision = cooDecideScanAction(report, { instruction: instruction || rawTask, autonomous });
  const markdown = itSecurityScan.formatScanMarkdown(report, decision);

  const deliverable = registry.addBossSummary({
    kind: 'it_scan',
    summary: `IT scan · ${report.totals?.total || 0} issue(s) · COO: ${decision.action}`,
    task: rawTask || instruction || shortTask || '',
    agentLabel,
    departmentLabel: 'IT Scan',
    status: decision.action === 'proceed' && !report.findings?.length ? 'complete' : 'pending',
    content: markdown,
    threadId,
  });

  return {
    ok: true,
    report,
    decision,
    markdown,
    deliverableId: deliverable.id,
    projectRoot: resolved.projectRoot,
    proceed:
      decision.action === 'proceed' ||
      (decision.action === 'fix' && !decision.escalateCeo),
    needsCeoGate: decision.action === 'fix' && decision.escalateCeo,
    skipFix: decision.action === 'skip_fix',
  };
}

function isItScanStep(step) {
  const text = `${step?.instruction || ''} ${step?.roleLabel || ''}`;
  return /\b(scan|audit|vulner|security|扫雷|漏洞|npm audit)\b/i.test(text);
}

module.exports = {
  runItScanGate,
  cooDecideScanAction,
  instructionNeedsCeoGate,
  isItScanStep,
};
