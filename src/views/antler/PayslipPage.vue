<script setup lang="ts">
import { ref, computed, watch, onMounted, h } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  NCard,
  NSpin,
  NDataTable,
  NButton,
  NDropdown,
  NModal,
  NDescriptions,
  NDescriptionsItem,
  NPagination,
  useMessage,
  type DataTableColumns,
  type DataTableSortState,
} from 'naive-ui'
import MonthNavigator from '@/components/antler/MonthNavigator.vue'
import { useAntlerApi } from '@/composables/useAntlerApi'
import {
  previousCalendarMonth,
  shiftPeriod,
  formatPeriodLabel,
  isFuturePeriod,
  downloadCsv,
  printPayslipPdf,
  type PayslipEntry,
  type PayslipResponse,
} from '@/lib/period-sg'

const { t } = useI18n()
const api = useAntlerApi()
const message = useMessage()
const route = useRoute()
const router = useRouter()

const loading = ref(true)
const period = ref(previousCalendarMonth())
const page = ref(1)
const pageSize = ref(20)
const pageSizes = [10, 20, 50, 100, 200]
const sortState = ref<DataTableSortState | null>({ columnKey: 'at', order: 'descend' })
const data = ref<PayslipResponse | null>(null)

const detailOpen = ref(false)
const usageOpen = ref(false)
const selected = ref<PayslipEntry | null>(null)
const usageData = ref<{ homeTasks: number; otTasks: number; tokens: number } | null>(null)

const periodLabel = computed(() => formatPeriodLabel(period.value))
const canGoNext = computed(() => !isFuturePeriod(shiftPeriod(period.value, 1)))

const exportOptions = [
  { label: 'Export CSV', key: 'csv' },
  { label: 'Export PDF', key: 'pdf' },
]

function reasonLabel(reason: string) {
  const key = `payslip.reason.${reason}`
  const translated = t(key)
  return translated === key ? reason : translated
}

function formatDate(at: number) {
  return new Date(at).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' })
}

function amountDisplay(row: PayslipEntry) {
  const sign = row.type === 'credit' ? '+' : '−'
  return `${sign}${row.amount}`
}

function sortOrderFor(key: string): 'ascend' | 'descend' | false {
  if (sortState.value?.columnKey !== key) return false
  return sortState.value.order === 'ascend' ? 'ascend' : 'descend'
}

const columns = computed<DataTableColumns<PayslipEntry>>(() => [
  {
    title: t('payslip.col.date'),
    key: 'at',
    sorter: true,
    sortOrder: sortOrderFor('at'),
    render: (r) => formatDate(r.at),
  },
  {
    title: t('payslip.col.type'),
    key: 'type',
    sorter: true,
    sortOrder: sortOrderFor('type'),
    render: (r) => t(`payslip.type.${r.type}`, r.type),
  },
  {
    title: t('payslip.col.subject'),
    key: 'agentName',
    sorter: true,
    sortOrder: sortOrderFor('agentName'),
    render: (r) => r.agentName || r.departmentId || '—',
  },
  {
    title: t('payslip.col.amount'),
    key: 'amount',
    sorter: true,
    sortOrder: sortOrderFor('amount'),
    render: (r) => amountDisplay(r),
  },
  {
    title: t('payslip.col.balance'),
    key: 'balanceAfter',
    sorter: true,
    sortOrder: sortOrderFor('balanceAfter'),
  },
  {
    title: t('payslip.col.reason'),
    key: 'reason',
    sorter: true,
    sortOrder: sortOrderFor('reason'),
    render: (r) => reasonLabel(r.reason),
  },
  {
    title: t('payslip.col.actions'),
    key: 'actions',
    render: (row) => {
      const buttons = [
        h(
          NButton,
          { size: 'tiny', quaternary: true, onClick: () => openDetail(row) },
          { default: () => t('payslip.viewDetail') },
        ),
      ]
      if (row.departmentId || row.subscriptionId) {
        buttons.push(
          h(
            NButton,
            { size: 'tiny', quaternary: true, onClick: () => openUsage(row) },
            { default: () => t('payslip.viewUsage') },
          ),
        )
      }
      return h('div', { class: 'actions' }, buttons)
    },
  },
])

async function resolveAgentId(row: PayslipEntry): Promise<string | null> {
  try {
    const res = await api.get<{ agents: Array<{ id: string; ecsSubscriptionId?: string }> }>(
      '/api/config/agents',
    )
    if (row.subscriptionId) {
      const hit = res.agents?.find((a) => a.ecsSubscriptionId === row.subscriptionId)
      if (hit) return hit.id
    }
  } catch {
    /* ignore */
  }
  return null
}

