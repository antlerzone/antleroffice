import { computed, ref } from 'vue'

export type DownloadStatus = 'pending' | 'active' | 'done' | 'error'

export interface DownloadItem {
  id: string
  label: string
  status: DownloadStatus
  detail?: string
}

// Module-level singleton — shared across the whole app
const items = ref<DownloadItem[]>([])
const expanded = ref(false)

let dismissTimer: ReturnType<typeof setTimeout> | null = null

export function useDownloadManager() {
  const activeItems = computed(() => items.value.filter((i) => i.status !== 'done'))
  const doneItems = computed(() => items.value.filter((i) => i.status === 'done'))
  const errorItems = computed(() => items.value.filter((i) => i.status === 'error'))

  const totalCount = computed(() => items.value.length)
  const doneCount = computed(() => doneItems.value.length + errorItems.value.length)
  const allDone = computed(() => items.value.length > 0 && doneCount.value === totalCount.value)
  const hasAny = computed(() => items.value.length > 0)

  function addItem(item: DownloadItem) {
    if (dismissTimer) {
      clearTimeout(dismissTimer)
      dismissTimer = null
    }
    const existing = items.value.findIndex((i) => i.id === item.id)
    if (existing >= 0) {
      items.value[existing] = { ...items.value[existing], ...item }
    } else {
      items.value.push(item)
    }
  }

  function updateItem(id: string, patch: Partial<Omit<DownloadItem, 'id'>>) {
    const idx = items.value.findIndex((i) => i.id === id)
    if (idx >= 0) {
      items.value[idx] = { ...items.value[idx], ...patch }
    }
  }

  function clearAll() {
    items.value = []
    expanded.value = false
  }

  function scheduleDismiss(ms = 4000) {
    if (dismissTimer) clearTimeout(dismissTimer)
    dismissTimer = setTimeout(() => {
      clearAll()
      dismissTimer = null
    }, ms)
  }

  function toggleExpanded() {
    expanded.value = !expanded.value
  }

  return {
    items,
    expanded,
    activeItems,
    doneItems,
    errorItems,
    totalCount,
    doneCount,
    allDone,
    hasAny,
    addItem,
    updateItem,
    clearAll,
    scheduleDismiss,
    toggleExpanded,
  }
}
