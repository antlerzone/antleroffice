// Company product framework — CEO sets direction; COO executes within scope.

const store = require('./store');

const DEFAULT_FRAMEWORK = {
  enabled: true,
  productName: '',
  productSummary: '',
  inScope: [],
  outOfScope: [],
  futurePlan: [],
  futurePlanCompleted: [],
  primaryRepo: '',
};

function normalizeStringList(raw) {
  if (!Array.isArray(raw)) {
    if (typeof raw === 'string') {
      return raw
        .split(/\r?\n/)
        .map((s) => s.replace(/^[-*•]\s*/, '').trim())
        .filter(Boolean);
    }
    return [];
  }
  return raw.map((s) => String(s || '').trim()).filter(Boolean);
}

function normalizeFramework(raw) {
  const base = { ...DEFAULT_FRAMEWORK };
  const src = raw && typeof raw === 'object' ? raw : {};

  const legacyGoals = normalizeStringList(src.currentGoals);
  let futurePlan = normalizeStringList(src.futurePlan);
  if (!futurePlan.length && legacyGoals.length) {
    futurePlan = legacyGoals;
  }

  return {
    enabled: src.enabled !== false,
    productName: String(src.productName || '').trim().slice(0, 120),
    productSummary: String(src.productSummary || '').trim().slice(0, 2000),
    inScope: normalizeStringList(src.inScope).slice(0, 30),
    outOfScope: normalizeStringList(src.outOfScope).slice(0, 30),
    futurePlan: futurePlan.slice(0, 20),
    futurePlanCompleted: normalizeStringList(src.futurePlanCompleted).slice(0, 50),
    primaryRepo: String(src.primaryRepo || '').trim().slice(0, 500),
  };
}

function getFramework() {
  const office = store.readSettings().office || {};
  return normalizeFramework(office.companyFramework);
}

function saveFramework(patch = {}) {
  const office = store.readSettings().office || {};
  const current = normalizeFramework(office.companyFramework);
  const next = normalizeFramework({ ...current, ...patch });
  store.writeSettings({
    office: {
      ...office,
      companyFramework: next,
    },
  });
  return next;
}

function isConfigured(framework = getFramework()) {
  if (!framework.enabled) return false;
  const hasProduct =
    Boolean(framework.productName) || Boolean(framework.productSummary.trim());
  return hasProduct;
}

function hasPendingFuturePlan(framework = getFramework()) {
  return framework.enabled && framework.futurePlan.length > 0;
}

function peekNextFuturePlanItem(framework = getFramework()) {
  if (!framework.futurePlan.length) return null;
  return framework.futurePlan[0];
}

// Append CEO-confirmed items to the Future Plan. Source MUST be the CEO's own
// stated/confirmed direction (read-back-and-approve flow) — never COO self-brainstorm.
// Dedupes against existing pending + completed items; respects the 20-item cap.
function addFuturePlanItems(items) {
  const incoming = normalizeStringList(items);
  if (!incoming.length) return { framework: getFramework(), added: [] };

  const fw = getFramework();
  const existing = new Set([
    ...fw.futurePlan.map((s) => s.toLowerCase()),
    ...fw.futurePlanCompleted.map((s) => s.toLowerCase()),
  ]);

  const added = [];
  for (const item of incoming) {
    const key = item.toLowerCase();
    if (existing.has(key)) continue;
    existing.add(key);
    added.push(item);
  }
  if (!added.length) return { framework: fw, added: [] };

  const nextPlan = [...fw.futurePlan, ...added].slice(0, 20);
  const framework = saveFramework({ futurePlan: nextPlan });
  return { framework, added };
}

function completeFuturePlanItem(itemText) {
  const fw = getFramework();
  const target = String(itemText || '').trim();
  if (!target) return fw;

  const idx = fw.futurePlan.findIndex((line) => line === target);
  const nextPlan = [...fw.futurePlan];
  if (idx >= 0) {
    nextPlan.splice(idx, 1);
  } else if (nextPlan.length) {
    nextPlan.shift();
  }

  const completed = target || fw.futurePlan[0] || '';
  const nextCompleted = completed
    ? [completed, ...fw.futurePlanCompleted.filter((c) => c !== completed)].slice(0, 50)
    : fw.futurePlanCompleted;

  return saveFramework({
    futurePlan: nextPlan,
    futurePlanCompleted: nextCompleted,
  });
}

