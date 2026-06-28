/**
 * Website Learning Mode — observe recording, export, simulate, batch.
 * Session storage: ~/.antleroffice2/website-learn/{workflow_name}/
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const store = require('./store');
let webAccounts = null;
try {
  webAccounts = require('./web-accounts-store');
} catch {
  webAccounts = null;
}
// Variable names that represent the login username/email field.
const LOGIN_USER_VARS = new Set(['account_email', 'username', 'email', 'login', 'user']);

// Browser driver via stealth-browser: Patchright if installed, else Playwright.
const { chromium } = require('./stealth-browser');
const selectorHeal = require('./selector-heal');

const _sessions = new Map();
const _pendingIntakeFile = () => path.join(engineRoot(), 'pending-intake.json');

const RECORDER_INIT = () => {
  if (window.__antlerLearnInstalled) return;
  window.__antlerLearnInstalled = true;
  window.__antlerLearnQueue = window.__antlerLearnQueue || [];
  const push = (evt) => {
    try {
      window.__antlerLearnQueue.push({ ...evt, ts: Date.now() });
      if (window.__antlerLearnQueue.length > 5000) window.__antlerLearnQueue.shift();
    } catch {
      /* */
    }
  };
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      if (!t || t.closest?.('[data-antler-learn-ignore]')) return;
      const label =
        t.labels?.[0]?.innerText?.trim() ||
        t.getAttribute('aria-label') ||
        t.getAttribute('placeholder') ||
        '';
      push({
        type: 'click',
        x: e.clientX,
        y: e.clientY,
        button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left',
        tag: (t.tagName || '').toLowerCase(),
        id: t.id || '',
        name: t.name || '',
        inputType: t.type || '',
        label: label.slice(0, 120),
        text: (t.innerText || t.textContent || '').trim().slice(0, 80),
        role: t.getAttribute('role') || '',
        value: t.type === 'password' ? '${PASSWORD}' : (t.value || '').slice(0, 200),
      });
    },
    true,
  );
  document.addEventListener(
    'input',
    (e) => {
      const t = e.target;
      if (!t || !('value' in t)) return;
      const isSecret = t.type === 'password' || /password|passwd|pwd/i.test(t.name || t.id || '');
      push({
        type: 'input',
        tag: (t.tagName || '').toLowerCase(),
        id: t.id || '',
        name: t.name || '',
        inputType: t.type || '',
        label:
          t.labels?.[0]?.innerText?.trim() ||
          t.getAttribute('aria-label') ||
          t.getAttribute('placeholder') ||
          '',
        value_redacted: isSecret ? '${PASSWORD}' : String(t.value || '').slice(0, 200),
      });
    },
    true,
  );
  document.addEventListener(
    'change',
    (e) => {
      const t = e.target;
      if (!t) return;
      if (t.tagName === 'SELECT') {
        push({
          type: 'select',
          id: t.id || '',
          name: t.name || '',
          value: String(t.value || '').slice(0, 200),
        });
      }
      if (t.type === 'checkbox' || t.type === 'radio') {
        push({
          type: t.type,
          id: t.id || '',
          name: t.name || '',
          checked: !!t.checked,
          label: t.labels?.[0]?.innerText?.trim() || '',
        });
      }
    },
    true,
  );
  let lastMove = 0;
  document.addEventListener('mousemove', (e) => {
    const now = Date.now();
    if (now - lastMove < 200) return;
    lastMove = now;
    push({ type: 'mousemove', x: e.clientX, y: e.clientY });
  });
};

function engineRoot() {
  const root = path.join(store.getDataDir(), 'website-learn');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, 'profiles'), { recursive: true });
  return root;
}

function safeWorkflowName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 64) || 'workflow';
}

