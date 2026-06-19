import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  BUILTIN_WAKE_PHRASES,
  DEFAULT_JARVIS_PERSONA_PROMPT,
  defaultHonorific,
  normalizeHonorific,
  type TtsEngine,
  type WakeChimeMode,
  type WakeEngine,
} from '@/constants/voiceAssistant'

const STORAGE_KEY = 'voice-assistant-settings'

export interface VoiceAssistantSettings {
  summon: {
    globalListenEnabled: boolean
    wakeEngine: WakeEngine
    wakePhrases: string[]
    idleTimeoutSec: number
    wakeChimeMode: WakeChimeMode
    wakeChimeText: string
    porcupineAccessKey: string
    sensitivity: number
    wakePhraseClips?: Record<string, string>
  }
  voice: {
    enabled: boolean
    autoPlay: boolean
    streamingTts: boolean
    ttsEngine: TtsEngine
    ttsVoice: string
    rate: number
    volume: number
    pitch: number
    useCloneVoice: boolean
  }
  persona: {
    enabled: boolean
    honorific: string
    systemPrompt: string
  }
}

function envBool(key: string, fallback: boolean): boolean {
  const v = import.meta.env[key]
  if (v === undefined || v === '') return fallback
  return v === 'true'
}

function envNum(key: string, fallback: number): number {
  const v = import.meta.env[key]
  if (v === undefined || v === '') return fallback
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

function envStr(key: string, fallback: string): string {
  const v = import.meta.env[key]
  return v !== undefined && v !== '' ? String(v) : fallback
}

function buildDefaults(locale: string): VoiceAssistantSettings {
  return {
    summon: {
      globalListenEnabled: true,
      wakeEngine: 'openwakeword',
      wakePhrases: [...BUILTIN_WAKE_PHRASES],
      idleTimeoutSec: 300,
      wakeChimeMode: 'tts',
      wakeChimeText: locale.startsWith('zh') ? '在的，老板。' : 'Yes, sir.',
      porcupineAccessKey: '',
      sensitivity: 0.5,
      wakePhraseClips: {},
    },
    voice: {
      enabled: envBool('VITE_TTS_ENABLED', true),
      autoPlay: envBool('VITE_TTS_AUTO_PLAY', false),
      streamingTts: true,
      ttsEngine: 'edgetts',
      ttsVoice: 'en-GB-RyanNeural',
      rate: envNum('VITE_TTS_RATE', 1.0),
      volume: envNum('VITE_TTS_VOLUME', 1.0),
      pitch: envNum('VITE_TTS_PITCH', 1.0),
      useCloneVoice: true,
    },
    persona: {
      enabled: true,
      honorific: defaultHonorific(locale),
      systemPrompt: DEFAULT_JARVIS_PERSONA_PROMPT,
    },
  }
}

function migrateLegacy(stored: Partial<VoiceAssistantSettings>, defaults: VoiceAssistantSettings, locale: string): VoiceAssistantSettings {
  const out = { ...defaults, ...stored }
  out.summon = { ...defaults.summon, ...(stored.summon || {}) }
  if (!out.summon.wakePhraseClips) out.summon.wakePhraseClips = {}
  out.voice = { ...defaults.voice, ...(stored.voice || {}) }
  out.persona = { ...defaults.persona, ...(stored.persona || {}) }

  const legacyPersona = stored.persona as
    | { honorific?: string; honorificPreset?: string; customHonorific?: string }
    | undefined
  if (legacyPersona && !legacyPersona.honorific && legacyPersona.honorificPreset) {
    const preset = legacyPersona.honorificPreset
    if (preset === 'custom') {
      out.persona.honorific = normalizeHonorific(legacyPersona.customHonorific || '', locale)
    } else if (preset === 'sir' || preset === 'boss' || preset === '老板') {
      out.persona.honorific = preset
    } else {
      out.persona.honorific = defaultHonorific(locale)
    }
  }
  out.persona.honorific = normalizeHonorific(out.persona.honorific || '', locale)
  if (!String(out.persona.systemPrompt || '').trim()) {
    out.persona.systemPrompt = DEFAULT_JARVIS_PERSONA_PROMPT
  }

  try {
    const legacyTts = localStorage.getItem('tts-settings')
    if (legacyTts) {
      const t = JSON.parse(legacyTts)
      if (t.enabled != null) out.voice.enabled = t.enabled
      if (t.autoPlay != null) out.voice.autoPlay = t.autoPlay
      if (t.voice) out.voice.ttsVoice = t.voice
      if (t.rate != null) out.voice.rate = t.rate
      if (t.volume != null) out.voice.volume = t.volume
      if (t.pitch != null) out.voice.pitch = t.pitch
    }
    const legacyVoice = localStorage.getItem('voice-settings')
    if (legacyVoice) {
      const v = JSON.parse(legacyVoice)
      if (v.useCloneVoice != null) out.voice.useCloneVoice = v.useCloneVoice
    }
  } catch {
    /* ignore */
  }

  if (!out.summon.wakePhrases?.length) {
    out.summon.wakePhrases = [...BUILTIN_WAKE_PHRASES]
  }
  return out
}

function loadSettings(locale: string): VoiceAssistantSettings {
  const defaults = buildDefaults(locale)
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return migrateLegacy(JSON.parse(raw), defaults, locale)
  } catch {
    /* ignore */
  }
  return migrateLegacy({}, defaults, locale)
}

