export type DeliverableKind = 'plan_complete' | 'daily_report' | 'alert' | 'job'

export interface DeliverableItem {
  id: string
  kind: DeliverableKind
  summary: string
  task?: string
  agentLabel?: string
  createdAt: number
  forwarded?: boolean
  content?: string
}

export const SUMMARY_KINDS: DeliverableKind[] = ['plan_complete', 'daily_report', 'alert']

export const DELIVERABLE_KIND_META: Record<
  DeliverableKind,
  { label: string; icon: string; tone: string }
> = {
  plan_complete: { label: 'Plan ready', icon: '📋', tone: 'plan' },
  daily_report: { label: 'Daily report', icon: '📊', tone: 'report' },
  alert: { label: 'Needs attention', icon: '🔔', tone: 'alert' },
  job: { label: 'Work completed', icon: '✓', tone: 'job' },
}

export function isBossSummary(item: DeliverableItem) {
  return SUMMARY_KINDS.includes(item.kind)
}
