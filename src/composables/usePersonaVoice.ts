import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  resolvePersonaSampleReply,
  resolveReplyLanguage,
} from '@/constants/voiceAssistant'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import type { SpeakOptions } from '@/composables/useVoiceOutput'

export function usePersonaVoice() {
  const { locale } = useI18n()
  const { settings, honorific } = useVoiceAssistantSettings()

  const replyLang = computed(() =>
    resolveReplyLanguage(settings.value.voice.replyLanguage, locale.value),
  )

  const resolvedSampleReply = computed(() =>
    resolvePersonaSampleReply(
      settings.value.summon.sampleReply,
      honorific.value,
      settings.value.voice.replyLanguage,
      locale.value,
    ),
  )

  function personaSpeakOptions(): SpeakOptions | undefined {
    // Unified reply voice — drives summon greeting AND command replies.
    const vo = settings.value.realtime.voiceOutput || 'openai'
    const v = settings.value.voice
    const rt = settings.value.realtime
    if (vo === 'openai') {
      return { engine: 'openai', voiceId: rt.voice || 'alloy' }
    }
    if (vo === 'elevenlabs') {
      const voiceId = v.elevenLabsVoiceId?.trim() || rt.elevenLabsVoiceId?.trim()
      if (cloudTtsReady('elevenlabs')) {
        return { engine: 'elevenlabs', voiceId }
      }
      return undefined
    }
    if (vo === 'fishaudio') {
      const voiceId = v.fishAudioVoiceId?.trim() || rt.fishAudioVoiceId?.trim()
      if (cloudTtsReady('fishaudio')) {
        return { engine: 'fishaudio', voiceId }
      }
      return undefined
    }
    // edgetts / browser → fall through to the default Voice-tab engine (EdgeTTS / browser).
    return undefined
  }

  function cloudTtsReady(engine: 'elevenlabs' | 'fishaudio'): boolean {
    const creds = resolveCloudTtsCredentials(engine)
    return !!(creds.apiKey && creds.voiceId)
  }

  /** Persona + Voice tab credentials — Realtime should use the same clone as summon greeting. */
  function resolveCloudTtsCredentials(engine: 'elevenlabs' | 'fishaudio') {
    const v = settings.value.voice
    const rt = settings.value.realtime
    if (engine === 'elevenlabs') {
      return {
        apiKey: (v.elevenLabsApiKey || rt.elevenLabsApiKey || '').trim(),
        voiceId: (v.elevenLabsVoiceId || rt.elevenLabsVoiceId || '').trim(),
      }
    }
    return {
      apiKey: (v.fishAudioApiKey || rt.fishAudioApiKey || '').trim(),
      voiceId: (v.fishAudioVoiceId || rt.fishAudioVoiceId || '').trim(),
    }
  }

  return {
    resolvedSampleReply,
    personaSpeakOptions,
    replyLang,
    cloudTtsReady,
    resolveCloudTtsCredentials,
  }
}
