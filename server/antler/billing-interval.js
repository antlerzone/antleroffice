const BILLING_INTERVALS = ['daily', 'monthly', 'quarterly', 'yearly'];

function normalizeBillingInterval(raw) {
  const v = String(raw || 'monthly').trim().toLowerCase();
  if (v === 'quarter') return 'quarterly';
  return BILLING_INTERVALS.includes(v) ? v : 'monthly';
}

function creditsPerPeriod(monthlyCredits, interval, billingCreditsByInterval) {
  const bill = normalizeBillingInterval(interval);
  const overrides = billingCreditsByInterval && typeof billingCreditsByInterval === 'object'
    ? billingCreditsByInterval
    : null;
  if (overrides && Number.isFinite(Number(overrides[bill])) && Number(overrides[bill]) > 0) {
    return Math.floor(Number(overrides[bill]));
  }
  const monthly = Math.max(0, Math.floor(Number(monthlyCredits) || 0));
  if (monthly <= 0) return 0;
  if (bill === 'daily') return Math.max(1, Math.ceil((monthly / 30) * 1.5));
  if (bill === 'quarterly') return Math.max(1, Math.ceil(monthly * 3 * 0.95));
  if (bill === 'yearly') return Math.max(1, Math.ceil(monthly * 12 * 0.9));
  return monthly;
}

function addBillingPeriod(fromMs, interval) {
  const bill = normalizeBillingInterval(interval);
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
  if (bill === 'daily') return 'day';
  if (bill === 'quarterly') return 'quarter';
  if (bill === 'yearly') return 'year';
  return 'month';
}

function firstChargeReason(interval) {
  const bill = normalizeBillingInterval(interval);
  if (bill === 'daily') return 'hire_first_day';
  if (bill === 'quarterly') return 'hire_first_quarter';
  if (bill === 'yearly') return 'hire_first_year';
  return 'hire_first_month';
}

module.exports = {
  BILLING_INTERVALS,
  normalizeBillingInterval,
  creditsPerPeriod,
  addBillingPeriod,
  intervalLabel,
  firstChargeReason,
};
