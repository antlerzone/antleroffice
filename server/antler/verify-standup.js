#!/usr/bin/env node
/**
 * Standup feature verification — intent matching, period resolution, deliverable context, PDF.
 * Usage: node server/antler/verify-standup.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const results = [];

function pass(name, detail) {
  results.push({ name, ok: true, detail });
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail) {
  results.push({ name, ok: false, detail });
  console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

function assert(name, cond, detail) {
  if (cond) pass(name, detail);
  else fail(name, detail);
}

async function main() {
  const intents = require('./standup-intent-utils');
  const { resolveReportPeriod } = require('./department-standup-service');
  const { matchesParticipant } = require('./standup-deliverable-context');
  const standupPdf = require('./standup-pdf-export');
  const store = require('./store');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-verify-'));
  store.setDataDir(tmpDir);

  // Intent matching
  assert(
    'matchStandupIntent last week',
    intents.matchStandupIntent('叫所有部门开会汇报上周')?.period === 'last_week',
    'last_week',
  );
  assert(
    'matchStandupIntent yesterday',
    intents.matchStandupIntent('让所有部门汇报昨天')?.period === 'yesterday',
    'yesterday',
  );
  assert(
    'matchStandupPdfIntent',
    intents.matchStandupPdfIntent('把刚刚的汇报生成 PDF 放到桌面')?.action === 'standup_export_pdf',
    'export',
  );
  assert('classifyPlaybackIntent stop', intents.classifyPlaybackIntent('等等') === 'stop', 'stop');
  assert(
    'classifyPlaybackIntent continue',
    intents.classifyPlaybackIntent('继续') === 'continue',
    'continue',
  );
  assert(
    'no standup intent on chit-chat',
    !intents.matchStandupIntent('今天天气怎么样'),
    'null',
  );

  // Period resolution
  const yesterday = resolveReportPeriod('yesterday');
  assert('resolveReportPeriod yesterday', yesterday.key === 'yesterday' && yesterday.from < yesterday.to, yesterday.label);
  const lastWeek = resolveReportPeriod('last_week');
  assert('resolveReportPeriod last_week', lastWeek.key === 'last_week', lastWeek.label);

  // Deliverable participant match
  assert(
    'matchesParticipant by role',
    matchesParticipant({ department: 'marketing', agentId: 'x' }, { role: 'marketing' }),
    'role',
  );
  assert(
    'matchesParticipant by agentId',
    matchesParticipant({ agentId: 'user:abc' }, { agentId: 'user:abc' }),
    'agentId',
  );

  // PDF export
  const registry = require('./registry-store');
  const item = registry.addBossSummary({
    kind: 'daily_report',
    summary: 'Test standup',
    standupSections: [
      { label: 'Marketing', text: 'Shipped campaign A.', role: 'marketing' },
      { label: 'COO', text: 'All good.', role: 'coo' },
    ],
    reportPeriod: { from: Date.now() - 86400000, to: Date.now(), label: 'Yesterday' },
  });
  const outDir = path.join(tmpDir, 'materials', 'reports');
  const pdf = await standupPdf.exportStandupPdf(item.id, { dest: 'materials' });
  assert('exportStandupPdf creates file', fs.existsSync(pdf.path), pdf.fileName);
  assert('exportStandupPdf non-empty', fs.statSync(pdf.path).size > 100, `${fs.statSync(pdf.path).size} bytes`);
  assert('exportStandupPdf under materials', pdf.path.includes('reports'), pdf.path);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
