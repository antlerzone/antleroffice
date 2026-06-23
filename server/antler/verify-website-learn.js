/**
 * Smoke test for Website Learning Mode (no Chrome required for most checks).
 * Run: node server/antler/verify-website-learn.js
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = path.join(__dirname, '../..');
const antler = __dirname;

process.env.ANTLEROFFICE_DATA_DIR = path.join(os.tmpdir(), `antler-learn-verify-${Date.now()}`);

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log('PASS', msg);
  } else {
    failed += 1;
    console.error('FAIL', msg);
  }
}

// 1. MCP tools registered
const mcpSrc = fs.readFileSync(path.join(antler, 'antleroffice-mcp.js'), 'utf8');
const toolNames = [...mcpSrc.matchAll(/name: '(website_learn_[^']+)'/g)].map((m) => m[1]);
assert(toolNames.length === 8, `MCP has 8 website_learn tools (got ${toolNames.length}: ${toolNames.join(', ')})`);
for (const t of [
  'website_learn_start',
  'website_learn_poll',
  'website_learn_export',
  'website_learn_simulate_once',
  'website_learn_batch_run',
]) {
  assert(toolNames.includes(t), `MCP includes ${t}`);
}

// 2. Intake classification
const intake = require('./website-learn-intake');
const engine = require('./website-learn-engine');
assert(intake.classifyWebsiteLearnMessage('进入学习模式 workflow invoice-download') === 'learn_start', 'learn_start intent');
engine.setPendingIntake({ workflow_name: 'wf', waitingForProfile: true });
assert(intake.classifyWebsiteLearnMessage('2') === 'profile_choice', 'profile_choice when pending');
engine.clearPendingIntake();
assert(intake.extractWorkflowName('workflow invoice-download') === 'invoice-download', 'extract workflow name');

// 3. Export artifacts
const wf = 'export-test';
const wfDir = path.join(process.env.ANTLEROFFICE_DATA_DIR, 'website-learn', wf);
fs.mkdirSync(path.join(wfDir, 'screenshots'), { recursive: true });
const events = [
  { seq: 1, type: 'navigate', url: 'https://example.com/login' },
  {
    seq: 2,
    type: 'input',
    variable: 'username',
    variable_type: 'text',
    value_redacted: 'john123',
    element: { label: 'Username', id: 'user' },
  },
  {
    seq: 3,
    type: 'input',
    variable: 'password',
    variable_type: 'secret',
    value_redacted: '${PASSWORD}',
    element: { label: 'Password', id: 'pass' },
  },
];
fs.writeFileSync(path.join(wfDir, 'action_trace.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);

(async () => {
  const exported = await engine.exportWorkflow({ workflow_name: wf });
  assert(exported.ok, 'exportWorkflow ok');
  const required = [
    'workflow_summary.md',
    'input_mapping.json',
    'selectors.json',
    'playwright.ts',
    'batch_runner.ts',
    'env.template',
  ];
  for (const f of required) {
    assert(fs.existsSync(path.join(wfDir, f)), `artifact ${f} exists`);
  }
  const mapping = JSON.parse(fs.readFileSync(path.join(wfDir, 'input_mapping.json'), 'utf8'));
  assert(mapping.variables.some((v) => v.name === 'username'), 'mapping has username');
  assert(mapping.variables.some((v) => v.name === 'password' && v.type === 'secret'), 'mapping has password secret');

  // 4. CSV batch parse (file not found path)
  try {
    await engine.batchRun({ workflow_name: wf, excel_path: '/nonexistent.csv' });
    assert(false, 'batchRun should throw on missing file');
  } catch (e) {
    assert(/ENOENT|no such file|cannot find/i.test(e.message), 'batchRun rejects missing csv');
  }

  // 5. org-roles IT Junior
  const org = require('./org-roles');
  assert(typeof org.findItJunior === 'function', 'findItJunior exported');
  assert(org.IT_JUNIOR_ROLE === 'it_junior', 'IT_JUNIOR_ROLE constant');

  // 6. Antlermarket bundle
  const bundles = require(path.join(root, '..', 'server', 'src', 'bundles'));
  const b = bundles.loadAgentBundle('it_junior');
  assert(b.manifest?.skillIds?.length === 3, 'bundle has 3 skills');

  console.log('\n---');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