function saveSettings(settings: VoiceAssistantSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    localStorage.setItem(
      'tts-settings',
      JSON.stringify({
        enabled: settings.voice.enabled,
        autoPlay: settings.voice.autoPlay,
        voice: settings.voice.ttsVoice,
        rate: settings.voice.rate,
        volume: settings.voice.volume,
        pitch: settings.voice.pitch,
      }),
    )
    localStorage.setItem(
      'voice-settings',
      JSON.stringify({
        useCloneVoice: settings.voice.useCloneVoice,
      }),
    )
  } catch {
    /* ignore */
  }
}

const settings = ref<VoiceAssistantSettings>(buildDefaults('en'))

export function useVoiceAssistantSettings() {
  const { locale } = useI18n()

  if (!localStorage.getItem(STORAGE_KEY)) {
    settings.value = loadSettings(locale.value)
  } else if (settings.value.summon.idleTimeoutSec === 300 && !localStorage.getItem(STORAGE_KEY)) {
    settings.value = loadSettings(locale.value)
  }

  const honorific = computed(() =>
    normalizeHonorific(settings.value.persona.honorific, locale.value),
  )

  function ensureLoaded() {
    settings.value = loadSettings(locale.value)
    if (!String(settings.value.persona.systemPrompt || '').trim()) {
      settings.value.persona.systemPrompt = DEFAULT_JARVIS_PERSONA_PROMPT
    }
  }

  function updateSummon(patch: Partial<VoiceAssistantSettings['summon']>) {
    settings.value.summon = { ...settings.value.summon, ...patch }
  }

  function updateVoice(patch: Partial<VoiceAssistantSettings['voice']>) {
    settings.value.voice = { ...settings.value.voice, ...patch }
  }

  function updatePersona(patch: Partial<VoiceAssistantSettings['persona']>) {
    settings.value.persona = { ...settings.value.persona, ...patch }
  }

  function resetAll() {
    settings.value = buildDefaults(locale.value)
  }

  watch(
    settings,
    (v) => saveSettings(v),
    { deep: true },
  )

  watch(locale, () => {
    if (!localStorage.getItem(STORAGE_KEY)) {
      settings.value = buildDefaults(locale.value)
    }
  })

  return {
    settings,
    honorific,
    ensureLoaded,
    updateSummon,
    updateVoice,
    updatePersona,
    resetAll,
  }
}

// Bootstrap on module load
try {
  const bootLocale = typeof navigator !== 'undefined' && navigator.language?.startsWith('zh') ? 'zh' : 'en'
  settings.value = loadSettings(bootLocale)
} catch {
  /* ssr */
}
