export type DeliverableKind = 'plan_complete' | 'daily_report' | 'alert' | 'job'

export type DeliverableStatus = 'pending' | 'in_progress' | 'complete'

export interface DeliverablePlanStep {
  id: string
  label: string
  done: boolean
}

export interface DeliverableStandupSection {
  agentId?: string | null
  role?: string | null
  label: string
  text: string
  voice?: {
    engine?: string
    ttsVoice?: string
    profileId?: string
  } | null
  followUps?: Array<{ text: string; answer?: string; at?: number }>
}

export interface DeliverableReportPeriod {
  from: number
  to: number
  label: string
}

export interface DeliverableItem {
  id: string
  kind: DeliverableKind
  summary: string
  task?: string
  agentLabel?: string
  agentId?: string | null
  department?: string | null
  departmentLabel?: string
  status?: DeliverableStatus
  progressPercent?: number | null
  planSteps?: DeliverablePlanStep[]
  standupSections?: DeliverableStandupSection[]
  reportPeriod?: DeliverableReportPeriod | null
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

export function deliverableDepartmentLabel(item: DeliverableItem): string {
  if (item.departmentLabel) return item.departmentLabel
  if (item.standupSections && item.standupSections.length > 1) return 'Multi-department'
  if (item.agentLabel) return item.agentLabel
  return 'Office'
}

export function deliverableProgressDisplay(item: DeliverableItem): number | null {
  if (item.status === 'complete' || item.kind === 'plan_complete') return 100
  if (typeof item.progressPercent === 'number') return item.progressPercent
  const steps = item.planSteps || []
  if (!steps.length) return null
  const done = steps.filter((s) => s.done).length
  return Math.round((done / steps.length) * 100)
}

export function startOfLocalDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function isSameLocalDay(a: number, b: number): boolean {
  return startOfLocalDay(a) === startOfLocalDay(b)
}
