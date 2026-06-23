import { watch } from 'vue'
import { useVoiceSettings } from '@/composables/useVoiceSettings'
import { useDownloadManager } from '@/composables/useDownloadManager'

// Map of phase+message substring → which item is currently active
const PHASE_TO_ITEM: Record<
  string,
  { id: string; label: string }
> = {
  finding_python:  { id: 'voice-python',  label: 'Python 环境' },
  creating_venv:   { id: 'voice-python',  label: 'Python 环境' },
  torch:           { id: 'voice-torch',   label: 'PyTorch' },
  edgetts:         { id: 'voice-tts',     label: 'EdgeTTS' },
  alt_tts:         { id: 'voice-tts',     label: 'EdgeTTS' },
  kokoro:          { id: 'voice-tts',     label: 'EdgeTTS' },
  starting:        { id: 'voice-model',   label: '语音模型' },
}

const ALL_ITEMS = [
  { id: 'voice-python', label: 'Python 环境' },
  { id: 'voice-tts',    label: 'EdgeTTS' },
  { id: 'voice-model',  label: '语音模型' },
]

let initialized = false

function resolveActiveItem(phase: string, message: string) {
  const msgLower = message.toLowerCase()
  const phaseLower = phase.toLowerCase()

  if (phaseLower === 'finding_python' || phaseLower === 'creating_venv') {
    return PHASE_TO_ITEM['finding_python']
  }
  if (phaseLower === 'starting') {
    return PHASE_TO_ITEM['starting']
  }
  if (phaseLower === 'installing_deps') {
    if (msgLower.includes('edgetts') || msgLower.includes('kokoro') || msgLower.includes('alt')) {
      return PHASE_TO_ITEM['edgetts']
    }
    return PHASE_TO_ITEM['edgetts']
  }
  return null
}

export function useVoiceSetupProgress() {
  const { status, refreshStatus } = useVoiceSettings()
  const dm = useDownloadManager()

  let pollTimer: ReturnType<typeof setInterval> | null = null

  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }

  function startPoll() {
    stopPoll()
    pollTimer = setInterval(() => void refreshStatus(), 3000)
  }

  watch(
    () => status.value?.setup,
    (setup) => {
      if (!setup) return
      const { phase, message = '' } = setup

      const inProgress = ['finding_python', 'creating_venv', 'installing_deps', 'starting'].includes(phase)
      const isDone = phase === 'running'
      const isError = phase === 'error'

      // Register all items the first time setup starts
      if (inProgress && !initialized) {
        initialized = true
        for (const item of ALL_ITEMS) {
          dm.addItem({ ...item, status: 'pending' })
        }
        dm.expanded.value = true
        startPoll()
      }

      if (!initialized) return

      if (isError) {
        stopPoll()
        const active = resolveActiveItem(phase, message)
        if (active) {
          dm.updateItem(active.id, { status: 'error', detail: message || 'Setup failed' })
        }
        return
      }

      if (isDone) {
        stopPoll()
        initialized = false
        // Mark all pending/active as done
        for (const item of ALL_ITEMS) {
          const existing = dm.items.value.find((i) => i.id === item.id)
          if (existing && existing.status !== 'done') {
            dm.updateItem(item.id, { status: 'done', detail: undefined })
          }
        }
        return
      }

      if (inProgress) {
        const active = resolveActiveItem(phase, message)
        if (!active) return

        // Mark all items before this one as done
        const activeIdx = ALL_ITEMS.findIndex((i) => i.id === active.id)
        for (let i = 0; i < activeIdx; i++) {
          const prev = ALL_ITEMS[i]
          const prevItem = dm.items.value.find((x) => x.id === prev.id)
          if (prevItem && prevItem.status !== 'done') {
            dm.updateItem(prev.id, { status: 'done', detail: undefined })
          }
        }

        dm.updateItem(active.id, { status: 'active', detail: message || undefined })
      }
    },
    { deep: true },
  )
}
