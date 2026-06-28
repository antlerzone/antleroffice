export const TZ = 'Asia/Singapore'

export function formatPeriod(ms = Date.now()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
  })
  const parts = fmt.formatToParts(new Date(ms))
  const year = parts.find((p) => p.type === 'year')?.value
  const month = parts.find((p) => p.type === 'month')?.value
  return `${year}-${month}`
}

export function previousCalendarMonth(ms = Date.now()): string {
  const [y = 0, m = 0] = formatPeriod(ms).split('-').map(Number)
  let year = y
  let month = m - 1
  if (month < 1) {
    month = 12
    year -= 1
  }
  return `${year}-${String(month).padStart(2, '0')}`
}

export function shiftPeriod(period: string, delta: number): string {
  const [y = 0, m = 0] = period.split('-').map(Number)
  let year = y
  let month = m + delta
  while (month < 1) {
    month += 12
    year -= 1
  }
  while (month > 12) {
    month -= 12
    year += 1
  }
  return `${year}-${String(month).padStart(2, '0')}`
}

export function formatPeriodLabel(period: string): string {
  const [y = 0, m = 0] = period.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1, 1))
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export function isFuturePeriod(period: string, now = Date.now()): boolean {
  return period > formatPeriod(now)
}

export type PayslipEntry = {
  id: string
  at: number
  type: string
  amount: number
  balanceAfter: number
  reason: string
  subscriptionId?: string | null
  departmentId?: string | null
  agentName?: string | null
  source?: string
}

export type PayslipResponse = {
  ok: boolean
  period: string
  openingBalance: number
  closingBalance: number
  totalDebit: number
  totalCredit: number
  page: number
  pageSize: number
  totalEntries: number
  entries: PayslipEntry[]
}

export function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function printPayslipPdf(title: string, html: string) {
  const w = window.open('', '_blank', 'width=900,height=700')
  if (!w) return
  w.document.write(`<!DOCTYPE html><html><head><title>${title}</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 24px; color: #111; }
      h1 { font-size: 18px; margin: 0 0 8px; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 16px; }
      th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
      th { background: #f5f5f5; }
      .summary { display: flex; gap: 24px; flex-wrap: wrap; margin: 12px 0; font-size: 13px; }
    </style></head><body>${html}</body></html>`)
  w.document.close()
  w.focus()
  w.print()
}
