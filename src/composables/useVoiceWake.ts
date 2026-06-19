import { ref, watch } from 'vue'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import { useVoiceOutput } from '@/composables/useVoiceOutput'
import { useStandupPlayback } from '@/composables/useStandupPlayback'
import { useBossStore } from '@/stores/boss'
import { isElectronApp, showItemInFolder } from '@/lib/desktop-shell'

export type VoiceWakeMode = 'sleep' | 'active' | 'speaking'

const mode = ref<VoiceWakeMode>('sleep')
const lastTranscript = ref('')
const lastReply = ref('')
const connected = ref(false)

let eventSource: EventSource | null = null
let chimeAudio: HTMLAudioElement | null = null

export function useVoiceWake() {
  const api = useAntlerApi()
  const boss = useBossStore()
  const { settings, honorific } = useVoiceAssistantSettings()
  const { speak, stop } = useVoiceOutput()
  const { handlePlaybackCommand, isActive: standupPlaybackActive } = useStandupPlayback()

  async function syncListenerConfig() {
    const summon = settings.value.summon
    await api.send('POST', '/api/voice/listener/config', {
      globalListenEnabled: summon.globalListenEnabled,
      wakePhrases: summon.wakePhrases,
      idleTimeoutSec: summon.idleTimeoutSec,
      wakeEngine: summon.wakeEngine,
      sensitivity: summon.sensitivity,
      porcupineAccessKey: summon.porcupineAccessKey,
      personaEnabled: settings.value.persona.enabled,
      honorific: honorific.value,
      personaPrompt: settings.value.persona.systemPrompt,
      ownerKey: boss.chatOwnerKey || 'local:boss',
      ownerName: boss.session?.username || 'Boss',
      autoDispatch: true,
    })
  }

  async function setMode(next: VoiceWakeMode) {
    mode.value = next
    await api.send('POST', '/api/voice/listener/mode', { mode: next })
    if (isElectronApp()) {
      const m = next === 'speaking' ? 'active' : next
      await window.antlerDesktop?.voiceWakeSetMode?.(m === 'active' ? 'active' : 'sleep')
    }
  }

  async function notifySpeaking(speaking: boolean) {
    await api.send('POST', '/api/voice/listener/speaking', { speaking })
    if (speaking) mode.value = 'speaking'
    else if (mode.value === 'speaking') mode.value = 'active'
  }

  async function playWakeChime() {
    const chime = settings.value.summon.wakeChimeMode
    if (chime === 'off') return
    if (chime === 'beep') {
      if (!chimeAudio) chimeAudio = new Audio()
      chimeAudio.src =
        'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='
      void chimeAudio.play().catch(() => {})
      return
    }
    const text = settings.value.summon.wakeChimeText?.trim()
    if (!text) return
    await notifySpeaking(true)
    try {
      await speak(text)
    } finally {
      await notifySpeaking(false)
    }
  }

  async function handleLocalAction(action: string) {
    if (action === 'stop_tts') {
      stop()
      await notifySpeaking(false)
      return
    }
    if (action === 'mute') {
      await setMode('sleep')
      return
    }
    if (action === 'open_settings') {
      window.dispatchEvent(new CustomEvent('antler:open-settings'))
    }
  }

  async function handleCommandResult(payload: {
    text?: string
    result?: {
      ok?: boolean
      local?: boolean
      action?: string
      text?: string
      path?: string
      sectionIndex?: number
    }
  }) {
    const result = payload.result
    if (!result?.ok) return
    if (standupPlaybackActive.value && (await handlePlaybackCommand(result))) {
      return
    }
    if (result.action === 'standup_export_pdf' && result.text) {
      if (result.path) showItemInFolder(result.path)
      if (settings.value.voice.enabled) {
        await notifySpeaking(true)
        try {
          await speak(result.text)
        } finally {
          await notifySpeaking(false)
        }
      }
      return
    }
    if (result.local && result.action) {
      await handleLocalAction(result.action)
      return
    }
    const reply = String(result.text || '').trim()
    if (!reply || !settings.value.voice.enabled) return
    lastReply.value = reply
    await notifySpeaking(true)
    try {
      await speak(reply)
    } finally {
      await notifySpeaking(false)
    }
  }

  function connectEvents() {
    if (eventSource || typeof EventSource === 'undefined') return
    eventSource = new EventSource('/api/voice/listener/events', { withCredentials: true })

    eventSource.onopen = () => {
      connected.value = true
    }
    eventSource.onerror = () => {
      connected.value = false
    }
    eventSource.onmessage = (ev) => {
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(ev.data)
      } catch {
        return
      }
      const type = String(payload.type || '')
      if (type === 'wake') {
        mode.value = 'active'
        void playWakeChime()
        return
      }
      if (type === 'idle') {
        mode.value = 'sleep'
        return
      }
      if (type === 'transcript') {
        lastTranscript.value = String(payload.text || '')
        return
      }
      if (type === 'command_result') {
        void handleCommandResult(payload as { text?: string; result?: { ok?: boolean; local?: boolean; action?: string; text?: string } })
        return
      }
      if (type === 'standup_complete') {
        const summary = String(payload.summary || '汇报已存入 Complete Job')
        if (settings.value.voice.enabled) {
          void notifySpeaking(true)
            .then(() => speak(`汇报已完成。${summary}`))
            .finally(() => notifySpeaking(false))
        }
      }
    }
  }

  function disconnectEvents() {
    eventSource?.close()
    eventSource = null
    connected.value = false
  }

  async function bootstrap() {
    if (!isElectronApp()) return
    if (!settings.value.summon.globalListenEnabled) return
    await syncListenerConfig()
    connectEvents()
    if (isElectronApp()) {
      const status = await window.antlerDesktop?.voiceWakeGetStatus?.()
      if (status?.state?.mode === 'active' || status?.state?.mode === 'speaking') {
        mode.value = status.state.mode
      }
      window.antlerDesktop?.onVoiceWakeState?.((state) => {
        if (state.mode === 'active' || state.mode === 'speaking') mode.value = state.mode
        else mode.value = 'sleep'
      })
    }
  }

  watch(
    () => settings.value.summon,
    () => {
      void syncListenerConfig()
    },
    { deep: true },
  )

  watch(
    () => [settings.value.persona, honorific.value, boss.chatOwnerKey],
    () => {
      void syncListenerConfig()
    },
    { deep: true },
  )

  return {
    mode,
    connected,
    lastTranscript,
    lastReply,
    syncListenerConfig,
    setMode,
    notifySpeaking,
    bootstrap,
    disconnectEvents,
  }
}
