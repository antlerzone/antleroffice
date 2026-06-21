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

function formatPromptBlock(framework = getFramework()) {
  if (!framework.enabled) return '';

  const lines = [
    '## Company framework (MANDATORY)',
    '',
    '**Direction is set by the CEO.** Do NOT invent new product directions, brainstorm side projects, or self-start initiatives.',
    'Execute only: (1) direct CEO chat instructions, (2) CEO Future Plan items below, (3) resume stalled approved work.',
    'If work does not clearly advance the product below, refuse and ask the CEO to update scope or add a Future Plan item.',
    'Do NOT propose unrelated products (e.g. food menu apps, random consumer apps, side hustles).',
  ];

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
  completeFuturePlanItem,
  formatPromptBlock,
  formatExecuteFuturePlanInstruction,
  looksOutOfScope,
};
