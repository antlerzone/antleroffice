export type BillingInterval = 'daily' | 'monthly' | 'quarterly' | 'yearly'

export type BillingCreditsByInterval = Partial<Record<BillingInterval, number>>

export const BILLING_INTERVALS: BillingInterval[] = ['daily', 'monthly', 'quarterly', 'yearly']

/** Fallback marketing copy when no per-template override prices exist. */
export const INTERVAL_DISPLAY_SAVINGS: Record<BillingInterval, string | null> = {
  daily: null,
  monthly: '−50%',
  quarterly: '−60%',
  yearly: '−70%',
}

const PERIOD_DAYS: Record<BillingInterval, number> = {
  daily: 1,
  monthly: 30,
  quarterly: 90,
  yearly: 365,
}

export function normalizeBillingInterval(raw: unknown): BillingInterval {
  const v = String(raw || 'monthly').trim().toLowerCase()
  if (v === 'quarter') return 'quarterly'
  return (BILLING_INTERVALS as string[]).includes(v) ? (v as BillingInterval) : 'monthly'
}

export function creditsPerPeriod(
  monthlyCredits: number,
  interval: BillingInterval | string,
  billingCreditsByInterval?: BillingCreditsByInterval | null,
): number {
  const bill = normalizeBillingInterval(interval)
  const override = billingCreditsByInterval?.[bill]
  if (Number.isFinite(override) && Number(override) > 0) {
    return Math.floor(Number(override))
  }
  const monthly = Math.max(0, Math.floor(Number(monthlyCredits) || 0))
  if (monthly <= 0) return 0
  if (bill === 'daily') return Math.max(1, Math.ceil((monthly / 30) * 1.5))
  if (bill === 'quarterly') return Math.max(1, Math.ceil(monthly * 3 * 0.95))
  if (bill === 'yearly') return Math.max(1, Math.ceil(monthly * 12 * 0.9))
  return monthly
}

/** Strikethrough reference: same period at the Daily rate (customer baseline). */
export function listCreditsPerPeriod(
  monthlyCredits: number,
  interval: BillingInterval | string,
  billingCreditsByInterval?: BillingCreditsByInterval | null,
): number {
  const bill = normalizeBillingInterval(interval)
  if (monthlyCredits <= 0 && !billingCreditsByInterval) return 0
  const dailyRate = creditsPerPeriod(monthlyCredits, 'daily', billingCreditsByInterval)
  return dailyRate * PERIOD_DAYS[bill]
}

export function intervalLabel(interval: BillingInterval | string): string {
  const bill = normalizeBillingInterval(interval)
  if (bill === 'daily') return 'day'
  if (bill === 'quarterly') return 'quarter'
  if (bill === 'yearly') return 'year'
  return 'month'
}

export function intervalTabLabel(interval: BillingInterval | string): string {
  const bill = normalizeBillingInterval(interval)
  if (bill === 'daily') return 'Daily'
  if (bill === 'quarterly') return 'Quarterly'
  if (bill === 'yearly') return 'Yearly'
  return 'Monthly'
}

export function firstChargeLabel(interval: BillingInterval | string): string {
  const bill = normalizeBillingInterval(interval)
  if (bill === 'daily') return 'First day'
  if (bill === 'quarterly') return 'First quarter'
  if (bill === 'yearly') return 'First year'
  return 'First month'
}

/** Savings badge beside "(charged today)" — derived from prices when available. */
export function intervalChargeAdjustment(
  interval: BillingInterval | string,
  monthlyCredits = 0,
  billingCreditsByInterval?: BillingCreditsByInterval | null,
): string | null {
  const bill = normalizeBillingInterval(interval)
  if (bill === 'daily') return null
  const list = listCreditsPerPeriod(monthlyCredits, bill, billingCreditsByInterval)
  const charge = creditsPerPeriod(monthlyCredits, bill, billingCreditsByInterval)
  if (list > charge) {
    const pct = Math.round((1 - charge / list) * 100)
    if (pct > 0) return `−${pct}%`
  }
  return INTERVAL_DISPLAY_SAVINGS[bill]
}
