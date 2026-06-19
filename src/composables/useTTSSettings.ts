import { computed } from 'vue'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'

export interface TTSSettings {
  enabled: boolean
  autoPlay: boolean
  voice: string
  rate: number
  volume: number
  pitch: number
}

export function useTTSSettings() {
  const { settings, updateVoice, resetAll } = useVoiceAssistantSettings()

  const ttsSettings = computed<TTSSettings>({
    get: () => ({
      enabled: settings.value.voice.enabled,
      autoPlay: settings.value.voice.autoPlay,
      voice: settings.value.voice.ttsVoice,
      rate: settings.value.voice.rate,
      volume: settings.value.voice.volume,
      pitch: settings.value.voice.pitch,
    }),
    set: (v) => {
      updateVoice({
        enabled: v.enabled,
        autoPlay: v.autoPlay,
        ttsVoice: v.voice,
        rate: v.rate,
        volume: v.volume,
        pitch: v.pitch,
      })
    },
  })

  const settingsRef = computed({
    get: () => ttsSettings.value,
    set: (v: TTSSettings) => {
      ttsSettings.value = v
    },
  })

  function updateSettings(patch: Partial<TTSSettings>) {
    updateVoice({
      ...(patch.enabled != null ? { enabled: patch.enabled } : {}),
      ...(patch.autoPlay != null ? { autoPlay: patch.autoPlay } : {}),
      ...(patch.voice != null ? { ttsVoice: patch.voice } : {}),
      ...(patch.rate != null ? { rate: patch.rate } : {}),
      ...(patch.volume != null ? { volume: patch.volume } : {}),
      ...(patch.pitch != null ? { pitch: patch.pitch } : {}),
    })
  }

  function resetSettings() {
    resetAll()
  }

  function getSettings(): TTSSettings {
    return { ...ttsSettings.value }
  }

  return {
    settings: settingsRef,
    updateSettings,
    resetSettings,
    getSettings,
  }
}
