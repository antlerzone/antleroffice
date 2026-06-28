/**
 * browser-agent-loop.js
 *
 * AI-driven browser agent for AntlerOffice.
 * Uses Playwright (headed, visible to boss) + any configured LLM to complete
 * browser tasks step by step — no screen recording, no coordinate hardcoding.
 *
 * Flow per step:
 *   1. Snapshot page accessibility tree  →  readable element list
 *   2. Send task + element list to LLM   →  next action JSON
 *   3. Execute action via Playwright
 *   4. Wait for page to settle
 *   5. Repeat until { action: "done" } or max steps reached
 *
 * Credentials are NEVER sent to the LLM.
 * LLM says: { action:"type", target:"Email field", credential:"email" }
 * We inject the real value from web-accounts-store here on the server.
 */

const fs   = require('node:fs');
const path = require('node:path');
const store = require('./store');
const bossChat = require('./boss-chat-store');

// ── Browser driver (Patchright-hardened, optional dep, graceful degrade) ──────
// Goes through stealth-browser: Patchright if installed, else plain Playwright.
const { chromium } = require('./stealth-browser');

// ── Session registry ──────────────────────────────────────────────────────────
const sessions = new Map(); // id → session object

function genId() {
  return `bragent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function getSession(id) {
  return sessions.get(id) || null;
}

function listSessions() {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    task: s.task,
    status: s.status,
    step: s.step,
    maxSteps: s.maxSteps,
    startedAt: s.startedAt,
    currentUrl: s.currentUrl,
    lastAction: s.lastAction,
    result: s.result,
    error: s.error,
  }));
}

// ── LLM caller (direct API, not via OpenClaw) ─────────────────────────────────
// We need a tight synchronous loop so we call the provider directly.

async function callLlm(messages, { timeoutMs = 30000 } = {}) {
  const s      = store.readSettings();
  const defProv = s.defaultProvider || 'openai';
  const provKey = defProv === 'demo' ? 'openai' : defProv;
  const prov    = s.providers?.[provKey] || {};
  const apiKey  = String(prov.apiKey || '').trim();
  const model   = String(prov.model || '').trim();

  if (!apiKey) throw new Error(`No API key configured for provider "${provKey}". Please set it in Settings → AI.`);

  if (provKey === 'openai') {
    return callOpenAi(messages, { apiKey, model: model || 'gpt-4o', timeoutMs });
  }
  if (provKey === 'anthropic') {
    return callAnthropic(messages, { apiKey, model: model || 'claude-3-5-sonnet-latest', timeoutMs });
  }
  if (provKey === 'gemini') {
    return callGemini(messages, { apiKey, model: model || 'gemini-1.5-flash', timeoutMs });
  }
  throw new Error(`Unsupported provider "${provKey}" for browser agent.`);
}

async function callOpenAi(messages, { apiKey, model, timeoutMs }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body:    JSON.stringify({ model, messages, temperature: 0, max_tokens: 512 }),
    signal:  AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content || '';
}

async function callAnthropic(messages, { apiKey, model, timeoutMs }) {
  // Anthropic format: system separate from messages
  const [sys, ...rest] = messages[0]?.role === 'system'
    ? [messages[0].content, ...messages.slice(1)]
    : ['', ...messages];
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body:   JSON.stringify({ model, system: sys, messages: rest, max_tokens: 512 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.content?.[0]?.text || '';
}

async function callGemini(messages, { apiKey, model, timeoutMs }) {
  const parts = messages.map((m) => ({ text: `${m.role.toUpperCase()}: ${m.content}` }));
  const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res   = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ contents: [{ parts }] }),
    signal:  AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── A11y tree → readable text ─────────────────────────────────────────────────

function formatA11yNode(node, depth = 0) {
  if (!node || node.role === 'none' || node.role === 'presentation') {
    return (node?.children || []).flatMap((c) => formatA11yNode(c, depth)).filter(Boolean);
  }
  const indent = '  '.repeat(depth);
  const name   = node.name ? ` "${node.name}"` : '';
  const value  = node.value ? ` [value: ${node.value}]` : '';
  const desc   = node.description ? ` (${node.description})` : '';
  const role   = String(node.role || '').toUpperCase();
  const line   = `${indent}${role}${name}${value}${desc}`;
  const children = (node.children || []).flatMap((c) => formatA11yNode(c, depth + 1)).filter(Boolean);
  return [line, ...children];
}

async function getPageSnapshot(page) {
  try {
    const tree  = await page.accessibility.snapshot({ interestingOnly: true });
    const lines = tree ? formatA11yNode(tree) : [];
    return lines.slice(0, 120).join('\n') || '(empty page)';
  } catch {
    return '(could not read page elements)';
  }
}

// ── Action parser ─────────────────────────────────────────────────────────────

function parseAction(llmText) {
  // Try to extract JSON from the response
  const match = llmText.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                llmText.match(/(\{[\s\S]*\})/);
  if (!match) throw new Error(`No JSON found in LLM response: ${llmText.slice(0, 200)}`);
  try {
    return JSON.parse(match[1]);
  } catch (e) {
    throw new Error(`JSON parse error: ${e.message}\nRaw: ${match[1].slice(0, 200)}`);
  }
}

// ── Action executor ───────────────────────────────────────────────────────────

/**
 * Try multiple Playwright locator strategies for a given human-readable target.
 * Returns the first matching locator, or null.
 */
async function findElement(page, target) {
  const strategies = [
    () => page.getByRole('button',   { name: target, exact: false }),
    () => page.getByRole('textbox',  { name: target, exact: false }),
    () => page.getByRole('combobox', { name: target, exact: false }),
    () => page.getByRole('checkbox', { name: target, exact: false }),
    () => page.getByRole('link',     { name: target, exact: false }),
    () => page.getByLabel(target,    { exact: false }),
    () => page.getByPlaceholder(target, { exact: false }),
    () => page.getByText(target,     { exact: false }),
  ];
  for (const fn of strategies) {
    try {
      const loc   = fn();
      const count = await loc.count();
      if (count > 0) return loc.first();
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Resolve a credential key to the actual value from web-accounts-store.
 * Returns undefined if not found.
 */
function resolveCredential(credentialKey, credentials = {}) {
  const key = String(credentialKey || '').toLowerCase();
  // Direct match
  if (credentials[key] !== undefined) return credentials[key];
  // Common aliases
  const aliases = {
    email: ['email', 'username', 'user', 'login', 'mail'],
    password: ['password', 'pass', 'pwd', 'secret'],
    phone: ['phone', 'mobile', 'tel'],
    company: ['company', 'company_id', 'companyid', 'org'],
  };
  for (const [group, keys] of Object.entries(aliases)) {
    if (keys.includes(key) && credentials[group] !== undefined) {
      return credentials[group];
    }
  }
  return undefined;
}

async function executeAction(page, action, credentials = {}) {
  const type = String(action.action || '').toLowerCase();

  if (type === 'navigate') {
    const url = String(action.url || '').trim();
    if (!url) throw new Error('navigate: missing url');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(800);
    return { ok: true, description: `Navigated to ${url}` };
  }

  if (type === 'click') {
    const target = String(action.target || action.selector || '').trim();
    const el = await findElement(page, target);
    if (!el) throw new Error(`click: element not found — "${target}"`);
    await el.click({ timeout: 8000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    return { ok: true, description: `Clicked "${target}"` };
  }

  if (type === 'type' || type === 'fill') {
    const target = String(action.target || action.selector || '').trim();
    let   value  = String(action.text || action.value || '').trim();

    // Credential injection — never let LLM send actual password
    if (action.credential || action.isCredential) {
      const credKey = String(action.credential || action.text || '').toLowerCase();
      const resolved = resolveCredential(credKey, credentials);
      if (resolved !== undefined) {
        value = String(resolved);
      }
    }

    const el = await findElement(page, target);
    if (!el) throw new Error(`type: element not found — "${target}"`);
    await el.fill(value, { timeout: 8000 });
    const masked = action.credential ? '***' : value;
    return { ok: true, description: `Typed "${masked}" into "${target}"` };
  }

  if (type === 'select') {
    const target = String(action.target || '').trim();
    const value  = String(action.value || action.option || '').trim();
    const el = await findElement(page, target);
    if (!el) throw new Error(`select: element not found — "${target}"`);
    await el.selectOption({ label: value }, { timeout: 8000 }).catch(async () => {
      await el.selectOption(value, { timeout: 8000 });
    });
    return { ok: true, description: `Selected "${value}" in "${target}"` };
  }

  if (type === 'wait') {
    const ms = Math.min(Number(action.ms || 1500), 10000);
    await page.waitForTimeout(ms);
    return { ok: true, description: `Waited ${ms}ms` };
  }

  if (type === 'scroll') {
    await page.evaluate(() => window.scrollBy(0, 400));
    return { ok: true, description: 'Scrolled down' };
  }

  if (type === 'done') {
    return { ok: true, done: true, result: String(action.result || 'Task completed') };
  }

  if (type === 'error') {
    throw new Error(String(action.message || 'LLM reported an error'));
  }

  throw new Error(`Unknown action type: "${type}"`);
}

// ── System prompt for browser agent LLM ─────────────────────────────────────

function buildSystemPrompt(task, credentials = {}) {
  const credList = Object.keys(credentials)
    .filter((k) => k !== 'password' && k !== 'pass' && k !== 'pwd')
    .map((k) => `  - ${k}: available`)
    .join('\n');
  const hasCreds = Object.keys(credentials).length > 0;

  return `You are a browser automation agent inside AntlerOffice. Your job is to complete browser tasks step by step.

TASK: ${task}

${hasCreds ? `AVAILABLE CREDENTIALS (for logging in):\n${credList}\n  - password: available (NEVER ask for the actual value)\n` : ''}

On each step you will receive:
- The current page URL
- A list of accessible elements on the page
- Your step number

You must respond with a single JSON action (no other text):

Navigate to a URL:
{"action":"navigate","url":"https://example.com"}

Click an element:
{"action":"click","target":"Sign in button"}

Type text (use for non-credential fields):
{"action":"type","target":"Search box","text":"quarterly report"}

Fill a credential field (password NEVER put in "text"):
{"action":"type","target":"Email address","text":"email","credential":"email","isCredential":true}
{"action":"type","target":"Password","text":"password","credential":"password","isCredential":true}

Select a dropdown option:
{"action":"select","target":"Country","value":"Malaysia"}

Wait briefly:
{"action":"wait","ms":1500}

Task complete:
{"action":"done","result":"Exported invoices successfully. File saved to Downloads."}

If truly stuck:
{"action":"error","message":"Cannot find the export button after 3 attempts"}

RULES:
- NEVER put actual passwords or credentials in your JSON — use credential keys ("email", "password")
- Match element names exactly to what appears in the accessible elements list
- Keep responses as pure JSON only — no prose, no explanation
- After filling login fields, always click the submit/sign-in button next
- If a page is loading, use {"action":"wait","ms":2000} before trying to interact`;
}

// ── Main agent loop ───────────────────────────────────────────────────────────

async function runBrowserTask({
  task,
  startUrl      = null,
  credentials   = {},   // { email, password, ... } — from web-accounts-store
  maxSteps      = 25,
  headless      = false, // false = visible window (boss can watch)
  threadId      = null,
  onStep        = null,  // callback(stepInfo) for real-time progress
} = {}) {
  if (!chromium) {
    return { ok: false, error: 'Playwright is not installed. Run: npm install playwright' };
  }
  if (!task) return { ok: false, error: 'task is required' };

  const id = genId();
  const session = {
    id,
    task,
    status: 'starting',
    step: 0,
    maxSteps,
    startedAt: new Date().toISOString(),
    currentUrl: startUrl || '',
    lastAction: null,
    result: null,
    error: null,
    logs: [],
  };
  sessions.set(id, session);

  function log(msg) {
    session.logs.push({ ts: new Date().toISOString(), msg });
    if (typeof onStep === 'function') {
      try { onStep({ id, ...session }); } catch { /* ignore */ }
    }
    if (threadId) {
      try { bossChat.addMessage(threadId, 'system', `🤖 Browser Agent: ${msg}`); } catch { /* ignore */ }
    }
  }

  let browser = null;
  let page    = null;

  try {
    session.status = 'running';
    log('Starting browser (visible window)…');

    browser = await chromium.launch({
      headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      slowMo: headless ? 0 : 300, // slight slow-motion so boss can follow
    });
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    });
    page = await ctx.newPage();

    if (startUrl) {
      log(`Navigating to ${startUrl}…`);
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      session.currentUrl = page.url();
    }

    const systemPrompt = buildSystemPrompt(task, credentials);
    const messages = [{ role: 'system', content: systemPrompt }];

    for (let step = 1; step <= maxSteps; step++) {
      session.step = step;

      const url       = page.url();
      const title     = await page.title().catch(() => '');
      const snapshot  = await getPageSnapshot(page);
      session.currentUrl = url;

      const userMsg = `Step ${step}/${maxSteps}
URL: ${url}
Title: ${title}

Accessible elements:
${snapshot}

What is the next action?`;

      messages.push({ role: 'user', content: userMsg });

      log(`Step ${step}: analysing page "${title || url}"…`);

      let llmText;
      try {
        llmText = await callLlm(messages);
      } catch (e) {
        session.status = 'error';
        session.error  = `LLM call failed: ${e.message}`;
        log(`❌ LLM error: ${e.message}`);
        return { ok: false, error: session.error, id };
      }

      messages.push({ role: 'assistant', content: llmText });

      let action;
      try {
        action = parseAction(llmText);
      } catch (e) {
        log(`⚠️ Could not parse LLM response, retrying… (${e.message})`);
        // Give the LLM a chance to self-correct
        messages.push({ role: 'user', content: 'Your response was not valid JSON. Please reply with ONLY a JSON action object.' });
        const retry = await callLlm(messages).catch(() => '');
        messages.push({ role: 'assistant', content: retry });
        try {
          action = parseAction(retry);
        } catch {
          session.status = 'error';
          session.error  = 'LLM returned invalid JSON twice';
          log('❌ Could not parse LLM action after retry');
          return { ok: false, error: session.error, id };
        }
      }

      session.lastAction = action;
      log(`→ ${action.action}: ${action.target || action.url || action.result || ''}`);

      let execResult;
      try {
        execResult = await executeAction(page, action, credentials);
      } catch (e) {
        log(`⚠️ Action failed: ${e.message}`);
        // Tell LLM the action failed, let it try something else
        messages.push({ role: 'user', content: `The action failed: ${e.message}. Try a different approach.` });
        continue;
      }

      if (execResult.done) {
        session.status = 'done';
        session.result = execResult.result;
        log(`✅ Done: ${execResult.result}`);
        return { ok: true, id, result: execResult.result, steps: step };
      }

      // Brief settle wait after action
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    }

    session.status = 'error';
    session.error  = `Reached maximum ${maxSteps} steps without completing the task`;
    log(`❌ Max steps reached`);
    return { ok: false, error: session.error, id };

  } catch (e) {
    session.status = 'error';
    session.error  = e.message;
    log(`❌ Fatal error: ${e.message}`);
    return { ok: false, error: e.message, id };
  } finally {
    // Keep browser open briefly so boss can see the final state
    if (browser) {
      setTimeout(() => {
        browser.close().catch(() => {});
        sessions.delete(id);
      }, headless ? 0 : 8000); // 8s viewing time
    }
  }
}

/**
 * Stop a running session early.
 */
function stopSession(id) {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: 'Session not found' };
  s.status = 'stopped';
  s.error  = 'Stopped by user';
  return { ok: true };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  runBrowserTask,
  stopSession,
  getSession,
  listSessions,
};
