import { ref, onUnmounted } from 'vue'
import { profileLang, inferLangFromText, type VoiceCloneLang } from '@/constants/voiceClone'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useVoiceSettings } from '@/composables/useVoiceSettings'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import { useEdgeTTS } from '@/composables/useEdgeTTS'
import { defaultTtsVoiceForLanguage, resolveReplyLanguage } from '@/constants/voiceAssistant'
import { unlockAudioPlayback } from '@/lib/audio-unlock'

export type VoiceOutputEngine =
  | 'kokoro'
  | 'edgetts'
  | 'webspeech'
  | 'elevenlabs'
  | 'fishaudio'
  | null

export interface SpeakOptions {
  profileId?: string
  forceWebSpeech?: boolean
  engine?: Exclude<VoiceOutputEngine, null>
  ttsVoice?: string
  /** ElevenLabs voiceId / Fish Audio reference_id (cloud TTS engines) */
  voiceId?: string
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
    await unlockAudioPlayback()
    objectUrl = URL.createObjectURL(blob)
    audioEl = new Audio(objectUrl)
    audioEl.volume = Math.max(0, Math.min(1, assistantSettings.value.voice.volume ?? 1))
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
    const eng = opts?.engine
    if (eng && eng !== 'elevenlabs' && eng !== 'fishaudio') return eng
    const v = assistantSettings.value.voice
    if (v.ttsEngine === 'kokoro' || v.ttsEngine === 'edgetts') return v.ttsEngine
    return 'edgetts' as const
  }

  // Cloud TTS (ElevenLabs / Fish Audio). Used by standup playback per-role voices
  // and any caller that passes engine: 'elevenlabs' | 'fishaudio'. API keys come
  // from the realtime voice-assistant settings; voiceId from the caller (per role).
  async function speakCloud(text: string, cloudEngine: 'elevenlabs' | 'fishaudio', opts?: SpeakOptions) {
    const blob = await synthesizeCloudBlob(text, cloudEngine, opts)
    if (!blob) {
      await speakDefaultTts(text, { ...opts, engine: undefined })
      return
    }
    void setSpeakingFlag(true, !!opts?.bargeIn)
    isSynthesizing.value = true
    try {
      engine.value = cloudEngine
      await playBlob(blob)
    } finally {
      isSynthesizing.value = false
      void setSpeakingFlag(false)
    }
  }

  async function synthesizeCloudBlob(
    text: string,
    cloudEngine: 'elevenlabs' | 'fishaudio',
    opts?: SpeakOptions,
  ): Promise<Blob | null> {
    const v = assistantSettings.value.voice
    const rt = assistantSettings.value.realtime
    const apiKey = (
      cloudEngine === 'elevenlabs'
        ? v.elevenLabsApiKey || rt.elevenLabsApiKey
        : v.fishAudioApiKey || rt.fishAudioApiKey
    )?.trim() || ''
    const fallbackId =
      cloudEngine === 'elevenlabs'
        ? v.elevenLabsVoiceId || rt.elevenLabsVoiceId
        : v.fishAudioVoiceId || rt.fishAudioVoiceId
    const voiceId = (opts?.voiceId?.trim() || fallbackId?.trim() || '')
    if (!apiKey || !voiceId) {
      console.warn(`[voice] ${cloudEngine} key/id missing — cannot synthesize blob`)
      return null
    }
    const result = await api.postBlob(
      '/api/voice/synthesize',
      { text, engine: cloudEngine, apiKey, voiceId },
      { timeoutMs: 120000 },
    )
    if ('blob' in result) return result.blob
    return null
  }

  /** Synthesize persona greeting without playing (for Save → cache). */
  async function synthesizePersonaLine(text: string, opts?: SpeakOptions): Promise<Blob | null> {
    const trimmed = text.trim()
    if (!trimmed) return null
    if (opts?.engine === 'elevenlabs' || opts?.engine === 'fishaudio') {
      return synthesizeCloudBlob(trimmed, opts.engine, opts)
    }
    const chosen = resolveTtsEngine(opts)
    const uiLocale = typeof navigator !== 'undefined' ? navigator.language : 'en'
    const replyLang = resolveReplyLanguage(assistantSettings.value.voice.replyLanguage, uiLocale)
    const ttsVoice =
      opts?.ttsVoice ||
      (chosen === 'edgetts' || chosen === 'kokoro'
        ? defaultTtsVoiceForLanguage(replyLang, chosen)
        : assistantSettings.value.voice.ttsVoice)
    const result = await api.postBlob(
      '/api/voice/synthesize',
      {
        text: trimmed,
        engine: chosen,
        voice: ttsVoice,
        rate: assistantSettings.value.voice.rate,
      },
      { timeoutMs: 120000 },
    )
    if ('blob' in result) return result.blob
    return null
  }

  async function speakDefaultTts(text: string, opts?: SpeakOptions) {
    const chosen = resolveTtsEngine(opts)
    const uiLocale = typeof navigator !== 'undefined' ? navigator.language : 'en'
    const replyLang = resolveReplyLanguage(assistantSettings.value.voice.replyLanguage, uiLocale)
    const ttsVoice =
      opts?.ttsVoice ||
      (chosen === 'edgetts' || chosen === 'kokoro'
        ? defaultTtsVoiceForLanguage(replyLang, chosen)
        : assistantSettings.value.voice.ttsVoice)
    void setSpeakingFlag(true, !!opts?.bargeIn)
    if (chosen === 'webspeech') {
      engine.value = 'webspeech'
      try {
        await webSpeak(text, {
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
          text,
          engine: chosen,
          voice: ttsVoice,
          rate: assistantSettings.value.voice.rate,
        },
        { timeoutMs: 120000 },
      )
      if ('blob' in result) {
        engine.value = chosen
        await playBlob(result.blob)
        return
      }
      if ('fallback' in result && result.fallback === 'webspeech') {
        engine.value = 'webspeech'
        await webSpeak(text, {
          voice: ttsVoice,
          rate: assistantSettings.value.voice.rate,
          volume: assistantSettings.value.voice.volume,
          pitch: assistantSettings.value.voice.pitch,
        })
        return
      }
      throw new Error('error' in result ? result.error || 'Voice synthesis failed' : 'Voice synthesis failed')
    } catch {
      engine.value = 'webspeech'
      await webSpeak(text, {
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

  async function speak(text: string, opts?: SpeakOptions) {
    const trimmed = text.trim()
    if (!trimmed) return

    stop()

    if (opts?.engine === 'elevenlabs' || opts?.engine === 'fishaudio') {
      await speakCloud(trimmed, opts.engine, opts)
      return
    }

    const chosen = resolveTtsEngine(opts)
    const uiLocale = typeof navigator !== 'undefined' ? navigator.language : 'en'
    const replyLang = resolveReplyLanguage(assistantSettings.value.voice.replyLanguage, uiLocale)
    const ttsVoice =
      opts?.ttsVoice ||
      (chosen === 'edgetts' || chosen === 'kokoro'
        ? defaultTtsVoiceForLanguage(replyLang, chosen)
        : assistantSettings.value.voice.ttsVoice)
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

    await speakDefaultTts(trimmed, { ...opts, ttsVoice })
  }

  onUnmounted(() => {
    stop()
  })

  return {
    speak,
    stop,
    playBlob,
    synthesizePersonaLine,
    isPlaying,
    isLoading,
    isSynthesizing,
    engine,
  }
}
