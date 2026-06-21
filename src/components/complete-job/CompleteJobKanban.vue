<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NProgress, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  deliverableDepartmentLabel,
  deliverableProgressDisplay,
  type DeliverableItem,
} from '@/lib/deliverable-meta'

const props = defineProps<{
  rows: DeliverableItem[]
  loading?: boolean
}>()

const emit = defineEmits<{
  open: [row: DeliverableItem]
  forward: [row: DeliverableItem]
  acknowledge: [row: DeliverableItem]
}>()

const { t } = useI18n()

type ColumnKey =
  | 'ceo_inbox'
  | 'pending_ceo_decision'
  | 'coo_planning'
  | 'work'
  | 'done'
  | 'plan_complete'
  | 'daily_report'
  | 'alert'

const COLUMNS: { key: ColumnKey; title: string; tone: string }[] = [
  { key: 'ceo_inbox', title: 'CEO Inbox', tone: 'tone-inbox' },
  { key: 'pending_ceo_decision', title: 'Pending CEO Decision', tone: 'tone-ceo-decision' },
  { key: 'coo_planning', title: 'COO Planning', tone: 'tone-planning' },
  { key: 'work', title: 'Active work', tone: 'tone-work' },
  { key: 'done', title: 'Done', tone: 'tone-done' },
  { key: 'plan_complete', title: 'Plan ready', tone: 'tone-plan' },
  { key: 'daily_report', title: 'Daily report', tone: 'tone-report' },
  { key: 'alert', title: 'Needs attention', tone: 'tone-alert' },
]

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function columnForRow(row: DeliverableItem): ColumnKey | null {
  if (row.kind === 'ceo_decision' && row.status !== 'complete') return 'pending_ceo_decision'
  if (row.kind === 'ceo_inbox') return 'ceo_inbox'
  if (row.kind === 'coo_planning') return 'coo_planning'
  if (row.kind === 'plan_complete') {
    return row.status === 'pending' ? 'coo_planning' : 'plan_complete'
  }
  if (row.kind === 'job') {
    return row.status === 'complete' ? 'done' : 'work'
  }
  if (row.kind === 'daily_report') return 'daily_report'
  if (row.kind === 'it_scan') return 'alert'
  if (row.kind === 'alert') return 'alert'
  return null
}

const grouped = computed(() => {
  const map: Record<ColumnKey, DeliverableItem[]> = {
    ceo_inbox: [],
    pending_ceo_decision: [],
    coo_planning: [],
    work: [],
    done: [],
    plan_complete: [],
    daily_report: [],
    alert: [],
  }
  for (const row of props.rows) {
    const col = columnForRow(row)
    if (col) map[col].push(row)
  }
  return map
})
</script>

<template>
  <div class="complete-job-kanban" :class="{ loading }">
    <div v-for="col in COLUMNS" :key="col.key" class="kanban-col">
      <header class="kanban-col-head" :class="col.tone">
        <span>{{ col.title }}</span>
        <NTag size="small" round>{{ grouped[col.key]?.length || 0 }}</NTag>
      </header>
      <div class="kanban-col-body">
        <article
          v-for="row in grouped[col.key]"
          :key="row.id"
          class="kanban-card"
          :class="[col.tone, { 'needs-ack': row.kind === 'ceo_decision' && !row.ceoAcknowledged }]"
          role="button"
          tabindex="0"
          @click="emit('open', row)"
          @keyup.enter="emit('open', row)"
        >
          <div class="kanban-card-meta">
            <span class="kanban-dept">{{ deliverableDepartmentLabel(row) }}</span>
            <span class="kanban-time">{{ fmtTime(row.createdAt) }}</span>
          </div>

          <div v-if="row.kind === 'ceo_decision'" class="kanban-badges">
            <NTag v-if="!row.ceoAcknowledged" size="small" type="warning" round>
              {{ t('completeJob.ceoDecisionNeedsAck') }}
            </NTag>
            <NTag v-else size="small" type="success" round>
              {{ t('completeJob.ceoDecisionAcknowledged') }}
            </NTag>
          </div>

          <p class="kanban-summary">{{ row.summary || row.task || '—' }}</p>

          <div v-if="row.status === 'in_progress'" class="kanban-progress">
            <NProgress
              v-if="deliverableProgressDisplay(row) !== null"
              type="line"
              :percentage="deliverableProgressDisplay(row) || 0"
              :show-indicator="false"
              :height="4"
            />
            <span v-if="deliverableProgressDisplay(row) !== null" class="kanban-progress-label">
              {{ deliverableProgressDisplay(row) }}%
            </span>
          </div>

          <div class="kanban-card-foot">
            <NButton
              v-if="row.kind === 'ceo_decision' && !row.ceoAcknowledged"
              size="tiny"
              type="warning"
              secondary
              @click.stop="emit('acknowledge', row)"
            >
              {{ t('completeJob.acknowledgeCeoDecision') }}
            </NButton>
            <NButton size="tiny" quaternary @click.stop="emit('forward', row)">Forward</NButton>
          </div>
        </article>
        <p v-if="!grouped[col.key]?.length" class="kanban-empty">No items</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.complete-job-kanban {
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  gap: 12px;
  align-items: start;
}

@media (max-width: 1600px) {
  .complete-job-kanban {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

@media (max-width: 900px) {
  .complete-job-kanban {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.kanban-col {
  min-height: 120px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.12);
}

.kanban-col-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  font-weight: 600;
  font-size: 12px;
  border-bottom: 1px solid var(--line);
}

.kanban-col-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  max-height: 62vh;
  overflow-y: auto;
}

.kanban-card {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.03);
}

.kanban-card.needs-ack {
  border-color: rgba(240, 160, 60, 0.55);
  box-shadow: inset 0 0 0 1px rgba(240, 160, 60, 0.15);
}

.kanban-card:hover {
  border-color: rgba(255, 255, 255, 0.22);
}

.kanban-badges {
  margin-bottom: 6px;
}

.kanban-card-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  opacity: 0.75;
  margin-bottom: 6px;
}

.kanban-summary {
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.kanban-progress {
  margin-top: 8px;
}

.kanban-progress-label {
  font-size: 11px;
  opacity: 0.7;
}

.kanban-card-foot {
  margin-top: 8px;
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.kanban-empty {
  margin: 0;
  font-size: 12px;
  opacity: 0.55;
  text-align: center;
  padding: 12px 0;
}

.tone-inbox {
  border-color: rgba(255, 200, 80, 0.45);
}

.tone-ceo-decision {
  border-color: rgba(255, 140, 90, 0.55);
}

.tone-planning {
  border-color: rgba(100, 180, 255, 0.4);
}

.tone-work {
  border-color: rgba(180, 140, 255, 0.4);
}

.tone-done {
  border-color: rgba(120, 200, 140, 0.35);
}

.tone-plan {
  border-color: rgba(100, 180, 255, 0.35);
}

.tone-report {
  border-color: rgba(120, 200, 140, 0.35);
}

.tone-alert {
  border-color: rgba(240, 180, 60, 0.45);
}
</style>
