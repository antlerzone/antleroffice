<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { NModal, NButton, useMessage } from 'naive-ui'
import { useAntlerApi } from '@/composables/useAntlerApi'
import {
  DELIVERABLE_KIND_META,
  isBossSummary,
  type DeliverableItem,
} from '@/lib/deliverable-meta'

const api = useAntlerApi()
const message = useMessage()

const viewMode = ref<'list' | 'grid'>('list')
const items = ref<DeliverableItem[]>([])
const loading = ref(false)
const detailOpen = ref(false)
const detail = ref<DeliverableItem | null>(null)

const summaries = computed(() => items.value.filter(isBossSummary))

function fmt(ts: number) {
  return new Date(ts).toLocaleString()
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
    message.error(e instanceof Error ? e.message : 'Could not load summaries')
  } finally {
    loading.value = false
  }
}

async function openDetail(id: string) {
  try {
    const r = await api.get<{ deliverable?: DeliverableItem }>(`/api/deliverables/${id}`)
    detail.value = r.deliverable || null
    detailOpen.value = !!detail.value
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Could not open summary')
  }
}

async function forward(id: string) {
  try {
    await api.send('POST', `/api/deliverables/${id}/forward`, {})
    await refresh()
    message.success('Marked for forward')
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Forward failed')
  }
}

onMounted(() => refresh())
</script>

<template>
  <div class="antler-v1-root complete-job-page">
    <div class="view-head">
      <h1 class="view-title">Complete Job</h1>
      <div class="inline">
        <button
          type="button"
          class="btn ghost"
          :class="{ active: viewMode === 'list' }"
          @click="viewMode = 'list'"
        >
          List
        </button>
        <button
          type="button"
          class="btn ghost"
          :class="{ active: viewMode === 'grid' }"
          @click="viewMode = 'grid'"
        >
          Grid
        </button>
      </div>
    </div>

    <p class="hint">
      Boss summaries only — plans finished, daily reports, and alerts that need your attention. Not every chat reply.
    </p>

    <div class="summary-legend">
      <span class="legend-item tone-plan">📋 Plan ready</span>
      <span class="legend-item tone-report">📊 Daily report</span>
      <span class="legend-item tone-alert">🔔 Needs attention</span>
    </div>

    <p v-if="loading && !summaries.length" class="hint">Loading…</p>
    <p v-else-if="!summaries.length" class="hint">
      No summaries yet. Use Plan mode in Office, add a daily schedule, or wait for an alert.
    </p>

    <div v-else :class="viewMode === 'grid' ? 'jobs-grid' : 'jobs-list'">
      <div
        v-for="d in summaries"
        :key="d.id"
        class="job summary-card"
        :class="`tone-${kindMeta(d.kind).tone}`"
      >
        <div class="job-top">
          <span class="summary-kind">
            <span class="kind-icon">{{ kindMeta(d.kind).icon }}</span>
            {{ kindMeta(d.kind).label }}
          </span>
          <span class="when">{{ fmt(d.createdAt) }}</span>
        </div>
        <div class="summary-line">{{ d.summary }}</div>
        <div v-if="d.agentLabel" class="who">{{ d.agentLabel }}</div>
        <div class="job-actions">
          <button type="button" class="btn ghost sm" @click="openDetail(d.id)">View</button>
          <button
            type="button"
            class="btn ghost sm"
            :class="{ active: d.forwarded }"
            @click="forward(d.id)"
          >
            {{ d.forwarded ? '✓ Forwarded' : 'Forward to Telegram' }}
          </button>
        </div>
      </div>
    </div>

    <NModal
      v-model:show="detailOpen"
      preset="card"
      :title="detail ? kindMeta(detail.kind).label : 'Summary'"
      style="max-width: 640px"
    >
      <template v-if="detail">
        <p class="detail-summary">{{ detail.summary }}</p>
        <p v-if="detail.task" class="hint">Task: {{ detail.task }}</p>
        <pre v-if="detail.content" class="detail-body">{{ detail.content }}</pre>
      </template>
      <template #footer>
        <NButton @click="detailOpen = false">Close</NButton>
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
.jobs-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.jobs-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.summary-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 14px;
}
.summary-card.tone-plan {
  border-left: 3px solid var(--accent);
}
.summary-card.tone-report {
  border-left: 3px solid #2080f0;
}
.summary-card.tone-alert {
  border-left: 3px solid #f08050;
}
.job-top {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: flex-start;
  margin-bottom: 8px;
}
.summary-kind {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
.kind-icon {
  margin-right: 4px;
}
.when {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.summary-line {
  font-size: 15px;
  line-height: 1.45;
  margin-bottom: 6px;
}
.who {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 10px;
}
.job-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.detail-summary {
  font-size: 16px;
  margin: 0 0 12px;
}
.detail-body {
  white-space: pre-wrap;
  font-size: 13px;
  max-height: 360px;
  overflow: auto;
  margin: 12px 0 0;
  padding: 12px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid var(--line);
}
</style>
