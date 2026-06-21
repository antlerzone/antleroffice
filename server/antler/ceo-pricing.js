// CEO salary scales with hired department workers: $1 USD (= 1 credit) per department per day.

const roster = require('./roster');

const CEO_BILLING_INTERVAL = 'daily';
/** Per hired department per day (USD = credits). */
const UNIT_USD_PER_DEPT_DAY = 1;

const ROUTABLE_ROLES = new Set(
  roster.DEPARTMENTS.filter((d) => d.routable).map((d) => d.role),
);

function isVipWorkerAgent(agent = {}) {
  const tid = String(agent.templateId || agent.departmentId || '');
  if (tid.startsWith('vip_')) return true;
  try {
    const portal = require('./portal-partner-oauth');
    const catalog = require('./agent-catalog');
    const t = catalog.getTemplate(tid);
    return t?.pricingModel === 'vip' || t?.hireTier === 'vip' || !!portal.partnerForTemplate(t || { id: tid });
  } catch {
    return false;
  }
}

function countHiredDepartmentRoles() {
  const registry = require('./registry-store');
  const roles = new Set();
  for (const a of registry.listAgents()) {
    if (!registry.isOnTeamAgent(a)) continue;
    if (a.role === 'ceo' || a.role === 'coo' || a.role === 'secretary') continue;
    if (isVipWorkerAgent(a)) continue;
    if (ROUTABLE_ROLES.has(a.role)) roles.add(a.role);
  }
  return roles.size;
}

/** Bill at least one department unit while CEO is on payroll. */
function billingDepartmentCount(explicit) {
  if (Number.isFinite(explicit)) return Math.max(1, Math.floor(explicit));
  return Math.max(1, countHiredDepartmentRoles());
}

/** Start of the next local calendar day (00:00) after fromMs. */
function nextLocalMidnightMs(fromMs = Date.now()) {
  const d = new Date(fromMs);
  d.setHours(0, 0, 0, 0);
  if (d.getTime() <= fromMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function buildCeoPricing(deptCount) {
  const n = billingDepartmentCount(deptCount);
  const dailyCredits = UNIT_USD_PER_DEPT_DAY * n;
  return {
    departmentCount: n,
    salaryCreditsPerMonth: dailyCredits * 30,
    salaryUsdPerMonth: dailyCredits * 30,
    billingCreditsByInterval: { daily: dailyCredits },
    unitUsdPerDay: UNIT_USD_PER_DEPT_DAY,
    pricingNote: `${n} dept${n === 1 ? '' : 's'} × $${UNIT_USD_PER_DEPT_DAY}/day (charged at midnight)`,
  };
}

function isPerDepartmentCeoTemplate(template = {}) {
  return (
    template.role === 'ceo'
    || template.pricingModel === 'per_department'
    || template.id === 'ceo'
  );
}

function applyCeoCatalogPricing(template = {}) {
  if (!isPerDepartmentCeoTemplate(template)) return template;
  const pricing = buildCeoPricing();
  return {
    ...template,
    pricingModel: 'per_department',
    billingInterval: CEO_BILLING_INTERVAL,
    billingIntervalLocked: true,
    salaryCreditsPerMonth: pricing.salaryCreditsPerMonth,
    salaryUsdPerMonth: pricing.salaryUsdPerMonth,
    billingCreditsByInterval: pricing.billingCreditsByInterval,
    ceoDepartmentCount: pricing.departmentCount,
    ceoUnitBilling: { daily: pricing.unitUsdPerDay },
    ceoPricingNote: pricing.pricingNote,
  };
}

function findHiredCeoAgent() {
  const registry = require('./registry-store');
  const orgRoles = require('./org-roles');
  return (
    registry.listAgents().find(
      (a) => orgRoles.isCooRole(a.role) && a.templateId && registry.isOnTeamAgent(a),
    ) || null
  );
}

function syncHiredCeoAgent() {
  const registry = require('./registry-store');
  const ceo = findHiredCeoAgent();
  if (!ceo) return null;
  const pricing = buildCeoPricing();
  const patch = {
    salaryCreditsPerMonth: pricing.salaryCreditsPerMonth,
    salaryUsdPerMonth: pricing.salaryUsdPerMonth,
    billingCreditsByInterval: pricing.billingCreditsByInterval,
    ceoDepartmentCount: pricing.departmentCount,
    billingInterval: CEO_BILLING_INTERVAL,
  };
  if (ceo.billingInterval !== CEO_BILLING_INTERVAL) {
    patch.nextSalaryDueAt = nextLocalMidnightMs(Date.now());
  } else if (ceo.payrollStatus === 'active' && typeof ceo.nextSalaryDueAt !== 'number') {
    patch.nextSalaryDueAt = nextLocalMidnightMs(Date.now());
  }
  return registry.updateAgent(ceo.id, patch);
}

module.exports = {
  CEO_BILLING_INTERVAL,
  UNIT_USD_PER_DEPT_DAY,
  countHiredDepartmentRoles,
  billingDepartmentCount,
  nextLocalMidnightMs,
  buildCeoPricing,
  isPerDepartmentCeoTemplate,
  applyCeoCatalogPricing,
  syncHiredCeoAgent,
  findHiredCeoAgent,
};
