import { computed, ref } from 'vue'
import {
  DELIVERABLE_KIND_META,
  deliverableDepartmentLabel,
  isBossSummary,
  isSameLocalDay,
  startOfLocalDay,
  type DeliverableItem,
  type DeliverableKind,
  type DeliverableStatus,
} from '@/lib/deliverable-meta'

export function useCompleteJobFilters(items: () => DeliverableItem[]) {
  const searchQuery = ref('')
  const filterExpanded = ref(false)
  const selectedDay = ref(startOfLocalDay(Date.now()))
  const kindFilter = ref<DeliverableKind | 'all'>('all')
  const departmentFilter = ref<string>('all')
  const statusFilter = ref<DeliverableStatus | 'all'>('all')

  const dayLabel = computed(() => {
    const today = startOfLocalDay(Date.now())
    const sel = selectedDay.value
    if (sel === today) return 'today'
    if (sel === today - 86400000) return 'yesterday'
    if (sel === today + 86400000) return 'tomorrow'
    return 'other'
  })

  const departmentOptions = computed(() => {
    const set = new Set<string>()
    for (const item of items()) {
      if (!isBossSummary(item)) continue
      set.add(deliverableDepartmentLabel(item))
    }
    return [...set].sort()
  })

  const filteredRows = computed(() => {
    const q = searchQuery.value.trim().toLowerCase()
    return items()
      .filter(isBossSummary)
      .filter((item) => isSameLocalDay(item.createdAt, selectedDay.value))
      .filter((item) => {
        if (kindFilter.value !== 'all' && item.kind !== kindFilter.value) return false
        if (departmentFilter.value !== 'all' && deliverableDepartmentLabel(item) !== departmentFilter.value) {
          return false
        }
        if (statusFilter.value !== 'all' && (item.status || 'complete') !== statusFilter.value) return false
        if (!q) return true
        const hay = [
          item.summary,
          item.task,
          deliverableDepartmentLabel(item),
          item.agentLabel,
          DELIVERABLE_KIND_META[item.kind].label,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return hay.includes(q)
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  })

  function shiftDay(delta: number) {
    selectedDay.value += delta * 86400000
  }

  function goToday() {
    selectedDay.value = startOfLocalDay(Date.now())
  }

  return {
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
  }
}
