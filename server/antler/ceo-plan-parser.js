// Parse CEO plans into structured steps and resolve hired NPCs per step.

const PLAN_ROLE_MAP = {
  boss: 'boss',
  ceo: 'ceo',
  secretary: 'secretary',
  'marketing manager': 'marketing',
  marketing: 'marketing',
  marketing_manager: 'marketing',
  'marketing editor': 'marketing_editor',
  marketing_editor: 'marketing_editor',
  editor: 'marketing_editor',
  'marketing junior': 'marketing_junior',
  marketing_junior: 'marketing_junior',
  junior: 'marketing_junior',
  'graphic design': 'graphic_design',
  graphic_design: 'graphic_design',
  design: 'graphic_design',
  'product research': 'product_research',
  product_research: 'product_research',
  research: 'product_research',
  r_and_d: 'product_research',
  'accounting manager': 'accounting',
  accounting: 'accounting',
  'admin manager': 'admin',
  admin: 'admin',
  'customer service senior': 'customer_service',
  customer_service: 'customer_service',
  'sales senior': 'sales',
  sales: 'sales',
  'business development manager': 'business_development',
  business_development: 'business_development',
  'human resource': 'human_resource',
  hr: 'human_resource',
  'it coding': 'it',
  it: 'it',
  'it guys': 'it',
  it_guys: 'it',
  'cursor developer': 'it',
  cursor_developer: 'it',
  'claude developer': 'it',
  claude_developer: 'it',
  'codex developer': 'it',
  codex_developer: 'it',
};

const MANAGER_ROLES = new Set([
  'marketing',
  'accounting',
  'admin',
  'human_resource',
  'business_development',
]);

const HIRE_TEMPLATE_BY_ROLE = {
  marketing: 'marketing_manager',
  marketing_editor: 'marketing_editor',
  marketing_junior: 'marketing_junior',
  graphic_design: 'graphic_design',
  product_research: 'product_research',
  accounting: 'accounting_manager',
  admin: 'admin_manager',
  customer_service: 'customer_service_senior',
  sales: 'sales_senior',
  business_development: 'business_development_manager',
  human_resource: 'human_resource',
  it: 'cursor_developer',
};

function normalizePlanRoleLabel(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_');
}

function mapPlanLabelToRole(label) {
  const raw = String(label || '').trim();
  if (!raw) return null;
  const key = raw.toLowerCase();
  if (PLAN_ROLE_MAP[key]) return PLAN_ROLE_MAP[key];
  const snake = normalizePlanRoleLabel(raw);
  if (PLAN_ROLE_MAP[snake]) return PLAN_ROLE_MAP[snake];
  if (PLAN_ROLE_MAP[key.replace(/\s+/g, ' ')]) return PLAN_ROLE_MAP[key.replace(/\s+/g, ' ')];
  return snake || null;
}

function parsePlanSteps(plan) {
  const steps = [];
  const lines = String(plan || '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*-\s*\[[ xX]?\]\s*(?:\[(.+?)\]\s*)?(.+)$/);
    if (!m) continue;
    const roleLabel = (m[1] || '').trim();
    let instruction = (m[2] || '').trim();
    if (!instruction) continue;
    const hireMatch = instruction.match(/\bHIRE:\s*([a-z0-9_]+)/i);
    const role = roleLabel ? mapPlanLabelToRole(roleLabel) : null;
    const revisionMatch = instruction.match(/\bREVISION\s*(?:→|->)\s*\[(.+?)\]/i);
    const revisionRole = revisionMatch ? mapPlanLabelToRole(revisionMatch[1]) : null;
    const kind = /\bREVIEW\b/i.test(instruction)
      ? 'review'
      : revisionMatch
        ? 'review'
        : role === 'boss'
          ? 'boss'
          : 'execute';
    steps.push({
      roleLabel: roleLabel || null,
      role: role || (hireMatch ? hireMatch[1].toLowerCase() : null),
      instruction,
      hireOnly: !roleLabel && !!hireMatch,
      kind,
      revisionRole,
      raw: line.trim(),
    });
  }
  return steps;
}

function hiredAgents(office) {
  return (office?.state?.agents || []).filter((a) => a.userAgentId && !a.external);
}

function findHiredByRole(office, role, roster, findHiredAgentFor) {
  if (!role || role === 'boss' || role === 'ceo' || role === 'coo' || role === 'secretary') return null;
  const dept = roster.byRole(role);
  if (!dept) return hiredAgents(office).find((a) => a.role === role) || null;
  return findHiredAgentFor(dept);
}

function findMarketingWorkerFallback(office, instruction) {
  const hired = hiredAgents(office);
  const pick = (role) => hired.find((a) => a.role === role) || null;
  const text = String(instruction || '').toLowerCase();
  if (/publish|schedule|\bfb\b|facebook|xhs|小红书|upload|posting|post to/.test(text)) {
    return pick('marketing_junior') || pick('graphic_design');
  }
  if (/copy|write|draft|edit|caption|文案|润色/.test(text)) {
    return pick('marketing_editor');
  }
  if (/design|poster|image|visual|cover|banner|mockup/.test(text)) {
    return pick('graphic_design');
  }
  if (/research|competitor|rival|benchmark|market/.test(text)) {
    return pick('product_research');
  }
  return pick('marketing_junior') || pick('marketing_editor') || pick('graphic_design');
}

function findDepartmentWorkerFallback(office, managerRole, instruction) {
  if (managerRole === 'marketing') {
    return findMarketingWorkerFallback(office, instruction);
  }
  return null;
}

function resolveStepAgent(step, { office, roster, findHiredAgentFor }) {
  const role = step.role;
  if (!role) {
    return { agent: null, reason: 'unknown_role', message: `Could not parse role for step: ${step.raw}` };
  }
  if (role === 'boss') {
    return {
      agent: null,
      reason: 'boss',
      message: `BOSS step — please complete: ${step.instruction}`,
    };
  }
  if (role === 'ceo' || role === 'coo' || role === 'secretary') {
    return { agent: null, reason: 'forbidden', message: `Step cannot target ${role}.` };
  }

  let agent = findHiredByRole(office, role, roster, findHiredAgentFor);
  let downgraded = false;
  if (!agent && MANAGER_ROLES.has(role)) {
    agent = findDepartmentWorkerFallback(office, role, step.instruction);
    downgraded = !!agent;
  }

  if (agent) {
    return { agent, reason: null, downgraded, message: null };
  }

  const templateId = HIRE_TEMPLATE_BY_ROLE[role] || role;
  return {
    agent: null,
    reason: 'hire',
    hireTemplate: templateId,
    message:
      `HIRE: ${templateId} — no hired worker for [${step.roleLabel || role}]. ` +
      `Browse → hire ${step.roleLabel || role}, then ask CEO to continue.\n` +
      `Step: ${step.instruction}`,
  };
}

module.exports = {
  PLAN_ROLE_MAP,
  parsePlanSteps,
  mapPlanLabelToRole,
  resolveStepAgent,
  findDepartmentWorkerFallback,
  HIRE_TEMPLATE_BY_ROLE,
};