// CEO coding-comprehension level (set during IT onboarding, saved as
// dev.ceoCodingLevel). Drives how technical COO→CEO reports may be.
const CODING_LEVEL_GUIDANCE = {
  '1': [
    '## CEO technical level: 1 — NON-TECHNICAL (plain language only)',
    'The CEO has zero coding knowledge. In every report or message to the CEO:',
    '- Use NO code, no jargon, no file names, no tool names. Explain everything in plain everyday language and simple analogies.',
    '- Be short and direct. The CEO mainly nods or shakes (approve / reject) — present decisions as a simple either/or with a clear recommendation.',
    '- Never show diffs, errors, configs, or commands. Translate "what changed and why it matters" into plain business terms.',
  ],
  '2': [
    '## CEO technical level: 2 — SEMI-TECHNICAL',
    'The CEO understands some technical terms. In reports to the CEO:',
    '- You may use common terms, but briefly explain anything non-obvious.',
    '- Lead with a one-line plain-language summary, then offer detail; invite the CEO to ask follow-ups when unsure.',
    '- Keep deep code detail optional — summarize first, expand only if asked.',
  ],
  '3': [
    '## CEO technical level: 3 — DEVELOPER',
    'The CEO is a developer. In reports to the CEO:',
    '- Full technical detail is welcome: code, diffs, file paths, architecture, trade-offs.',
    '- Be precise and concise; no need to simplify or avoid jargon.',
  ],
};

// Always-on: tells the COO how the CEO can change their technical level mid-chat.
const CEO_LEVEL_CHANGE_INSTRUCTION = [
  '## Adjusting the CEO technical level (changeable any time in chat)',
  'The CEO can change how technical you are whenever they want — e.g. "讲简单点 / 我看不懂", "多给点技术细节", "把我的技术等级设成开发者 / 完全不懂".',
  'When the CEO clearly asks for this, emit on its own line: SET_CEO_LEVEL: <1|2|3>  (1 = non-technical, 2 = semi-technical, 3 = developer).',
  "Then confirm in ONE short sentence, already written in the NEW level's style. Never show the marker text itself to the CEO.",
  'Only emit the marker on an explicit request to change the level — never for a normal question.',
].join('\n');

function formatCodingLevelBlock() {
  const level = String(store.readSettings().dev?.ceoCodingLevel || '').trim();
  const parts = [];
  const guide = CODING_LEVEL_GUIDANCE[level];
  if (guide) parts.push(guide.join('\n'));
  parts.push(CEO_LEVEL_CHANGE_INSTRUCTION);
  return parts.join('\n\n');
}

// Parse a COO "SET_CEO_LEVEL: N" directive out of chat text. Returns '1'|'2'|'3' or null.
function parseCeoLevelDirective(text) {
  const m = String(text || '').match(/SET_CEO_LEVEL\s*:\s*([123])\b/i);
  return m ? m[1] : null;
}

// Persist the CEO's technical level (lives in dev settings, read by formatCodingLevelBlock).
function setCeoCodingLevel(level) {
  const lvl = String(level || '').trim();
  if (!['1', '2', '3'].includes(lvl)) return null;
  const s = store.readSettings();
  s.dev = { ...(s.dev || {}), ceoCodingLevel: lvl };
  store.writeSettings(s);
  return lvl;
}

