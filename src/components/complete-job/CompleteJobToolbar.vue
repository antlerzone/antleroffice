<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NInput, NSelect, NSpace, NText } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { DELIVERABLE_KIND_META, type DeliverableKind, type DeliverableStatus } from '@/lib/deliverable-meta'
import { ChevronBackOutline, ChevronForwardOutline, FunnelOutline } from '@vicons/ionicons5'
import { NIcon } from 'naive-ui'

const props = defineProps<{
  searchQuery: string
  filterExpanded: boolean
  dayLabel: 'today' | 'yesterday' | 'tomorrow' | 'other'
  selectedDay: number
  kindFilter: DeliverableKind | 'all'
  departmentFilter: string
  statusFilter: DeliverableStatus | 'all'
  departmentOptions: string[]
}>()

const emit = defineEmits<{
  'update:searchQuery': [value: string]
  'update:kindFilter': [value: DeliverableKind | 'all']
  'update:departmentFilter': [value: string]
  'update:statusFilter': [value: DeliverableStatus | 'all']
  toggleFilter: []
  prevDay: []
  nextDay: []
  goToday: []
}>()

const { t, locale } = useI18n()

const dayTitle = computed(() => {
  if (props.dayLabel === 'today') return t('completeJob.today')
  if (props.dayLabel === 'yesterday') return t('completeJob.yesterday')
  if (props.dayLabel === 'tomorrow') return t('completeJob.tomorrow')
  return new Date(props.selectedDay).toLocaleDateString(locale.value, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
})

const kindOptions = computed<SelectOption[]>(() => [
  { label: t('completeJob.kindAll'), value: 'all' },
  ...(['plan_complete', 'daily_report', 'alert'] as DeliverableKind[]).map((k) => ({
    label: `${DELIVERABLE_KIND_META[k].icon} ${DELIVERABLE_KIND_META[k].label}`,
    value: k,
  })),
])

const deptOptions = computed<SelectOption[]>(() => [
  { label: t('completeJob.deptAll'), value: 'all' },
  ...props.departmentOptions.map((d) => ({ label: d, value: d })),
])

const statusOptions = computed<SelectOption[]>(() => [
  { label: t('completeJob.statusAll'), value: 'all' },
  { label: t('completeJob.statusInProgress'), value: 'in_progress' },
  { label: t('completeJob.statusComplete'), value: 'complete' },
  { label: t('completeJob.statusPending'), value: 'pending' },
])
</script>

<template>
  <div class="complete-job-toolbar">
    <NSpace align="center" :size="8" class="toolbar-left">
      <NButton quaternary circle :title="filterExpanded ? t('completeJob.filterCollapse') : t('completeJob.filterExpand')" @click="emit('toggleFilter')">
        <template #icon>
          <NIcon><FunnelOutline /></NIcon>
        </template>
      </NButton>
      <NInput
        :value="props.searchQuery"
        :placeholder="t('completeJob.searchPlaceholder')"
        clearable
        style="min-width: 220px; max-width: 360px"
        @update:value="emit('update:searchQuery', $event)"
      />
    </NSpace>

    <NSpace align="center" :size="4" class="toolbar-right">
      <NButton quaternary circle :title="t('completeJob.prevDay')" @click="emit('prevDay')">
        <template #icon>
          <NIcon><ChevronBackOutline /></NIcon>
        </template>
      </NButton>
      <NButton text type="primary" @click="emit('goToday')">
        <NText strong>{{ dayTitle }}</NText>
      </NButton>
      <NButton quaternary circle :title="t('completeJob.nextDay')" @click="emit('nextDay')">
        <template #icon>
          <NIcon><ChevronForwardOutline /></NIcon>
        </template>
      </NButton>
    </NSpace>
  </div>

  <div v-show="filterExpanded" class="complete-job-filters">
    <NSpace :size="12" wrap>
      <NSelect
        :value="props.kindFilter"
        :options="kindOptions"
        style="width: 160px"
        @update:value="emit('update:kindFilter', $event)"
      />
      <NSelect
        :value="props.departmentFilter"
        :options="deptOptions"
        style="width: 180px"
        @update:value="emit('update:departmentFilter', $event)"
      />
      <NSelect
        :value="props.statusFilter"
        :options="statusOptions"
        style="width: 160px"
        @update:value="emit('update:statusFilter', $event)"
      />
    </NSpace>
  </div>
</template>

<style scoped>
.complete-job-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.complete-job-filters {
  margin-bottom: 14px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--line, rgba(255, 255, 255, 0.12));
  background: var(--panel, rgba(0, 0, 0, 0.15));
}
</style>
