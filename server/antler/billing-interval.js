const BILLING_INTERVALS = ['daily', 'monthly', 'quarterly', 'yearly', 'paygo'];

/** Pay-as-you-go default; role-tier overrides may apply at charge time. */
const PAYGO_CREDITS_PER_HOUR = 3;

function normalizeBillingInterval(raw) {
  const v = String(raw || 'monthly').trim().toLowerCase();
  if (v === 'quarter') return 'quarterly';
  if (v === 'pay-as-you-go' || v === 'pay_as_you_go' || v === 'usage') return 'paygo';
  return BILLING_INTERVALS.includes(v) ? v : 'monthly';
}

function isPaygo(interval) {
  return normalizeBillingInterval(interval) === 'paygo';
}

/**
 * @param {number} yearlyAnchorMonthly - Sticker monthly price with annual hire (1 credit = $1 USD).
 */
function creditsPerPeriod(yearlyAnchorMonthly, interval, billingCreditsByInterval) {
  const bill = normalizeBillingInterval(interval);
  if (bill === 'paygo') return 0;
  const overrides = billingCreditsByInterval && typeof billingCreditsByInterval === 'object'
    ? billingCreditsByInterval
    : null;
  if (overrides && Number.isFinite(Number(overrides[bill])) && Number(overrides[bill]) >= 0) {
    return Math.floor(Number(overrides[bill]));
  }
  const anchor = Math.max(0, Math.floor(Number(yearlyAnchorMonthly) || 0));
  if (anchor <= 0) return 0;
  if (bill === 'daily') return Math.max(1, Math.ceil((anchor / 30) * 2));
  if (bill === 'quarterly') return Math.max(1, Math.ceil(anchor * 3 * 1.1));
  if (bill === 'yearly') return Math.max(1, Math.ceil(anchor * 12));
  if (bill === 'monthly') return Math.max(1, Math.ceil(anchor * 1.25));
  return anchor;
}

function addBillingPeriod(fromMs, interval) {
  const bill = normalizeBillingInterval(interval);
  if (bill === 'paygo') return null;
  const d = new Date(fromMs);
  if (bill === 'daily') {
    d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  if (bill === 'yearly') {
    d.setFullYear(d.getFullYear() + 1);
    return d.getTime();
  }
  const months = bill === 'quarterly' ? 3 : 1;
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0);
  return d.getTime();
}

function intervalLabel(interval) {
  const bill = normalizeBillingInterval(interval);
  if (bill === 'paygo') return 'hour (subagent work)';
  if (bill === 'daily') return 'day';
  if (bill === 'quarterly') return 'quarter';
  if (bill === 'yearly') return 'year';
  return 'month';
}

function firstChargeReason(interval) {
  const bill = normalizeBillingInterval(interval);
  if (bill === 'paygo') return 'hire_paygo';
  if (bill === 'daily') return 'hire_first_day';
  if (bill === 'quarterly') return 'hire_first_quarter';
  if (bill === 'yearly') return 'hire_first_year';
  return 'hire_first_month';
}

module.exports = {
  BILLING_INTERVALS,
  PAYGO_CREDITS_PER_HOUR,
  normalizeBillingInterval,
  isPaygo,
  creditsPerPeriod,
  addBillingPeriod,
  intervalLabel,
  firstChargeReason,
};
