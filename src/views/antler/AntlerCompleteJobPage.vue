<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  NButton,
  NDataTable,
  NModal,
  NProgress,
  NSpace,
  NTag,
  NText,
  useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useCompleteJobFilters } from '@/composables/useCompleteJobFilters'
import CompleteJobToolbar from '@/components/complete-job/CompleteJobToolbar.vue'
import CompleteJobKanban from '@/components/complete-job/CompleteJobKanban.vue'
import { useStandupPlayback } from '@/composables/useStandupPlayback'
import { showItemInFolder } from '@/lib/desktop-shell'
import {
  DELIVERABLE_KIND_META,
  deliverableDepartmentLabel,
  deliverableProgressDisplay,
  type DeliverableItem,
} from '@/lib/deliverable-meta'

const api = useAntlerApi()
const message = useMessage()
const { t } = useI18n()
const { start: startStandupPlayback, stopPlayback, isActive: standupPlaying } = useStandupPlayback()

const items = ref<DeliverableItem[]>([])
const loading = ref(false)
const detailOpen = ref(false)
const detail = ref<DeliverableItem | null>(null)
const exportingPdf = ref(false)

const {
  searchQuery,
  filterExpanded,
  selectedDay,
  kindFilter,
  departmentFilter,
  statusFilter,
  dayLabel,
  departmentOptions,
  filteredRows,
  shiftDay,
  goToday,
} = useCompleteJobFilters(() => items.value)

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function kindMeta(kind: DeliverableItem['kind']) {
  return DELIVERABLE_KIND_META[kind] || DELIVERABLE_KIND_META.job
}

async function refresh() {
  loading.value = true
  try {
    const r = await api.get<{ deliverables?: DeliverableItem[] }>('/api/deliverables')
    items.value = r.deliverables || []
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('completeJob.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function openDetail(row: DeliverableItem) {
  try {
    const r = await api.get<{ deliverable?: DeliverableItem }>(`/api/deliverables/${row.id}`)
    detail.value = r.deliverable || null
    detailOpen.value = !!detail.value
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('completeJob.openFailed'))
  }
}

async function forward(id: string, ev?: Event) {
  ev?.stopPropagation()
  try {
    await api.send('POST', `/api/deliverables/${id}/forward`, {})
    await refresh()
    message.success(t('completeJob.forwardSuccess'))
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('completeJob.forwardFailed'))
  }
}

async function acknowledgeCeoDecision(row: DeliverableItem) {
  try {
    await api.send('POST', `/api/deliverables/${row.id}/acknowledge-ceo-decision`, {})
    await refresh()
    message.success(t('completeJob.acknowledgeSuccess'))
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('completeJob.acknowledgeFailed'))
  }
}

let deliverablesEvents: EventSource | null = null

function connectDeliverablesEvents() {
  deliverablesEvents?.close()
  try {
    deliverablesEvents = new EventSource('/api/office/events')
    deliverablesEvents.addEventListener('deliverables', () => {
      void refresh()
    })
    deliverablesEvents.addEventListener('ceoDecision', () => {
      void refresh()
    })
  } catch {
    /* SSE optional */
  }
}

onMounted(() => {
  void refresh()
  connectDeliverablesEvents()
})

onUnmounted(() => {
  deliverablesEvents?.close()
  deliverablesEvents = null
})

async function playStandup() {
  if (!detail.value?.standupSections?.length) return
  try {
    await startStandupPlayback(detail.value)
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('completeJob.playFailed'))
  }
}

async function exportPdf() {
  if (!detail.value) return
  exportingPdf.value = true
  try {
    const res = await api.send<{ ok?: boolean; fileName?: string; path?: string; error?: string }>(
      'POST',
      `/api/department-standup/${encodeURIComponent(detail.value.id)}/export-pdf`,
      {},
    )
    if (res.path) showItemInFolder(res.path)
    message.success(t('completeJob.exportPdfSuccess', { file: res.fileName || 'report.pdf' }))
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('completeJob.exportPdfFailed'))
  } finally {
    exportingPdf.value = false
  }
}