async function openUsage(row: PayslipEntry) {
  selected.value = row
  usageOpen.value = true
  usageData.value = null
  const agentId = await resolveAgentId(row)
  if (!agentId) {
    usageData.value = { homeTasks: 0, otTasks: 0, tokens: 0 }
    return
  }
  try {
    const res = await api.get<{
      usage: { homeTasks: number; otTasks: number; tokens: number }
    }>(`/api/usage/agent?agentId=${encodeURIComponent(agentId)}&period=${encodeURIComponent(period.value)}`)
    usageData.value = res.usage
  } catch {
    usageData.value = { homeTasks: 0, otTasks: 0, tokens: 0 }
  }
}

async function load() {
  loading.value = true
  try {
    const sortBy = String(sortState.value?.columnKey || 'at')
    const sortOrder = sortState.value?.order === 'ascend' ? 'ascend' : 'descend'
    const res = await api.get<PayslipResponse>(
      `/api/billing/payslip?period=${encodeURIComponent(period.value)}&page=${page.value}&pageSize=${pageSize.value}&sortBy=${encodeURIComponent(sortBy)}&sortOrder=${encodeURIComponent(sortOrder)}`,
    )
    data.value = res
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Failed to load payslip')
    data.value = null
  } finally {
    loading.value = false
  }
}

function syncRoute() {
  router.replace({ query: { ...route.query, period: period.value } })
}

function goPrev() {
  period.value = shiftPeriod(period.value, -1)
  page.value = 1
  syncRoute()
  load()
}

function goNext() {
  if (!canGoNext.value) return
  period.value = shiftPeriod(period.value, 1)
  page.value = 1
  syncRoute()
  load()
}

function onPageChange(p: number) {
  page.value = p
  load()
}

function onPageSizeChange(size: number) {
  pageSize.value = size
  page.value = 1
  load()
}

function handleSorterChange(sorter: DataTableSortState | DataTableSortState[] | null) {
  const s = Array.isArray(sorter) ? sorter[0] ?? null : sorter
  if (!s?.order) {
    sortState.value = { columnKey: 'at', order: 'descend' }
  } else {
    sortState.value = s
  }
  page.value = 1
  load()
}

function openDetail(row: PayslipEntry) {
  selected.value = row
  detailOpen.value = true
}

async function handleExport(key: string) {
  try {
    const full = await api.get<PayslipResponse>(
      `/api/billing/payslip/export?period=${encodeURIComponent(period.value)}`,
    )
    const rows = full.entries || []
    if (key === 'csv') {
      downloadCsv(`payslip-${period.value}.csv`, [
        ['Date', 'Type', 'Subject', 'Amount', 'Balance', 'Reason'],
        ...rows.map((r) => [
          formatDate(r.at),
          r.type,
          r.agentName || r.departmentId || '',
          String(r.amount),
          String(r.balanceAfter),
          r.reason,
        ]),
        [],
        ['Opening', '', '', '', String(full.openingBalance), ''],
        ['Closing', '', '', '', String(full.closingBalance), ''],
      ])
      return
    }
    const tableRows = rows
      .map(
        (r) =>
          `<tr><td>${formatDate(r.at)}</td><td>${r.type}</td><td>${r.agentName || r.departmentId || ''}</td><td>${amountDisplay(r)}</td><td>${r.balanceAfter}</td><td>${r.reason}</td></tr>`,
      )
      .join('')
    printPayslipPdf(
      `Payslip ${period.value}`,
      `<h1>Antler Office — Payslip</h1>
      <p>${periodLabel.value}</p>
      <div class="summary">
        <span>Opening: ${full.openingBalance}</span>
        <span>Debit: ${full.totalDebit}</span>
        <span>Credit: ${full.totalCredit}</span>
        <span>Closing: ${full.closingBalance}</span>
      </div>
      <table><thead><tr><th>Date</th><th>Type</th><th>Subject</th><th>Amount</th><th>Balance</th><th>Reason</th></tr></thead>
      <tbody>${tableRows}</tbody></table>`,
    )
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Export failed')
  }
}

watch(
  () => route.query.period,
  (p) => {
    if (typeof p === 'string' && /^\d{4}-\d{2}$/.test(p)) {
      period.value = p
      load()
    }
  },
)

onMounted(() => {
  const q = route.query.period
  if (typeof q === 'string' && /^\d{4}-\d{2}$/.test(q)) {
    period.value = q
  }
  load()
})
</script>