function formatPromptBlock(framework = getFramework()) {
  if (!framework.enabled) return '';

  const lines = [
    '## Company framework (MANDATORY)',
    '',
    '**Direction is set by the CEO.** Do NOT invent new product directions, brainstorm side projects, or self-start initiatives.',
    'Execute only: (1) direct CEO chat instructions, (2) CEO Future Plan items below, (3) resume stalled approved work.',
    'If work does not clearly advance the product below, refuse and ask the CEO to update scope or add a Future Plan item.',
    'Do NOT propose unrelated products (e.g. food menu apps, random consumer apps, side hustles).',
    '',
    '**Future Plan intake (CEO is non-technical — never ask them to edit Settings):**',
    'When the CEO describes ongoing direction, a multi-item improvement list, or "keep doing X / I want it done by tomorrow"-style work,',
    'do NOT start building immediately. First restate their intent as a numbered Future Plan, then emit this exact machine marker on its own line so the office can queue it:',
    'FUTURE_PLAN_PROPOSE:',
    '1. <item one>',
    '2. <item two>',
    '(one item per line after the marker). Then ask the CEO to reply APPROVED to queue it, or REVISION: to adjust.',
    'ONLY list items the CEO actually said or clearly confirmed — this is transcription of THEIR direction, never your own new ideas.',
    'A single concrete immediate task (e.g. "fix this button now") still runs the normal pipeline — use the proposal only for direction / multi-item / overnight work.',
  ];

  const codingLevelBlock = formatCodingLevelBlock();
  if (codingLevelBlock) lines.push('', codingLevelBlock);

  if (framework.productName) {
    lines.push('', `**Product:** ${framework.productName}`);
  }
  if (framework.productSummary) {
    lines.push('', `**What we are building:** ${framework.productSummary}`);
  }
  if (framework.inScope.length) {
    lines.push('', '**In scope:**');
    for (const item of framework.inScope) lines.push(`- ${item}`);
  }
  if (framework.outOfScope.length) {
    lines.push('', '**Explicitly out of scope (never propose):**');
    for (const item of framework.outOfScope) lines.push(`- ${item}`);
  }
  if (framework.futurePlan.length) {
    lines.push('', '**CEO Future Plan (approved direction — execute in order):**');
    for (const item of framework.futurePlan) lines.push(`- ${item}`);
  } else {
    lines.push(
      '',
      '_No CEO Future Plan items — COO must not self-brainstorm. Ask the CEO to add items in Settings → Company framework._',
    );
  }
  if (framework.primaryRepo) {
    lines.push('', `**Primary codebase:** \`${framework.primaryRepo}\``);
  }

  lines.push(
    '',
    '**Operational routing (COO must follow):**',
    '- CEO chat attachments → Materials `Admin Vault/_inbox/` → delegate **Admin Manager** to archive via `admin_archive_document` (never ask CEO for folder names).',
    '- Coliving room/operational expenses → **Coliving Admin VIP** when Coliving OAuth is connected (use `coliving_add_expense` or portal).',
    '- Accounting → Bukku **verify/reconcile only** — do not duplicate operational expense entry when Coliving MCP is connected.',
    '- Admin document lookup → read `Admin Vault/index.md` or `admin_list_vault_index` before asking CEO.',
  );

  if (!isConfigured(framework)) {
    lines.push(
      '',
      '_Framework not fully configured — CEO should set product name/summary in Settings → Company framework._',
    );
  }

  return lines.join('\n');
}

function formatExecuteFuturePlanInstruction(itemText, framework = getFramework()) {
  return [
    'COO heartbeat — execute next CEO-approved Future Plan item.',
    '',
    formatPromptBlock(framework),
    '',
    `**Execute this CEO Future Plan item now:** ${itemText}`,
    '',
    'Rules:',
    '- This direction was pre-approved by the CEO — plan and delegate without inventing a different goal.',
    '- Stay inside in-scope and company framework; reject scope creep.',
    '- If plan includes IT/code work, first step MUST be security scan (npm audit).',
    '- Operational plan steps may run autonomously; stop before git push, external publish, delete, or large spend — CEO APPROVED only.',
    '- When finished, summarize what was delivered for this Future Plan item.',
  ].join('\n');
}

// Detect a COO "FUTURE_PLAN_PROPOSE:" marker in chat output and pull out the
// proposed items (the numbered/bulleted lines that follow the marker).
function parseFuturePlanProposal(text) {
  const blob = String(text || '');
  const idx = blob.search(/FUTURE_PLAN_PROPOSE\s*:/i);
  if (idx < 0) return null;
  const after = blob.slice(idx).replace(/^[^\n]*FUTURE_PLAN_PROPOSE\s*:/i, '');
  const items = [];
  for (const rawLine of after.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (items.length) break; // blank line after items ends the block
      continue;
    }
    const cleaned = line.replace(/^(\d+[.)]|[-*•])\s*/, '').trim();
    if (!cleaned) continue;
    if (/^(approved|revision)\b/i.test(cleaned)) break;
    items.push(cleaned);
  }
  return items.length ? items : null;
}

function looksOutOfScope(text, framework = getFramework()) {
  if (!framework.enabled || !framework.outOfScope.length) return false;
  const blob = String(text || '').toLowerCase();
  return framework.outOfScope.some((item) => {
    const key = String(item || '').toLowerCase().trim();
    return key.length >= 4 && blob.includes(key);
  });
}

module.exports = {
  DEFAULT_FRAMEWORK,
  normalizeFramework,
  getFramework,
  saveFramework,
  isConfigured,
  hasPendingFuturePlan,
  peekNextFuturePlanItem,
  addFuturePlanItems,
  completeFuturePlanItem,
  formatPromptBlock,
  formatExecuteFuturePlanInstruction,
  parseFuturePlanProposal,
  formatCodingLevelBlock,
  parseCeoLevelDirective,
  setCeoCodingLevel,
  looksOutOfScope,
};