const columns = computed<DataTableColumns<DeliverableItem>>(() => [
  {
    title: t('completeJob.colDepartment'),
    key: 'department',
    minWidth: 140,
    render(row) {
      return deliverableDepartmentLabel(row)
    },
  },
  {
    title: t('completeJob.colType'),
    key: 'kind',
    width: 140,
    render(row) {
      const meta = kindMeta(row.kind)
      return h(NSpace, { size: 4, align: 'center' }, () => [
        h('span', null, meta.icon),
        h(NText, { style: 'font-size: 13px' }, { default: () => meta.label }),
      ])
    },
  },
  {
    title: t('completeJob.colSummary'),
    key: 'summary',
    minWidth: 240,
    ellipsis: { tooltip: true },
    render(row) {
      return row.summary
    },
  },
  {
    title: t('completeJob.colProgress'),
    key: 'progress',
    width: 120,
    render(row) {
      const pct = deliverableProgressDisplay(row)
      if (pct === null) return t('completeJob.progressNone')
      if (row.status === 'in_progress' || (pct > 0 && pct < 100)) {
        return h(NSpace, { vertical: true, size: 2, style: 'width: 100%' }, () => [
          h(NProgress, { type: 'line', percentage: pct, showIndicator: false, height: 6 }),
          h(NText, { depth: 3, style: 'font-size: 11px' }, { default: () => `${pct}%` }),
        ])
      }
      return pct === 100 ? '100%' : t('completeJob.progressNone')
    },
  },
  {
    title: t('completeJob.colTime'),
    key: 'time',
    width: 88,
    render(row) {
      return fmtTime(row.createdAt)
    },
  },
  {
    title: t('completeJob.colActions'),
    key: 'actions',
    width: 120,
    render(row) {
      return h(
        NButton,
        {
          size: 'small',
          quaternary: true,
          onClick: (e: MouseEvent) => {
            e.stopPropagation()
            void forward(row.id, e)
          },
        },
        { default: () => (row.forwarded ? t('completeJob.forwarded') : t('completeJob.forward')) },
      )
    },
  },
])

const detailSections = computed(() => {
  const d = detail.value
  if (!d) return []
  if (d.standupSections?.length) {
    return d.standupSections.map((s) => ({
      title: s.label,
      body: s.text,
      followUps: s.followUps || [],
    }))
  }
  if (d.planSteps?.length) {
    return [
      {
        title: d.summary,
        body: d.planSteps.map((s) => `${s.done ? '✓' : '○'} ${s.label}`).join('\n'),
        followUps: [] as { text: string; answer?: string; at?: number }[],
      },
    ]
  }
  return [
    {
      title: kindMeta(d.kind).label,
      body: d.content || d.task || d.summary,
      followUps: [] as { text: string; answer?: string; at?: number }[],
    },
  ]
})

watch(detailOpen, (open) => {
  if (!open) void stopPlayback()
})
</script>