<template>
  <NSpin :show="loading">
    <div class="header">
      <div>
        <h2 style="margin: 0">{{ t('payslip.title') }}</h2>
        <p class="hint">{{ t('payslip.subtitle') }}</p>
      </div>
      <div class="header-actions">
        <MonthNavigator
          :period="period"
          :label="periodLabel"
          :can-go-next="canGoNext"
          @prev="goPrev"
          @next="goNext"
        />
        <NDropdown :options="exportOptions" @select="handleExport">
          <NButton>{{ t('payslip.export') }}</NButton>
        </NDropdown>
      </div>
    </div>

    <div v-if="data" class="summary-row">
      <NCard size="small" class="summary-card">
        <div class="summary-label">{{ t('payslip.opening') }}</div>
        <div class="summary-value">{{ data.openingBalance.toLocaleString() }}</div>
      </NCard>
      <NCard size="small" class="summary-card">
        <div class="summary-label">{{ t('payslip.debit') }}</div>
        <div class="summary-value">{{ data.totalDebit.toLocaleString() }}</div>
      </NCard>
      <NCard size="small" class="summary-card">
        <div class="summary-label">{{ t('payslip.credit') }}</div>
        <div class="summary-value">{{ data.totalCredit.toLocaleString() }}</div>
      </NCard>
      <NCard size="small" class="summary-card">
        <div class="summary-label">{{ t('payslip.closing') }}</div>
        <div class="summary-value">{{ data.closingBalance.toLocaleString() }}</div>
      </NCard>
    </div>

    <NCard class="table-card" size="small">
      <NDataTable
        remote
        :loading="loading"
        :columns="columns"
        :data="data?.entries ?? []"
        :bordered="true"
        :single-line="false"
        size="small"
        :scroll-x="960"
        @update:sorter="handleSorterChange"
      />
      <div v-if="data" class="table-footer">
        <NPagination
          :page="page"
          :page-size="pageSize"
          :item-count="data.totalEntries"
          :page-sizes="pageSizes"
          show-size-picker
          @update:page="onPageChange"
          @update:page-size="onPageSizeChange"
        />
      </div>
    </NCard>

    <NModal v-model:show="detailOpen" preset="card" :title="t('payslip.viewDetail')" style="max-width: 520px">
      <NDescriptions v-if="selected" label-placement="left" :column="1" bordered size="small">
        <NDescriptionsItem :label="t('payslip.col.date')">{{ formatDate(selected.at) }}</NDescriptionsItem>
        <NDescriptionsItem :label="t('payslip.col.reason')">{{ reasonLabel(selected.reason) }}</NDescriptionsItem>
        <NDescriptionsItem label="subscriptionId">{{ selected.subscriptionId || '—' }}</NDescriptionsItem>
        <NDescriptionsItem label="departmentId">{{ selected.departmentId || '—' }}</NDescriptionsItem>
        <NDescriptionsItem :label="t('payslip.col.amount')">{{ amountDisplay(selected) }}</NDescriptionsItem>
        <NDescriptionsItem :label="t('payslip.col.balance')">{{ selected.balanceAfter }}</NDescriptionsItem>
        <NDescriptionsItem label="source">{{ selected.source || '—' }}</NDescriptionsItem>
      </NDescriptions>
    </NModal>

    <NModal v-model:show="usageOpen" preset="card" :title="t('payslip.viewUsage')" style="max-width: 400px">
      <NDescriptions v-if="usageData" label-placement="left" :column="1" bordered size="small">
        <NDescriptionsItem :label="t('payslip.usage.home')">{{ usageData.homeTasks }}</NDescriptionsItem>
        <NDescriptionsItem :label="t('payslip.usage.ot')">{{ usageData.otTasks }}</NDescriptionsItem>
        <NDescriptionsItem :label="t('payslip.usage.tokens')">{{ usageData.tokens }}</NDescriptionsItem>
      </NDescriptions>
      <p v-else class="hint">{{ t('payslip.usage.loading') }}</p>
    </NModal>
  </NSpin>
</template>

<style scoped>
.header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 16px;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.hint {
  opacity: 0.75;
  margin: 4px 0 0;
}
.summary-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.summary-card :deep(.n-card__content) {
  padding: 14px 16px;
}

.summary-label {
  font-size: 12px;
  opacity: 0.7;
  margin-bottom: 6px;
}

.summary-value {
  font-size: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.table-card {
  margin-top: 8px;
}

.table-card :deep(.n-card__content) {
  padding: 0;
}

.table-card :deep(.n-data-table) {
  border-radius: 0;
}

.table-footer {
  display: flex;
  justify-content: flex-end;
  padding: 12px 16px;
  border-top: 1px solid var(--n-border-color);
}
.actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
</style>
