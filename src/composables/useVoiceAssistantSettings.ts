import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useBossStore } from '@/stores/boss'
import {
  DEFAULT_JARVIS_PERSONA_PROMPT,
  DEFAULT_JARVIS_PERSONA_PROMPT_ZH,
  buildDefaultSampleReply,
  defaultHonorific,
  defaultTtsVoiceForLanguage,
  detectTextLanguage,
  normalizeHonorific,
  dedupeWakePhrases,
  migrateWakePhraseClips,
  resolveReplyLanguage,
  stripLegacyBuiltinWakePhrases,
  type TtsEngine,
  type WakeEngine,
  type PersonaReplyVoice,
  type ReplyLanguage,
} from '@/constants/voiceAssistant'
import { clearPersonaGreetingCache } from '@/lib/persona-greeting-cache'
import { summonInfo } from '@/lib/summon-debug'

const STORAGE_KEY = 'voice-assistant-settings'

export type RealtimeProvider = 'openai' | 'doubao'
/** OpenClaw voice pipeline (local VAD + Whisper STT + OpenClaw + TTS). Wake word stays on Python sidecar. */
export type RealtimeVoiceOutput = 'openai' | 'elevenlabs' | 'fishaudio' | 'browser' | 'edgetts'
export type OpenAIRealtimeVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer' | 'verse' | 'ballad'

export interface VoiceAssistantSettings {
  summon: {
    globalListenEnabled: boolean
    wakeEngine: WakeEngine
    /** When false, acoustic engines (openWakeWord) wake by sound without STT text confirmation. */
    wakeRequireStt?: boolean
    wakePhrases: string[]
    idleTimeoutSec: number
    porcupineAccessKey: string
    sensitivity: number
    wakePhraseClips?: Record<string, string>
    /** null = system default / auto-scan */
    inputDeviceIndex: number | null
    /** Spoken on wake (summon greeting); cached for instant playback. */
    sampleReply: string
    replyVoice: PersonaReplyVoice
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
    /** Fixed reply language for summon + voice commands (auto = follow UI locale). */
    replyLanguage: ReplyLanguage
    elevenLabsApiKey: string
    elevenLabsVoiceId: string
    fishAudioApiKey: string
    fishAudioVoiceId: string
  }
  persona: {
    enabled: boolean
    honorific: string
    systemPrompt: string
  }
  realtime: {
    enabled: boolean
    provider: RealtimeProvider
    openaiApiKey: string
    doubaoApiKey: string
    model: string
    voice: OpenAIRealtimeVoice
    systemPrompt: string
    // Voice output: openai = use OpenAI built-in voice, elevenlabs = pipe text to ElevenLabs TTS
    voiceOutput: RealtimeVoiceOutput
    elevenLabsApiKey: string
    elevenLabsVoiceId: string
    // Fish Audio TTS
    fishAudioApiKey: string
    fishAudioVoiceId: string        // reference_id
    // OpenAI model selection (used when voiceOutput === 'openai')
    openaiTtsModel: string          // e.g. 'gpt-4o-mini-tts' | 'tts-1' | 'tts-1-hd'
    openaiSttModel: string          // e.g. 'gpt-4o-mini-transcribe' | 'whisper-1'
    /** Play immediately after STT, before OpenClaw (fills dead air). */
    thinkingChimeEnabled: boolean
    thinkingChimeText: string
  }
  /** Voice STT model + optional OpenAI key override. Reuses OpenClaw key by default. */
  voiceApi: {
    sttApiKey: string
    openaiSttModel: string
    hasSttKey?: boolean
    openclawOpenAiKeyConfigured?: boolean
    sttKeyAvailable?: boolean
    /** Last 4 chars of the configured OpenAI key — masked UI hint only. */
    openaiKeyLast4?: string
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
      wakeRequireStt: false,
      wakePhrases: [],
      idleTimeoutSec: 300,
      porcupineAccessKey: '',
      sensitivity: 0.5,
      wakePhraseClips: {},
      inputDeviceIndex: null,
      sampleReply: '',
      replyVoice: 'default',
    },
    voice: {
      enabled: envBool('VITE_TTS_ENABLED', true),
      autoPlay: envBool('VITE_TTS_AUTO_PLAY', true),
      streamingTts: true,
      ttsEngine: 'edgetts',
      ttsVoice: 'en-GB-RyanNeural',
      rate: envNum('VITE_TTS_RATE', 1.0),
      volume: envNum('VITE_TTS_VOLUME', 1.0),
      pitch: envNum('VITE_TTS_PITCH', 1.0),
      useCloneVoice: false,
      replyLanguage: locale.startsWith('zh') ? 'zh' : 'en',
      elevenLabsApiKey: '',
      elevenLabsVoiceId: '',
      fishAudioApiKey: '',
      fishAudioVoiceId: '',
    },
    persona: {
      enabled: true,
      honorific: defaultHonorific(locale),
      systemPrompt: DEFAULT_JARVIS_PERSONA_PROMPT,
    },
    realtime: {
      enabled: true,
      provider: 'openai',
      openaiApiKey: '',
      doubaoApiKey: '',
      model: 'gpt-realtime-2',
      voice: 'alloy',
      systemPrompt: '',
      voiceOutput: 'openai',
      elevenLabsApiKey: '',
      elevenLabsVoiceId: '',
      fishAudioApiKey: '',
      fishAudioVoiceId: '',
      openaiTtsModel: 'gpt-4o-mini-tts',
      openaiSttModel: 'gpt-4o-mini-transcribe',
      thinkingChimeEnabled: true,
      thinkingChimeText: locale.startsWith('zh') ? '嗯…' : 'Hmm…',
    },
    voiceApi: {
      sttApiKey: '',
      openaiSttModel: 'gpt-4o-mini-transcribe',
    },
  }
}