<template>
  <div class="antler-v1-root complete-job-page">
    <div class="view-head">
      <h1 class="view-title">{{ t('completeJob.title') }}</h1>
    </div>

    <p class="hint">{{ t('completeJob.hint') }}</p>

    <div class="summary-legend">
      <span class="legend-item tone-plan">{{ t('completeJob.legendPlan') }}</span>
      <span class="legend-item tone-report">{{ t('completeJob.legendReport') }}</span>
      <span class="legend-item tone-alert">{{ t('completeJob.legendAlert') }}</span>
    </div>

    <CompleteJobToolbar
      :search-query="searchQuery"
      @update:search-query="searchQuery = $event"
      :filter-expanded="filterExpanded"
      :day-label="dayLabel"
      :selected-day="selectedDay"
      :kind-filter="kindFilter"
      :department-filter="departmentFilter"
      :status-filter="statusFilter"
      :department-options="departmentOptions"
      @update:kind-filter="kindFilter = $event"
      @update:department-filter="departmentFilter = $event"
      @update:status-filter="statusFilter = $event"
      @toggle-filter="filterExpanded = !filterExpanded"
      @prev-day="shiftDay(-1)"
      @next-day="shiftDay(1)"
      @go-today="goToday()"
    />

    <CompleteJobKanban
      :rows="filteredRows"
      :loading="loading"
      @open="openDetail"
      @forward="(row) => forward(row.id)"
      @acknowledge="(row) => acknowledgeCeoDecision(row)"
    />

    <p v-if="!loading && !filteredRows.length" class="hint empty-hint">
      {{ t('completeJob.noRows') }}
    </p>

    <NModal
      v-model:show="detailOpen"
      preset="card"
      :title="detail ? kindMeta(detail.kind).label : t('completeJob.view')"
      style="max-width: 720px"
    >
      <template v-if="detail">
        <NSpace vertical :size="12">
          <NSpace :size="8" wrap>
            <NTag size="small" round>{{ deliverableDepartmentLabel(detail) }}</NTag>
            <NTag v-if="detail.reportPeriod?.label" size="small" round type="info">
              {{ detail.reportPeriod.label }}
            </NTag>
            <NTag v-if="detail.status" size="small" round>{{ detail.status }}</NTag>
          </NSpace>

          <NProgress
            v-if="deliverableProgressDisplay(detail) !== null && detail.status === 'in_progress'"
            type="line"
            :percentage="deliverableProgressDisplay(detail) || 0"
          />

          <NText strong style="font-size: 16px">{{ detail.summary }}</NText>
          <NText v-if="detail.task" depth="3">{{ t('completeJob.detailTask') }}: {{ detail.task }}</NText>

          <div class="detail-sections">
            <div v-for="(sec, i) in detailSections" :key="i" class="detail-section">
              <NText strong tag="div" class="section-title">{{ sec.title }}</NText>
              <pre class="section-body">{{ sec.body }}</pre>
              <ul v-if="sec.followUps.length" class="follow-ups">
                <li v-for="(fu, j) in sec.followUps" :key="j">
                  <strong>Q:</strong> {{ fu.text }}
                  <div v-if="fu.answer"><strong>A:</strong> {{ fu.answer }}</div>
                </li>
              </ul>
            </div>
          </div>
        </NSpace>
      </template>
      <template #footer>
        <NSpace>
          <NButton
            v-if="detail?.standupSections?.length && !standupPlaying"
            type="primary"
            @click="playStandup"
          >
            {{ t('completeJob.playStandup') }}
          </NButton>
          <NButton
            v-if="detail?.standupSections?.length && standupPlaying"
            type="warning"
            @click="stopPlayback"
          >
            {{ t('completeJob.stopStandup') }}
          </NButton>
          <NButton
            v-if="detail?.standupSections?.length"
            :loading="exportingPdf"
            @click="exportPdf"
          >
            {{ t('completeJob.exportPdf') }}
          </NButton>
          <NButton @click="detailOpen = false">{{ t('completeJob.close') }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.complete-job-page {
  padding-bottom: 24px;
}
.view-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.view-title {
  margin: 0;
  font-size: 24px;
}
.summary-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 14px;
}
.legend-item {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--line);
}
.tone-plan {
  border-color: rgba(70, 209, 96, 0.35);
}
.tone-report {
  border-color: rgba(32, 128, 240, 0.35);
}
.tone-alert {
  border-color: rgba(240, 128, 80, 0.45);
}
.hint {
  color: var(--muted);
  font-size: 14px;
  margin: 0 0 12px;
}
.empty-hint {
  margin-top: 16px;
  text-align: center;
}
.complete-job-table {
  margin-top: 4px;
}
.detail-sections {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: 420px;
  overflow: auto;
}
.detail-section {
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: rgba(0, 0, 0, 0.12);
}
.section-title {
  margin-bottom: 8px;
}
.section-body {
  white-space: pre-wrap;
  font-size: 13px;
  margin: 0;
  font-family: inherit;
}
.follow-ups {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 13px;
}
</style>