function workflowDir(workflowName) {
  return path.join(engineRoot(), safeWorkflowName(workflowName));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

function ensurePlaywright() {
  if (!chromium) {
    throw new Error(
      'Playwright not installed. Run: cd AntlerOffice2 && npm install && npx playwright install chrome',
    );
  }
}

function resolveProfileDir({ workflow_name, profile_mode, profile_label }) {
  const wf = safeWorkflowName(workflow_name);
  if (profile_mode === 'ephemeral') {
    return path.join(engineRoot(), '.tmp', `${wf}-${randomUUID()}`, 'chrome');
  }
  if (profile_mode === 'workflow') {
    return path.join(workflowDir(wf), 'profile', 'chrome');
  }
  const label = safeWorkflowName(profile_label || wf);
  return path.join(engineRoot(), 'profiles', label, 'chrome');
}

function inferVariableName(label, name, id, inputType, value) {
  const blob = `${label} ${name} ${id}`.toLowerCase();
  if (inputType === 'password' || /password|passwd|pwd/.test(blob)) return { name: 'password', type: 'secret' };
  if (inputType === 'email' || /email|e-mail/.test(blob)) return { name: 'account_email', type: 'text' };
  if (/date/.test(blob) || /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return { name: 'query_date', type: 'date' };
  if (/invoice/.test(blob)) return { name: 'invoice_no', type: 'text' };
  if (/customer.*code|cust.*code/.test(blob)) return { name: 'customer_code', type: 'text' };
  if (/user(name)?/.test(blob)) return { name: 'username', type: 'text' };
  if (/track(ing)?/.test(blob)) return { name: 'tracking_no', type: 'text' };
  if (/order/.test(blob)) return { name: 'order_no', type: 'text' };
  const slug = safeWorkflowName(name || id || label || 'field').replace(/-/g, '_');
  return { name: slug || 'field', type: 'text' };
}

function isBatchVariable(varName) {
  return /(_no|_code|_id|^email$|tracking)/i.test(varName);
}

async function injectRecorder(page) {
  await page.addInitScript(RECORDER_INIT);
  try {
    await page.evaluate(RECORDER_INIT);
  } catch {
    /* cross-origin */
  }
}

async function drainDomEvents(session) {
  const { page, session_id } = session;
  let batch = [];
  try {
    batch = await page.evaluate(() => {
      const q = window.__antlerLearnQueue || [];
      window.__antlerLearnQueue = [];
      return q;
    });
  } catch {
    return [];
  }
  const viewport = page.viewportSize() || { width: 1920, height: 1080 };
  const out = [];
  for (const raw of batch) {
    session.seq += 1;
    const evt = {
      seq: session.seq,
      timestamp: new Date(raw.ts || Date.now()).toISOString(),
      url: page.url(),
      type: raw.type,
    };
    if (raw.x != null) {
      evt.mouse = {
        x: raw.x,
        y: raw.y,
        button: raw.button || 'left',
        viewport,
      };
    }
    if (raw.type === 'input' || raw.type === 'select') {
      const inferred = inferVariableName(raw.label, raw.name, raw.id, raw.inputType, raw.value_redacted);
      evt.variable = inferred.name;
      evt.variable_type = inferred.type;
      evt.value_redacted = raw.value_redacted || raw.value || '';
      evt.element = { id: raw.id, name: raw.name, label: raw.label };
    }
    if (raw.type === 'click') {
      evt.element = {
        id: raw.id,
        name: raw.name,
        tag: raw.tag,
        label: raw.label,
        text: raw.text || '',
        role: raw.role || '',
      };
    }
    appendJsonl(session.tracePath, evt);
    session.events.push(evt);
    out.push(evt);
  }
  return out;
}

async function takeScreenshot(session, prefix, slug) {
  const step = String(session.shotStep++).padStart(3, '0');
  const name = `${step}_${prefix}_${safeWorkflowName(slug || 'page')}.png`;
  const rel = path.join('screenshots', name);
  const abs = path.join(session.workflowPath, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  try {
    await session.page.screenshot({ path: abs, fullPage: true });
    return rel.replace(/\\/g, '/');
  } catch {
    return null;
  }
}

async function discoverCheckboxGroups(page) {
  try {
    return await page.evaluate(() => {
      const groups = [];
      const seen = new Set();
      const fieldsets = document.querySelectorAll('fieldset');
      fieldsets.forEach((fs) => {
        const boxes = [...fs.querySelectorAll('input[type=checkbox]')];
        if (boxes.length < 2) return;
        const key = boxes.map((b) => b.name).join('|');
        if (seen.has(key)) return;
        seen.add(key);
        const legend = fs.querySelector('legend')?.innerText?.trim() || 'Checkbox group';
        groups.push({
          panel_label: legend,
          options: boxes.map((b) => ({
            label: b.labels?.[0]?.innerText?.trim() || b.value || b.id || 'option',
            value: b.value || b.id || '',
            selectors: b.id ? [`#${CSS.escape(b.id)}`] : [`input[name="${b.name}"][value="${b.value}"]`],
          })),
        });
      });
      const all = [...document.querySelectorAll('input[type=checkbox]')];
      const byName = new Map();
      all.forEach((b) => {
        const n = b.name || b.closest('[class*="panel"], [class*="group"], section')?.querySelector('h2,h3,label')?.innerText?.trim() || 'facilities';
        if (!byName.has(n)) byName.set(n, []);
        byName.get(n).push(b);
      });
      byName.forEach((boxes, panelKey) => {
        if (boxes.length < 2) return;
        const key = boxes.map((b) => b.name + b.value).join('|');
        if (seen.has(key)) return;
        seen.add(key);
        groups.push({
          panel_label: panelKey,
          options: boxes.map((b) => ({
            label: b.labels?.[0]?.innerText?.trim() || b.value || b.id || 'option',
            value: b.value || b.id || '',
            selectors: b.id ? [`#${CSS.escape(b.id)}`] : [`input[name="${b.name}"][value="${b.value}"]`],
          })),
        });
      });
      return groups;
    });
  } catch {
    return [];
  }
}

function buildInputMapping(session) {
  const variables = new Map();
  const fields = [];
  for (const evt of session.events) {
    if (evt.type !== 'input' && evt.type !== 'select') continue;
    const varName = evt.variable || 'field';
    if (!variables.has(varName)) {
      variables.set(varName, {
        name: varName,
        type: evt.variable_type || 'text',
        example: evt.variable_type === 'secret' ? '******' : evt.value_redacted || '',
        required: varName === 'username' || varName === 'password',
        batch_source: isBatchVariable(varName) ? 'excel' : null,
        excel_column: isBatchVariable(varName) ? varName : null,
      });
    }
    fields.push({
      step: evt.seq,
      field_label: evt.element?.label || evt.element?.name || varName,
      variable: varName,
      selectors: evt.element?.id ? [`#${evt.element.id}`] : [],
    });
  }
  for (const group of session.discoveredCheckboxGroups || []) {
    variables.set('facilities', {
      name: 'facilities',
      type: 'checkbox_group',
      panel_label: group.panel_label,
      required: false,
      learn_action: 'skip_ok',
      batch_source: 'excel',
      excel_column: 'facilities',
      excel_format: 'comma_labels',
      example: group.options.slice(0, 2).map((o) => o.label).join(','),
      options: group.options,
    });
  }
  return { variables: [...variables.values()], fields };
}

function buildWorkflowSummary(workflowName, mapping, events) {
  const steps = [];
  let stepNum = 0;
  const seen = new Set();
  for (const evt of events) {
    if (evt.type === 'navigate' && !seen.has(evt.url)) {
      seen.add(evt.url);
      stepNum += 1;
      steps.push({ step: stepNum, action: 'Navigate', description: evt.url });
    }
    if (evt.type === 'input' && evt.variable) {
      stepNum += 1;
      steps.push({ step: stepNum, action: 'Input', description: evt.variable });
    }
    if (evt.type === 'click') {
      stepNum += 1;
      steps.push({ step: stepNum, action: 'Click', description: evt.element?.label || evt.element?.tag || 'element' });
    }
  }
  if (mapping.variables.some((v) => v.type === 'checkbox_group')) {
    steps.push({
      step: stepNum + 1,
      action: 'CheckboxGroup',
      description: 'Optional panel — skip during learn; batch from Excel facilities column',
    });
  }
  let md = `# Workflow Summary — ${workflowName}\n\n`;
  md += '## Input Mapping\n\n| Variable | Type | Example | Required |\n| --- | --- | --- | --- |\n';
  for (const v of mapping.variables) {
    md += `| ${v.name} | ${v.type} | ${v.example || ''} | ${v.required ? 'Yes' : 'No'} |\n`;
  }
  md += '\n## Workflow Summary\n\n| Step | Action | Description |\n| --- | --- | --- |\n';
  for (const s of steps) {
    md += `| ${s.step} | ${s.action} | ${s.description} |\n`;
  }
  return md;
}

function generatePlaywrightTs(workflowName, mapping) {
  return `/**
 * Generated by AntlerOffice Website Learning Mode — ${workflowName}
 * Run: npx playwright test ${workflowName}.ts (or import runWorkflow)
 */
import { chromium, type Page } from 'playwright';

export type WorkflowParams = Record<string, string>;

export async function runWorkflow(params: WorkflowParams, opts: { headless?: boolean } = {}) {
  const browser = await chromium.launch({ headless: opts.headless ?? false, channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  try {
    // TODO: refine selectors from selectors.json
${mapping.fields
  .map(
    (f) =>
      `    // Step ${f.step}: ${f.variable}\n    // await page.fill('...', params.${f.variable} ?? '');`,
  )
  .join('\n')}
    return { ok: true };
  } finally {
    await context.close();
    await browser.close();
  }
}
`;
}

function generateBatchRunnerTs(workflowName) {
  return `/**
 * Batch runner — ${workflowName}
 * Usage: npx ts-node batch_runner.ts ./data.csv
 */
