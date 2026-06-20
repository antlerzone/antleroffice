import { ref } from 'vue'
import { useAntlerApi } from '@/composables/useAntlerApi'

export type StandupPeriod = 'yesterday' | 'last_week' | 'last_7_days'

export interface StandupParticipantVoice {
  engine: string
  ttsVoice?: string
  profileId?: string
}

export interface StandupParticipant {
  agentId: string
  role: string
  label: string
  order: number
  enabled: boolean
  voice: StandupParticipantVoice
}

export interface DailyStandupConfig {
  enabled: boolean
  schedule: { cron: string; tz: string }
  defaultPeriod: StandupPeriod
  participants: StandupParticipant[]
  hostVoice?: StandupParticipantVoice
  ceoVoice?: StandupParticipantVoice
  prompts?: { department?: string; cooSummary?: string; ceoSummary?: string }
}

export interface StandupCandidate {
  agentId: string
  role: string
  label: string
  order: number
}

const config = ref<DailyStandupConfig | null>(null)
const candidates = ref<StandupCandidate[]>([])
const loaded = ref(false)
const loading = ref(false)
const saving = ref(false)
const running = ref(false)

let loadPromise: Promise<void> | null = null

export function useDailyStandupSettings() {
  const api = useAntlerApi()

  async function load(force = false) {
    if (loaded.value && !force) return
    if (loadPromise && !force) return loadPromise
    loading.value = true
    loadPromise = (async () => {
      const res = await api.get<{
        ok: boolean
        config: DailyStandupConfig
        candidates: StandupCandidate[]
      }>('/api/department-standup/config')
      config.value = res.config
      candidates.value = res.candidates || []
      loaded.value = true
    })()
      .finally(() => {
        loading.value = false
        loadPromise = null
      })
    return loadPromise
  }

  async function save(patch: Partial<DailyStandupConfig>) {
    if (!config.value) await load()
    saving.value = true
    try {
      const res = await api.send<{
        ok: boolean
        config: DailyStandupConfig
        candidates: StandupCandidate[]
      }>('PATCH', '/api/department-standup/config', {
        ...config.value,
        ...patch,
      })
      config.value = res.config
      candidates.value = res.candidates || []
      return res.config
    } finally {
      saving.value = false
    }
  }

  async function runStandup(opts: { period?: StandupPeriod; participantIds?: string[] } = {}) {
    running.value = true
    try {
      return await api.send<{
        ok: boolean
        runId?: string
        deliverable?: { id: string; summary?: string }
        error?: string
      }>('POST', '/api/department-standup/run', {
        period: opts.period || config.value?.defaultPeriod || 'yesterday',
        participantIds: opts.participantIds,
        wait: true,
      }, { timeoutMs: 600_000 })
    } finally {
      running.value = false
    }
  }

  function parseCronHourMinute(cron: string) {
    const parts = String(cron || '0 8 * * *').trim().split(/\s+/)
    const minute = Number(parts[0]) || 0
    const hour = Number(parts[1]) || 8
    return { hour, minute }
  }

  function buildCron(hour: number, minute: number) {
    const h = Math.min(23, Math.max(0, Math.floor(hour)))
    const m = Math.min(59, Math.max(0, Math.floor(minute)))
    return `${m} ${h} * * *`
  }

  return {
    config,
    candidates,
    loaded,
    loading,
    saving,
    running,
    load,
    save,
    runStandup,
    parseCronHourMinute,
    buildCron,
  }
}
