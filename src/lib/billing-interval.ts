export type BillingInterval = 'daily' | 'monthly' | 'quarterly' | 'yearly' | 'paygo'

export type BillingCreditsByInterval = Partial<Record<BillingInterval, number>>

export const BILLING_INTERVALS: BillingInterval[] = ['daily', 'monthly', 'quarterly', 'yearly', 'paygo']

/** Pay-as-you-go default; role-tier overrides may apply at charge time. */
export const PAYGO_CREDITS_PER_HOUR = 3

/** Fallback when list vs charge savings cannot be computed. */
export const INTERVAL_DISPLAY_SAVINGS: Record<BillingInterval, string | null> = {
  daily: null,
  monthly: null,
  quarterly: null,
  yearly: 'Best value',
  paygo: 'Premium flexibility',
}

const PERIOD_DAYS: Record<Exclude<BillingInterval, 'paygo'>, number> = {
  daily: 1,
  monthly: 30,
  quarterly: 90,
  yearly: 365,
}

export function normalizeBillingInterval(raw: unknown): BillingInterval {
  const v = String(raw || 'monthly').trim().toLowerCase()
  if (v === 'quarter') return 'quarterly'
  if (v === 'pay-as-you-go' || v === 'pay_as_you_go' || v === 'usage') return 'paygo'
  return (BILLING_INTERVALS as string[]).includes(v) ? (v as BillingInterval) : 'monthly'
}

export function isPaygo(interval: BillingInterval | string): boolean {
  return normalizeBillingInterval(interval) === 'paygo'
}

/** yearlyAnchorMonthly = sticker monthly price with annual hire (1 credit = $1 USD). */
export function creditsPerPeriod(
  yearlyAnchorMonthly: number,
  interval: BillingInterval | string,
  billingCreditsByInterval?: BillingCreditsByInterval | null,
): number {
  const bill = normalizeBillingInterval(interval)
  if (bill === 'paygo') return 0
  const override = billingCreditsByInterval?.[bill]
  if (Number.isFinite(override) && Number(override)! >= 0) {
    return Math.floor(Number(override))
  }
  const anchor = Math.max(0, Math.floor(Number(yearlyAnchorMonthly) || 0))
  if (anchor <= 0) return 0
  if (bill === 'daily') return Math.max(1, Math.ceil((anchor / 30) * 2))
  if (bill === 'quarterly') return Math.max(1, Math.ceil(anchor * 3 * 1.1))
  if (bill === 'yearly') return Math.max(1, Math.ceil(anchor * 12))
  if (bill === 'monthly') return Math.max(1, Math.ceil(anchor * 1.25))
  return anchor
}

/** Strikethrough reference: same period at the Daily rate (flexibility premium baseline). */
export function listCreditsPerPeriod(
  yearlyAnchorMonthly: number,
  interval: BillingInterval | string,
  billingCreditsByInterval?: BillingCreditsByInterval | null,
): number {
  const bill = normalizeBillingInterval(interval)
  if (bill === 'paygo') return 0
  if (yearlyAnchorMonthly <= 0 && !billingCreditsByInterval) return 0
  const dailyRate = creditsPerPeriod(yearlyAnchorMonthly, 'daily', billingCreditsByInterval)
  return dailyRate * PERIOD_DAYS[bill]
}

export function intervalLabel(interval: BillingInterval | string): string {
  const bill = normalizeBillingInterval(interval)
  if (bill === 'paygo') return 'hour (subagent work)'
  if (bill === 'daily') return 'day'
  if (bill === 'quarterly') return 'quarter'
  if (bill === 'yearly') return 'year'
  return 'month'
}

export function intervalTabLabel(interval: BillingInterval | string): string {
  const bill = normalizeBillingInterval(interval)
  if (bill === 'paygo') return 'Pay as you go'
  if (bill === 'daily') return 'Daily'
  if (bill === 'quarterly') return 'Quarterly'
  if (bill === 'yearly') return 'Yearly'
  return 'Monthly'
}

export function paygoRateLabel(): string {
  return `${PAYGO_CREDITS_PER_HOUR} credits/hr · subagent work only`
}

export function firstChargeLabel(interval: BillingInterval | string): string {
  const bill = normalizeBillingInterval(interval)
  if (bill === 'paygo') return 'Upfront charge'
  if (bill === 'daily') return 'First day'
  if (bill === 'quarterly') return 'First quarter'
  if (bill === 'yearly') return 'First year'
  return 'First month'
}

/** Savings badge beside "(charged today)" — derived from daily baseline when available. */
export function intervalChargeAdjustment(
  interval: BillingInterval | string,
  yearlyAnchorMonthly = 0,
  billingCreditsByInterval?: BillingCreditsByInterval | null,
): string | null {
  const bill = normalizeBillingInterval(interval)
  if (bill === 'paygo') return INTERVAL_DISPLAY_SAVINGS.paygo
  if (bill === 'daily') return null
  const list = listCreditsPerPeriod(yearlyAnchorMonthly, bill, billingCreditsByInterval)
  const charge = creditsPerPeriod(yearlyAnchorMonthly, bill, billingCreditsByInterval)
  if (list > charge) {
    const pct = Math.round((1 - charge / list) * 100)
    if (pct > 0) return `−${pct}%`
  }
  return INTERVAL_DISPLAY_SAVINGS[bill]
}