import fs from 'node:fs';
import { runWorkflow } from './playwright';

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\\r?\\n/);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).filter(Boolean).map((line) => {
    const cols = line.match(/("([^"]|"")*"|[^,]*)/g) || [];
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (cols[i] || '').trim().replace(/^"|"$/g, '').replace(/""/g, '"');
    });
    return row;
  });
}

async function main() {
  const csvPath = process.argv[2] || './batch.csv';
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const results: unknown[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const params = { ...row, password: process.env.PASSWORD || '' };
      await runWorkflow(params);
      results.push({ row: i + 1, status: 'ok' });
    } catch (e) {
      results.push({ row: i + 1, status: 'error', error: String(e) });
    }
  }
  fs.writeFileSync('result.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}

main();
`;
}

function generateEnvTemplate(mapping) {
  const lines = ['# Copy to .env for batch/simulate runs'];
  for (const v of mapping.variables) {
    if (v.type === 'secret') lines.push(`${(v.env_key || v.name).toUpperCase()}=`);
  }
  return `${lines.join('\n')}\n`;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const rows = lines.slice(1).filter(Boolean).map((line) => {
    const cols = line.match(/("([^"]|"")*"|[^,]*)/g) || [];
    const row = {};
    headers.forEach((h, i) => {
      row[h] = (cols[i] || '').trim().replace(/^"|"$/g, '').replace(/""/g, '"');
    });
    return row;
  });
  return { headers, rows };
}

function readDataFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const raw = fs.readFileSync(filePath, 'utf8');
  if (ext === '.csv' || ext === '.txt') return parseCsv(raw);
  if (ext === '.json') {
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return { headers: Object.keys(data[0] || {}), rows: data };
    return parseCsv(raw);
  }
  throw new Error('Supported batch files: .csv, .json. Save Excel as CSV for now.');
}

async function start({ workflow_name, start_url = '', profile_mode = 'ephemeral', profile_label = '' }) {
  ensurePlaywright();
  if (_sessions.size > 0) {
    throw new Error('Another learning session is active. Say 学习结束 first.');
  }
  const wf = safeWorkflowName(workflow_name);
  if (!wf) throw new Error('workflow_name is required');
  const workflowPath = workflowDir(wf);
  fs.mkdirSync(path.join(workflowPath, 'screenshots'), { recursive: true });
  const profileDir = resolveProfileDir({ workflow_name: wf, profile_mode, profile_label });
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1920, height: 1080 },
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
  });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(60000);
  await injectRecorder(page);

  const session_id = randomUUID();
  const tracePath = path.join(workflowPath, 'action_trace.jsonl');
  const session = {
    session_id,
    workflow_name: wf,
    workflowPath,
    tracePath,
    profile_mode,
    context,
    page,
    events: [],
    seq: 0,
    shotStep: 1,
    discoveredCheckboxGroups: [],
    lastUrl: page.url(),
    observe: true,
  };

  page.on('framenavigated', async (frame) => {
    if (frame !== page.mainFrame()) return;
    try {
      const shot = await takeScreenshot(session, 'before_nav', new URL(frame.url()).hostname);
      session.seq += 1;
      const evt = {
        seq: session.seq,
        type: 'navigate',
        timestamp: new Date().toISOString(),
        url: frame.url(),
        from: session.lastUrl,
        screenshot_path: shot,
      };
      session.lastUrl = frame.url();
      appendJsonl(tracePath, evt);
      session.events.push(evt);
    } catch {
      /* */
    }
  });

  if (start_url) {
    await page.goto(start_url, { waitUntil: 'domcontentloaded' });
  }

  _sessions.set(session_id, session);
  writeJson(path.join(workflowPath, 'meta.json'), {
    workflow_name: wf,
    profile_mode,
    session_id,
    started_at: new Date().toISOString(),
    status: 'learning',
  });

  return {
    ok: true,
    session_id,
    workflow_name: wf,
    workflow_path: workflowPath,
    profile_mode,
    message: 'Chrome 已打开（观察模式）。请在浏览器中操作；IT Junior 在后台静默记录。完成后回复「学习结束」。',
  };
}

async function poll({ session_id, since_seq = 0 }) {
  const session = _sessions.get(session_id);
  if (!session) throw new Error('session not found');
  await drainDomEvents(session);
  session.discoveredCheckboxGroups = await discoverCheckboxGroups(session.page);
  const newEvents = session.events.filter((e) => e.seq > since_seq);
  return {
    session_id,
    workflow_name: session.workflow_name,
    since_seq,
    events: newEvents,
    total_seq: session.seq,
    checkbox_groups: session.discoveredCheckboxGroups,
  };
}

async function screenshot({ session_id, label = 'manual' }) {
  const session = _sessions.get(session_id);
  if (!session) throw new Error('session not found');
  const shot = await takeScreenshot(session, 'manual', label);
  const fields = await session.page.evaluate(() =>
    [...document.querySelectorAll('input,select,textarea')].slice(0, 40).map((el) => ({
      tag: el.tagName,
      type: el.type || '',
      id: el.id || '',
      name: el.name || '',
      label: el.labels?.[0]?.innerText?.trim() || el.getAttribute('placeholder') || '',
    })),
  );
  return { screenshot_path: shot, url: session.page.url(), fields };
}

async function stop({ session_id }) {
  const session = _sessions.get(session_id);
  if (!session) throw new Error('session not found');
  await drainDomEvents(session);
  session.discoveredCheckboxGroups = await discoverCheckboxGroups(session.page);
  try {
    await session.context.close();
  } catch {
    /* */
  }
  _sessions.delete(session_id);
  writeJson(path.join(session.workflowPath, 'meta.json'), {
    workflow_name: session.workflow_name,
    profile_mode: session.profile_mode,
    session_id,
    stopped_at: new Date().toISOString(),
    status: 'stopped',
    event_count: session.events.length,
  });
  return {
    ok: true,
    workflow_name: session.workflow_name,
    workflow_path: session.workflowPath,
    trace_path: session.tracePath,
    event_count: session.events.length,
  };
}

function activeSession() {
  for (const s of _sessions.values()) return s;
  return null;
}

async function exportWorkflow({ session_id, workflow_name: wfArg = '' }) {
  const session = _sessions.get(session_id);
  const wf = safeWorkflowName(session?.workflow_name || wfArg);
  const workflowPath = workflowDir(wf);
  let events = session?.events || [];
  if (!events.length && fs.existsSync(path.join(workflowPath, 'action_trace.jsonl'))) {
    events = fs
      .readFileSync(path.join(workflowPath, 'action_trace.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
  const discoveredCheckboxGroups =
    session?.discoveredCheckboxGroups || (await discoverCheckboxGroupsFromTrace(events));
  const mapping = buildInputMapping({ events, discoveredCheckboxGroups });
  const summary = buildWorkflowSummary(wf, mapping, events);
  writeJson(path.join(workflowPath, 'input_mapping.json'), mapping);
  writeJson(path.join(workflowPath, 'selectors.json'), {
    workflow_name: wf,
    fields: mapping.fields,
    checkbox_groups: discoveredCheckboxGroups,
  });
  fs.writeFileSync(path.join(workflowPath, 'workflow_summary.md'), summary, 'utf8');
  fs.writeFileSync(path.join(workflowPath, 'playwright.ts'), generatePlaywrightTs(wf, mapping), 'utf8');
  fs.writeFileSync(path.join(workflowPath, 'batch_runner.ts'), generateBatchRunnerTs(wf), 'utf8');
  fs.writeFileSync(path.join(workflowPath, 'env.template'), generateEnvTemplate(mapping), 'utf8');
  writeJson(path.join(workflowPath, 'meta.json'), {
    workflow_name: wf,
    completed_at: new Date().toISOString(),
    status: 'exported',
  });
  return {
    ok: true,
    workflow_name: wf,
    workflow_path: workflowPath,
    files: [
      'workflow_summary.md',
      'input_mapping.json',
      'selectors.json',
      'playwright.ts',
      'batch_runner.ts',
      'env.template',
    ],
    mapping,
  };
}

function discoverCheckboxGroupsFromTrace() {
  return [];
}

// Self-healing click. Delegates to selector-heal, which tries selectors in a
// reliability order AND verifies each candidate actually matches the recorded
// element (confidence check) before clicking — so a redesigned page can't make
// it click the wrong thing. Successful heals are logged + remembered (overlay,
// rollbackable); all-fail returns needsHuman instead of guessing.
async function selfHealingClick(page, evt, opts = {}) {
  return selectorHeal.resolveClick(page, evt, {
    workflowPath: opts.workflowPath,
    allowCoordinates: opts.allowCoordinates,
  });
}

// Summarise self-healing for one row's replay steps, for the batch result table.
function summariseHeal(steps) {
  const clicks = (steps || []).filter((s) => s.action === 'click');
  const levels = clicks.map((c) => c.heal_level).filter((n) => typeof n === 'number');
  return {
    self_healed: clicks.some((c) => c.healed) ? 'yes' : 'no',
    heal_level: levels.length ? Math.max(...levels) : '',
    coord_fallbacks: clicks.filter((c) => c.method === 'coordinates').length,
  };
}

async function simulateOnce({ workflow_name, slow_mo_ms = 300, row = null, account_alias = null }) {
  const wf = safeWorkflowName(workflow_name);
  const workflowPath = workflowDir(wf);
  const mapping = readJson(path.join(workflowPath, 'input_mapping.json'), { variables: [], fields: [] });
  if (!mapping.variables.length) throw new Error('No exported workflow. Complete learning and export first.');
  // Optional: log in with a chosen saved account. No alias → behaves exactly as before (env PASSWORD).
  let account = null;
  if (account_alias && webAccounts) {
    try {
      account = webAccounts.resolveInternalAccount(account_alias);
    } catch {
      account = null;
    }
  }
  ensurePlaywright();
  const meta = readJson(path.join(workflowPath, 'meta.json'), {});
  const profileDir = path.join(workflowPath, 'profile', 'chrome');
  fs.mkdirSync(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1920, height: 1080 },
    slowMo: slow_mo_ms,
  });
  const page = context.pages()[0] || (await context.newPage());
  const steps = [];
  const events = fs.existsSync(path.join(workflowPath, 'action_trace.jsonl'))
    ? fs
        .readFileSync(path.join(workflowPath, 'action_trace.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  try {
    for (const evt of events) {
      if (evt.type === 'navigate' && evt.url) {
        await page.goto(evt.url, { waitUntil: 'domcontentloaded' });
        const shot = path.join('screenshots', `simulate_${evt.seq}_nav.png`);
        await page.screenshot({ path: path.join(workflowPath, shot), fullPage: true });
        steps.push({ seq: evt.seq, action: 'navigate', url: evt.url, screenshot: shot });
      }
      if (evt.type === 'click') {
        const healed = await selfHealingClick(page, evt, { workflowPath });
        steps.push({ seq: evt.seq, action: 'click', ...healed });
      }
      if (evt.type === 'input' && evt.variable) {
        const varDef = mapping.variables.find((v) => v.name === evt.variable);
        const col = varDef?.excel_column || evt.variable;
        const fromRow = row && row[col] != null && String(row[col]) !== '' ? String(row[col]) : null;
        const val =
          evt.variable_type === 'secret'
            ? account?.password || process.env.PASSWORD || '${PASSWORD}' // ← chosen account's password
            : account && LOGIN_USER_VARS.has(evt.variable) && account.username
              ? account.username // ← chosen account's username/email
              : fromRow != null
                ? fromRow // ← use THIS row's value in batch
                : varDef?.example || '';
        const sel = evt.element?.id ? `#${evt.element.id}` : null;
        if (sel) await page.fill(sel, val);
        steps.push({ seq: evt.seq, action: 'input', variable: evt.variable, source: fromRow != null ? 'row' : 'example' });
      }
    }
    return { ok: true, workflow_name: wf, steps };
  } catch (e) {
    return { ok: false, workflow_name: wf, error: e.message, steps };
  } finally {
    try {
      await context.close();
    } catch {
      /* */
    }
  }
}

