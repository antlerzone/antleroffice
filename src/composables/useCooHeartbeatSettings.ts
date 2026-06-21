import { ref } from 'vue'
import { useAntlerApi } from '@/composables/useAntlerApi'

export interface CooHeartbeatConfig {
  enabled: boolean
  autonomousLoop: boolean
  idleBrainstorm: boolean
  idleBrainstormCooldownHours: number
  loopIntervalMinutes: number
  staleJobHours: number
  maxAutoRunsPerTick: number
  lastIdleBrainstormAt?: number
  schedule: { cron: string; tz: string }
}

export interface CooHeartbeatDiscoveryItem {
  priority: number
  kind: string
  summary: string
  autoRunnable?: boolean
  needsCeo?: boolean
  deliverableId?: string
  threadId?: string
  phase?: string
}

const config = ref<CooHeartbeatConfig | null>(null)
const loaded = ref(false)
const loading = ref(false)
const saving = ref(false)
const running = ref(false)

let loadPromise: Promise<void> | null = null

export function useCooHeartbeatSettings() {
  const api = useAntlerApi()

  async function load(force = false) {
    if (loaded.value && !force) return
    if (loadPromise && !force) return loadPromise
    loading.value = true
    loadPromise = (async () => {
      const res = await api.get<{ ok: boolean; config: CooHeartbeatConfig }>('/api/coo-heartbeat/config')
      config.value = res.config
      loaded.value = true
    })().finally(() => {
      loading.value = false
      loadPromise = null
    })
    return loadPromise
  }

  async function save(patch: Partial<CooHeartbeatConfig>) {
    if (!config.value) await load()
    saving.value = true
    try {
      const res = await api.send<{ ok: boolean; config: CooHeartbeatConfig }>(
        'PATCH',
        '/api/coo-heartbeat/config',
        { ...config.value, ...patch },
      )
      config.value = res.config
      return res.config
    } finally {
      saving.value = false
    }
  }

  async function runHeartbeat() {
    running.value = true
    try {
      return await api.send<{
        ok: boolean
        itemCount?: number
        triageText?: string
        autonomous?: { ran: boolean; reason?: string }
        error?: string
      }>('POST', '/api/coo-heartbeat/run', { wait: true }, { timeoutMs: 600_000 })
    } finally {
      running.value = false
    }
  }

  async function fetchDiscovery() {
    return api.get<{
      ok: boolean
      items: CooHeartbeatDiscoveryItem[]
      triageText: string
    }>('/api/coo-heartbeat/discovery')
  }

  function parseCronHourMinute(cron: string) {
    const parts = String(cron || '0 */4 * * *').trim().split(/\s+/)
    const minute = Number(parts[0]) || 0
    const hour = Number(parts[1]) || 0
    return { hour, minute, isInterval: String(parts[1] || '').includes('/') }
  }

  function buildDailyCron(hour: number, minute: number) {
    const h = Math.min(23, Math.max(0, Math.floor(hour)))
    const m = Math.min(59, Math.max(0, Math.floor(minute)))
    return `${m} ${h} * * *`
  }

  return {
    config,
    loaded,
    loading,
    saving,
    running,
    load,
    save,
    runHeartbeat,
    fetchDiscovery,
    parseCronHourMinute,
    buildDailyCron,
  }
}