function migrateLegacy(stored: Partial<VoiceAssistantSettings>, defaults: VoiceAssistantSettings, locale: string): VoiceAssistantSettings {
  const out = { ...defaults, ...stored }
  out.summon = { ...defaults.summon, ...(stored.summon || {}) }
  if (!out.summon.wakePhraseClips) out.summon.wakePhraseClips = {}
  if (out.summon.inputDeviceIndex === undefined) out.summon.inputDeviceIndex = null
  out.summon.wakeEngine = 'openwakeword'
  // Acoustic wake: openWakeWord matches "Hey Jarvis" by sound, so never gate it
  // behind STT text matching (which mis-hears Jarvis as guys/Jason/Bryan).
  out.summon.wakeRequireStt = false
  out.realtime = { ...defaults.realtime, ...(stored.realtime || {}) }
  // Final decision: no OpenAI realtime. The assistant uses the listener command flow.
  out.realtime.enabled = false
  out.voice = { ...defaults.voice, ...(stored.voice || {}) }
  // Migrate the retired 'cosyvoice' engine from older stored settings.
  if ((out.voice.ttsEngine as string) === 'cosyvoice') {
    out.voice.ttsEngine = 'edgetts'
    out.voice.useCloneVoice = false
  }
  if (out.voice.useCloneVoice) {
    out.voice.useCloneVoice = false
  }
  if (!out.voice.replyLanguage) {
    out.voice.replyLanguage = locale.startsWith('zh') ? 'zh' : 'en'
  }
  if (!out.voice.elevenLabsApiKey && out.realtime.elevenLabsApiKey) {
    out.voice.elevenLabsApiKey = out.realtime.elevenLabsApiKey
  }
  if (!out.voice.elevenLabsVoiceId && out.realtime.elevenLabsVoiceId) {
    out.voice.elevenLabsVoiceId = out.realtime.elevenLabsVoiceId
  }
  if (!out.voice.fishAudioApiKey && out.realtime.fishAudioApiKey) {
    out.voice.fishAudioApiKey = out.realtime.fishAudioApiKey
  }
  if (!out.voice.fishAudioVoiceId && out.realtime.fishAudioVoiceId) {
    out.voice.fishAudioVoiceId = out.realtime.fishAudioVoiceId
  }
  // Keep realtime + voice cloud keys in sync (legacy writes may only touch realtime).
  if (out.realtime.elevenLabsApiKey && !out.voice.elevenLabsApiKey) {
    out.voice.elevenLabsApiKey = out.realtime.elevenLabsApiKey
  }
  if (out.realtime.elevenLabsVoiceId && !out.voice.elevenLabsVoiceId) {
    out.voice.elevenLabsVoiceId = out.realtime.elevenLabsVoiceId
  }
  if (out.realtime.fishAudioApiKey && !out.voice.fishAudioApiKey) {
    out.voice.fishAudioApiKey = out.realtime.fishAudioApiKey
  }
  if (out.realtime.fishAudioVoiceId && !out.voice.fishAudioVoiceId) {
    out.voice.fishAudioVoiceId = out.realtime.fishAudioVoiceId
  }
  if (out.voice.elevenLabsApiKey) out.realtime.elevenLabsApiKey = out.voice.elevenLabsApiKey
  if (out.voice.elevenLabsVoiceId) out.realtime.elevenLabsVoiceId = out.voice.elevenLabsVoiceId
  if (out.voice.fishAudioApiKey) out.realtime.fishAudioApiKey = out.voice.fishAudioApiKey
  if (out.voice.fishAudioVoiceId) out.realtime.fishAudioVoiceId = out.voice.fishAudioVoiceId
  out.persona = { ...defaults.persona, ...(stored.persona || {}) }
  out.realtime = { ...defaults.realtime, ...(stored.realtime || {}) }
  out.voiceApi = { ...defaults.voiceApi, ...(stored.voiceApi || {}) }
  // Migrate: ensure new fields have defaults if absent from stored data
  if (!out.realtime.fishAudioApiKey) out.realtime.fishAudioApiKey = ''
  if (!out.realtime.fishAudioVoiceId) out.realtime.fishAudioVoiceId = ''
  if (!out.realtime.openaiTtsModel) out.realtime.openaiTtsModel = 'gpt-4o-mini-tts'
  if (!out.realtime.openaiSttModel) out.realtime.openaiSttModel = 'gpt-4o-mini-transcribe'
  if (!out.voiceApi.openaiSttModel) out.voiceApi.openaiSttModel = out.realtime.openaiSttModel
  // Migrate legacy realtime.openaiApiKey → voiceApi user key
  const legacySttKey = String(out.realtime.openaiApiKey || '').trim()
  if (legacySttKey && !String(out.voiceApi.sttApiKey || '').trim()) {
    out.voiceApi.sttApiKey = legacySttKey
  }
  // Drop legacy BYOK toggle fields from stored JSON
  const legacyVa = stored.voiceApi as { useOwnSttKey?: boolean } | undefined
  if (legacyVa?.useOwnSttKey && legacySttKey && !out.voiceApi.sttApiKey) {
    out.voiceApi.sttApiKey = legacySttKey
  }
  if (out.realtime.thinkingChimeEnabled === undefined) out.realtime.thinkingChimeEnabled = true
  if (!out.realtime.thinkingChimeText) {
    out.realtime.thinkingChimeText = locale.startsWith('zh') ? '嗯…' : 'Hmm…'
  }
  // Migrate old ephemeral-key-era model names to direct-WS compatible model
  const oldModels = [
    'gpt-realtime', 'gpt-realtime-2025-08-28', 'gpt-realtime-1.5',
    'gpt-4o-realtime-preview', 'gpt-4o-realtime-preview-2024-12-17',
    'gpt-4o-mini-realtime-preview', 'gpt-4o-mini-realtime-preview-2024-12-17',
  ]
  if (oldModels.includes(out.realtime.model)) {
    out.realtime.model = 'gpt-realtime-2'
  }

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
  const legacyPersonaFields = stored.persona as
    | { sampleReply?: string; replyVoice?: PersonaReplyVoice }
    | undefined
  if (!out.summon.sampleReply && legacyPersonaFields?.sampleReply) {
    out.summon.sampleReply = legacyPersonaFields.sampleReply
  }
  if (!out.summon.replyVoice && legacyPersonaFields?.replyVoice) {
    out.summon.replyVoice = legacyPersonaFields.replyVoice
  }
  if (out.summon.sampleReply === undefined) out.summon.sampleReply = ''
  if (!out.summon.replyVoice) out.summon.replyVoice = 'default'
  if (
    out.summon.replyVoice === 'default' &&
    out.realtime.voiceOutput === 'elevenlabs' &&
    out.voice.elevenLabsApiKey?.trim() &&
    out.voice.elevenLabsVoiceId?.trim()
  ) {
    out.summon.replyVoice = 'elevenlabs'
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

  out.summon.wakePhrases = dedupeWakePhrases(
    stripLegacyBuiltinWakePhrases(out.summon.wakePhrases || []),
  )
  out.summon.wakePhraseClips = migrateWakePhraseClips(
    out.summon.wakePhrases,
    out.summon.wakePhraseClips || {},
  )
  const resolvedLang = resolveReplyLanguage(out.voice.replyLanguage, locale)
  if (out.voice.replyLanguage !== 'auto') {
    const sample = out.summon.sampleReply?.trim()
    if (sample && detectTextLanguage(sample) !== resolvedLang) {
      out.summon.sampleReply = buildDefaultSampleReply(
        out.persona.honorific,
        resolvedLang === 'zh' ? 'zh' : 'en',
      )
      clearPersonaGreetingCache()
    }
    const enPrompt = DEFAULT_JARVIS_PERSONA_PROMPT.trim()
    const zhPrompt = DEFAULT_JARVIS_PERSONA_PROMPT_ZH.trim()
    const prompt = out.persona.systemPrompt?.trim()
    if (resolvedLang === 'zh' && (!prompt || prompt === enPrompt)) {
      out.persona.systemPrompt = DEFAULT_JARVIS_PERSONA_PROMPT_ZH
    }
    if (resolvedLang === 'en' && (!prompt || prompt === zhPrompt)) {
      out.persona.systemPrompt = DEFAULT_JARVIS_PERSONA_PROMPT
    }
    if (resolvedLang === 'zh' && (out.persona.honorific === 'sir' || out.persona.honorific === 'boss')) {
      out.persona.honorific = '老板'
    }
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
  // Mirror to backend, but only after hydration so the initial default-load
  // can't clobber a backend that another origin already seeded.
  if (hydrationDone) postSettingsToServer(settings)
}

const settings = ref<VoiceAssistantSettings>(buildDefaults('en'))
let serverHydrateStarted = false
let hydrationDone = false

function postSettingsToServer(value: VoiceAssistantSettings) {
  try {
    void fetch('/api/voice/assistant-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: value }),
    }).catch(() => {})
  } catch {
    /* ignore */
  }
}

export function useVoiceAssistantSettings() {
  const { locale } = useI18n()
  const boss = useBossStore()

  if (!localStorage.getItem(STORAGE_KEY)) {
    settings.value = loadSettings(locale.value)
  } else if (settings.value.summon.idleTimeoutSec === 300 && !localStorage.getItem(STORAGE_KEY)) {
    settings.value = loadSettings(locale.value)
  }

  if (!serverHydrateStarted) {
    serverHydrateStarted = true
    void hydrateFromServer()
  }

  const honorific = computed(() =>
    normalizeHonorific(settings.value.persona.honorific, locale.value),
  )

  function ensureLoaded() {
    settings.value = loadSettings(locale.value)
    if (!String(settings.value.persona.systemPrompt || '').trim()) {
      settings.value.persona.systemPrompt = DEFAULT_JARVIS_PERSONA_PROMPT
    }
    void loadVoiceApiFromServer()
  }

  function updateSummon(patch: Partial<VoiceAssistantSettings['summon']>) {
    settings.value.summon = { ...settings.value.summon, ...patch }
  }

  function syncCloudTtsKeys() {
    const v = settings.value.voice
    const rt = settings.value.realtime
    settings.value.realtime = {
      ...rt,
      elevenLabsApiKey: v.elevenLabsApiKey || rt.elevenLabsApiKey,
      elevenLabsVoiceId: v.elevenLabsVoiceId || rt.elevenLabsVoiceId,
      fishAudioApiKey: v.fishAudioApiKey || rt.fishAudioApiKey,
      fishAudioVoiceId: v.fishAudioVoiceId || rt.fishAudioVoiceId,
    }
    settings.value.voice = {
      ...v,
      elevenLabsApiKey: v.elevenLabsApiKey || rt.elevenLabsApiKey,
      elevenLabsVoiceId: v.elevenLabsVoiceId || rt.elevenLabsVoiceId,
      fishAudioApiKey: v.fishAudioApiKey || rt.fishAudioApiKey,
      fishAudioVoiceId: v.fishAudioVoiceId || rt.fishAudioVoiceId,
    }
  }

  function updateVoice(patch: Partial<VoiceAssistantSettings['voice']>) {
    settings.value.voice = { ...settings.value.voice, ...patch }
    syncCloudTtsKeys()
  }

  function applyReplyLanguageChange(lang: ReplyLanguage) {
    const resolved = resolveReplyLanguage(lang, locale.value)
    const engine = settings.value.voice.ttsEngine
    updateVoice({
      replyLanguage: lang,
      ttsVoice: defaultTtsVoiceForLanguage(resolved, engine),
    })

    const persona = settings.value.persona
    const summon = settings.value.summon
    const personaPatch: Partial<VoiceAssistantSettings['persona']> = {}
    const summonPatch: Partial<VoiceAssistantSettings['summon']> = {}
    const h = persona.honorific?.trim()
    if (resolved === 'zh' && (!h || h === 'sir' || h === 'boss')) {
      personaPatch.honorific = '老板'
    } else if (resolved === 'en' && (!h || h === '老板')) {
      personaPatch.honorific = 'sir'
    }

    const honorificForDefault = personaPatch.honorific || h || defaultHonorific(locale.value)
    const zhDefault = buildDefaultSampleReply(honorificForDefault, 'zh')
    const enDefault = buildDefaultSampleReply(honorificForDefault, 'en')
    const saved = summon.sampleReply?.trim()
    const enPrompt = DEFAULT_JARVIS_PERSONA_PROMPT.trim()
    const zhPrompt = DEFAULT_JARVIS_PERSONA_PROMPT_ZH.trim()
    const prompt = persona.systemPrompt?.trim()

    if (lang !== 'auto') {
      if (!saved || saved === zhDefault || saved === enDefault || detectTextLanguage(saved) !== resolved) {
        summonPatch.sampleReply = resolved === 'zh' ? zhDefault : enDefault
        clearPersonaGreetingCache()
      }
      if (!prompt || prompt === enPrompt || prompt === zhPrompt) {
        personaPatch.systemPrompt = resolved === 'zh' ? DEFAULT_JARVIS_PERSONA_PROMPT_ZH : DEFAULT_JARVIS_PERSONA_PROMPT
      }
    }

    if (Object.keys(personaPatch).length) {
      updatePersona(personaPatch)
    }
    if (Object.keys(summonPatch).length) {
      updateSummon(summonPatch)
    }
    summonInfo('reply language changed', {
      setting: lang,
      resolved,
      sampleReply: summonPatch.sampleReply || summon.sampleReply,
      honorific: personaPatch.honorific || persona.honorific,
    })
  }

  function updatePersona(patch: Partial<VoiceAssistantSettings['persona']>) {
    settings.value.persona = { ...settings.value.persona, ...patch }
  }

  function updateRealtime(patch: Partial<VoiceAssistantSettings['realtime']>) {
    settings.value.realtime = { ...settings.value.realtime, ...patch }
    if (
      patch.elevenLabsApiKey !== undefined ||
      patch.elevenLabsVoiceId !== undefined ||
      patch.fishAudioApiKey !== undefined ||
      patch.fishAudioVoiceId !== undefined
    ) {
      settings.value.voice = {
        ...settings.value.voice,
        elevenLabsApiKey:
          patch.elevenLabsApiKey !== undefined
            ? patch.elevenLabsApiKey
            : settings.value.voice.elevenLabsApiKey,
        elevenLabsVoiceId:
          patch.elevenLabsVoiceId !== undefined
            ? patch.elevenLabsVoiceId
            : settings.value.voice.elevenLabsVoiceId,
        fishAudioApiKey:
          patch.fishAudioApiKey !== undefined
            ? patch.fishAudioApiKey
            : settings.value.voice.fishAudioApiKey,
        fishAudioVoiceId:
          patch.fishAudioVoiceId !== undefined
            ? patch.fishAudioVoiceId
            : settings.value.voice.fishAudioVoiceId,
      }
    }
  }

  function updateVoiceApi(patch: Partial<VoiceAssistantSettings['voiceApi']>) {
    settings.value.voiceApi = { ...settings.value.voiceApi, ...patch }
    if (patch.openaiSttModel) {
      settings.value.realtime.openaiSttModel = patch.openaiSttModel
    }
    const key = patch.sttApiKey?.trim()
    if (key) {
      settings.value.realtime.openaiApiKey = key
    }
    void syncVoiceApiToServer()
  }

  function userOpenAiKey(): string {
    const va = settings.value.voiceApi
    return va.sttApiKey?.trim() || settings.value.realtime.openaiApiKey?.trim() || ''
  }

  function hasUserOpenAiKey(): boolean {
    const va = settings.value.voiceApi
    return (
      !!userOpenAiKey() ||
      !!va.hasSttKey ||
      !!va.openclawOpenAiKeyConfigured ||
      !!va.sttKeyAvailable
    )
  }

  function applyVoiceApiFromServer(prefs: {
    hasSttKey?: boolean
    openaiSttModel?: string
    openclawOpenAiKeyConfigured?: boolean
    sttKeyAvailable?: boolean
    openaiKeyLast4?: string
  }) {
    const localKey = settings.value.voiceApi.sttApiKey?.trim()
    settings.value.voiceApi = {
      ...settings.value.voiceApi,
      hasSttKey: !!prefs.hasSttKey,
      openaiSttModel: prefs.openaiSttModel || settings.value.voiceApi.openaiSttModel,
      openclawOpenAiKeyConfigured: !!prefs.openclawOpenAiKeyConfigured,
      sttKeyAvailable: !!prefs.sttKeyAvailable,
      openaiKeyLast4: prefs.openaiKeyLast4 || '',
      sttApiKey: localKey || settings.value.voiceApi.sttApiKey,
    }
  }

  async function syncVoiceApiToServer() {
    const boss = useBossStore()
    if (!boss.token) return
    const va = settings.value.voiceApi
    try {
      const res = await fetch('/api/voice/api-preferences', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...boss.authHeaders(),
        },
        body: JSON.stringify({
          sttApiKey: va.sttApiKey?.trim() || undefined,
          openaiSttModel: va.openaiSttModel,
          clearSttKey: !va.sttApiKey?.trim() && !va.hasSttKey,
        }),
      })
      const data = await res.json() as {
        ok?: boolean
        preferences?: {
          hasSttKey?: boolean
          openaiSttModel?: string
          openclawOpenAiKeyConfigured?: boolean
          sttKeyAvailable?: boolean
        }
      }
      if (data.ok && data.preferences) {
        applyVoiceApiFromServer(data.preferences)
      }
    } catch {
      /* local-only fallback */
    }
  }

  // Backend is the shared source of truth. On first use: if the backend has a
  // saved blob, adopt it; otherwise, if THIS origin already has settings, push
  // them up once to seed the backend so other origins inherit the keys.
  async function hydrateFromServer() {
    let applied = false
    try {
      const res = await fetch('/api/voice/assistant-settings')
      const data = (await res.json()) as {
        ok?: boolean
        settings?: Partial<VoiceAssistantSettings> | null
      }
      if (
        data?.ok &&
        data.settings &&
        typeof data.settings === 'object' &&
        Object.keys(data.settings).length
      ) {
        settings.value = migrateLegacy(data.settings, buildDefaults(locale.value), locale.value)
        applied = true
      }
    } catch {
      /* ignore */
    }
    if (!applied) {
      // Backend empty: seed it from THIS origin's saved settings (the browser
      // where keys were first entered) so other origins inherit them.
      try {
        if (localStorage.getItem(STORAGE_KEY)) {
          const local = loadSettings(locale.value)
          settings.value = local
          postSettingsToServer(local)
        }
      } catch {
        /* ignore */
      }
    }
    hydrationDone = true
  }

  async function loadVoiceApiFromServer() {
    const boss = useBossStore()
    if (!boss.token) return
    try {
      const res = await fetch('/api/voice/api-preferences', { headers: boss.authHeaders() })
      const data = await res.json() as {
        ok?: boolean
        preferences?: {
          hasSttKey?: boolean
          openaiSttModel?: string
          openclawOpenAiKeyConfigured?: boolean
          sttKeyAvailable?: boolean
        }
      }
      if (!data.ok || !data.preferences) return
      applyVoiceApiFromServer(data.preferences)
    } catch {
      /* ignore */
    }
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

  watch(
    () => boss.token,
    () => {
      void loadVoiceApiFromServer()
    },
  )

  return {
    settings,
    honorific,
    ensureLoaded,
    updateSummon,
    updateVoice,
    applyReplyLanguageChange,
    updatePersona,
    updateRealtime,
    updateVoiceApi,
    syncVoiceApiToServer,
    loadVoiceApiFromServer,
    userOpenAiKey,
    hasUserOpenAiKey,
    resetAll,
  }
}

// Bootstrap on module load
try {
  const bootLocale = typeof navigator !== 'undefined' && navigator.language?.startsWith('zh') ? 'zh' : 'en'
  settings.value = loadSettings(bootLocale)
  void fetch('/api/voice/api-preferences')
    .then((r) => r.json())
    .then((data: {
      ok?: boolean
      preferences?: {
        openaiSttModel?: string
        hasSttKey?: boolean
        openclawOpenAiKeyConfigured?: boolean
        sttKeyAvailable?: boolean
      }
    }) => {
      if (!data.ok || !data.preferences) return
      if (data.preferences.hasSttKey) settings.value.voiceApi.hasSttKey = true
      if (data.preferences.openaiSttModel) {
        settings.value.voiceApi.openaiSttModel = data.preferences.openaiSttModel
      }
      if (data.preferences.openclawOpenAiKeyConfigured) {
        settings.value.voiceApi.openclawOpenAiKeyConfigured = true
      }
      if (data.preferences.sttKeyAvailable) {
        settings.value.voiceApi.sttKeyAvailable = true
      }
    })
    .catch(() => { /* offline */ })
} catch {
  /* ssr */
}