async function batchRun({ workflow_name, excel_path, account_alias = null }) {
  const wf = safeWorkflowName(workflow_name);
  const workflowPath = workflowDir(wf);
  const mapping = readJson(path.join(workflowPath, 'input_mapping.json'), { variables: [] });
  const { rows } = readDataFile(excel_path);
  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const sim = await simulateOnce({ workflow_name: wf, slow_mo_ms: 0, row, account_alias });
      const heal = summariseHeal(sim.steps);
      results.push({
        row: i + 1,
        status: sim.ok ? 'ok' : 'error',
        data: row,
        detail: sim.error || null,
        self_healed: heal.self_healed,
        heal_level: heal.heal_level,
        coord_fallbacks: heal.coord_fallbacks,
      });
    } catch (e) {
      results.push({ row: i + 1, status: 'error', data: row, error: e.message, self_healed: '', heal_level: '', coord_fallbacks: '' });
    }
  }
  const outJson = path.join(workflowPath, 'result.json');
  const outCsv = path.join(workflowPath, 'result.csv');
  writeJson(outJson, results);
  const header = 'row,status,self_healed,heal_level,coord_fallbacks,error\n';
  const body = results
    .map(
      (r) =>
        `${r.row},${r.status},${r.self_healed},${r.heal_level},${r.coord_fallbacks},"${(r.error || r.detail || '').replace(/"/g, '""')}"`,
    )
    .join('\n');
  fs.writeFileSync(outCsv, header + body, 'utf8');
  return { ok: true, workflow_name: wf, count: results.length, result_json: outJson, result_csv: outCsv };
}

function listWorkflows() {
  const root = engineRoot();
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'profiles')
    .map((d) => {
      const meta = readJson(path.join(root, d.name, 'meta.json'), {});
      return { workflow_name: d.name, status: meta.status || 'unknown', completed_at: meta.completed_at || null };
    });
}

function setPendingIntake(data) {
  writeJson(_pendingIntakeFile(), { ...data, at: new Date().toISOString() });
}

function getPendingIntake() {
  return readJson(_pendingIntakeFile(), null);
}

function clearPendingIntake() {
  try {
    fs.unlinkSync(_pendingIntakeFile());
  } catch {
    /* */
  }
}

function hasOpenSession() {
  return _sessions.size > 0;
}

module.exports = {
  start,
  poll,
  screenshot,
  stop,
  exportWorkflow,
  simulateOnce,
  batchRun,
  listWorkflows,
  activeSession,
  setPendingIntake,
  getPendingIntake,
  clearPendingIntake,
  hasOpenSession,
  safeWorkflowName,
  engineRoot,
};
