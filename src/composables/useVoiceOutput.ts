import { ref, onUnmounted } from 'vue'
import { profileLang, inferLangFromText, type VoiceCloneLang } from '@/constants/voiceClone'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useVoiceSettings } from '@/composables/useVoiceSettings'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import { useEdgeTTS } from '@/composables/useEdgeTTS'

export type VoiceOutputEngine = 'cosyvoice' | 'kokoro' | 'edgetts' | 'webspeech' | null

export interface SpeakOptions {
  profileId?: string
  forceWebSpeech?: boolean
  engine?: Exclude<VoiceOutputEngine, null>
  ttsVoice?: string
  bargeIn?: boolean
}

export function useVoiceOutput() {
  const api = useAntlerApi()
  const { localSettings, serverActiveProfileId, profiles } = useVoiceSettings()
  const { settings: assistantSettings } = useVoiceAssistantSettings()
  const { speak: webSpeak, stop: webStop, isPlaying, isLoading } = useEdgeTTS()

  const engine = ref<VoiceOutputEngine>(null)
  const isSynthesizing = ref(false)
  let audioEl: HTMLAudioElement | null = null
  let objectUrl: string | null = null

  function cleanupAudio() {
    if (audioEl) {
      audioEl.pause()
      audioEl.src = ''
      audioEl = null
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = null
    }
  }

  function stop() {
    cleanupAudio()
    webStop()
    engine.value = null
    isSynthesizing.value = false
    void setSpeakingFlag(false)
  }

  async function setSpeakingFlag(speaking: boolean, bargeIn = false) {
    try {
      await fetch('/api/voice/listener/speaking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speaking, bargeIn: speaking && bargeIn }),
      })
    } catch {
      /* ignore */
    }
  }

  async function playBlob(blob: Blob): Promise<void> {
    cleanupAudio()
    objectUrl = URL.createObjectURL(blob)
    audioEl = new Audio(objectUrl)
    return new Promise((resolve, reject) => {
      if (!audioEl) return reject(new Error('Audio element missing'))
      audioEl.onended = () => {
        cleanupAudio()
        resolve()
      }
      audioEl.onerror = () => {
        cleanupAudio()
        reject(new Error('Audio playback failed'))
      }
      void audioEl.play().catch(reject)
    })
  }

  function resolveProfileId(opts?: { profileId?: string }, text?: string) {
    if (opts?.profileId) return opts.profileId
    const trimmed = text?.trim()
    if (trimmed) {
      const textLang = inferLangFromText(trimmed) as VoiceCloneLang
      const matching = profiles.value.filter((p) => profileLang(p) === textLang && p.refText)
      if (matching.length) {
        const activeId = serverActiveProfileId.value || localSettings.value.activeProfileId
        const activeMatch = matching.find((p) => p.id === activeId)
        if (activeMatch) return activeMatch.id
        return [...matching].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id || null
      }
    }
    return serverActiveProfileId.value || localSettings.value.activeProfileId || null
  }

  function resolveTtsEngine(opts?: SpeakOptions) {
    if (opts?.forceWebSpeech) return 'webspeech' as const
    if (opts?.engine) return opts.engine
    const v = assistantSettings.value.voice
    if (v.ttsEngine === 'cosyvoice') return 'cosyvoice' as const
    if (v.ttsEngine === 'kokoro' || v.ttsEngine === 'edgetts') return v.ttsEngine
    return 'webspeech' as const
  }

  async function speak(text: string, opts?: SpeakOptions) {
    const trimmed = text.trim()
    if (!trimmed) return

    stop()

    const chosen = resolveTtsEngine(opts)
    const ttsVoice = opts?.ttsVoice || assistantSettings.value.voice.ttsVoice
    void setSpeakingFlag(true, !!opts?.bargeIn)
    if (chosen === 'webspeech') {
      engine.value = 'webspeech'
      try {
        await webSpeak(trimmed, {
          voice: ttsVoice,
          rate: assistantSettings.value.voice.rate,
          volume: assistantSettings.value.voice.volume,
          pitch: assistantSettings.value.voice.pitch,
        })
      } finally {
        void setSpeakingFlag(false)
      }
      return
    }

    isSynthesizing.value = true
    try {
      const result = await api.postBlob(
        '/api/voice/synthesize',
        {
          text: trimmed,
          profileId: chosen === 'cosyvoice' ? resolveProfileId(opts, trimmed) : undefined,
          engine: chosen,
          voice: ttsVoice,
          rate: assistantSettings.value.voice.rate,
        },
        { timeoutMs: chosen === 'cosyvoice' ? 300000 : 120000 },
      )
      if ('blob' in result) {
        engine.value = chosen
        await playBlob(result.blob)
        return
      }
      const err = 'error' in result ? result.error : 'Voice synthesis failed'
      throw new Error(err || 'Voice synthesis failed')
    } catch {
      engine.value = 'webspeech'
      await webSpeak(trimmed, {
        voice: ttsVoice,
        rate: assistantSettings.value.voice.rate,
        volume: assistantSettings.value.voice.volume,
        pitch: assistantSettings.value.voice.pitch,
      })
    } finally {
      isSynthesizing.value = false
      void setSpeakingFlag(false)
    }
  }

  onUnmounted(() => {
    stop()
  })

  return {
    speak,
    stop,
    isPlaying,
    isLoading,
    isSynthesizing,
    engine,
  }
}
