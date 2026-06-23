export type WakeEngine = 'openwakeword' | 'porcupine' | 'whisper'
export type TtsEngine = 'kokoro' | 'edgetts' | 'webspeech'

export const BUILTIN_WAKE_PHRASES = [
  'Hey Antler',
  'Jarvis',
  '你好 Antler',
  '贾维斯',
] as const

/** Seeded when the user has no custom wake phrases (openWakeWord maps hey_jarvis). */
export const DEFAULT_SUMMON_WAKE_PHRASES = ['Hey Jarvis', 'Hi Jarvis'] as const

/** Added to listener sync when reply language is 中文 (Whisper text match). */
export const DEFAULT_ZH_WAKE_PHRASES = ['贾维斯', '嘿贾维斯', '你好贾维斯'] as const

/** @deprecated Legacy built-ins stripped on settings load; new users start with an empty list. */
export type BuiltinWakePhrase = (typeof BUILTIN_WAKE_PHRASES)[number]

export type ReplyLanguage = 'auto' | 'zh' | 'en'

export function resolveReplyLanguage(
  setting: ReplyLanguage | undefined,
  uiLocale: string,
): 'zh' | 'en' {
  if (setting === 'zh') return 'zh'
  if (setting === 'en') return 'en'
  if (uiLocale.startsWith('zh')) return 'zh'
  return 'en'
}

export function defaultTtsVoiceForLanguage(lang: 'zh' | 'en', engine: TtsEngine): string {
  if (engine === 'edgetts') {
    return lang === 'zh' ? 'zh-CN-YunxiNeural' : 'en-GB-RyanNeural'
  }
  if (engine === 'kokoro') {
    return lang === 'zh' ? 'zf_xiaoni' : 'bm_george'
  }
  return lang === 'zh' ? 'zh-CN' : 'en-GB'
}

export type PersonaReplyVoice = 'default' | 'elevenlabs' | 'fishaudio'

export function defaultHonorific(locale: string): string {
  return locale.startsWith('zh') ? '老板' : 'sir'
}

export function languageSystemHint(lang: 'zh' | 'en'): string {
  if (lang === 'zh') return 'Always reply in Simplified Chinese. Keep sentences short and spoken-aloud friendly.'
  return 'Always reply in English. Keep sentences short and spoken-aloud friendly.'
}

/** Detect whether text is predominantly Chinese or English (for TTS / reply language). */
export function detectTextLanguage(text: string): 'zh' | 'en' {
  const trimmed = String(text || '').trim()
  if (!trimmed) return 'en'
  const cjk = (trimmed.match(/[\u4e00-\u9fff]/g) || []).length
  return cjk / trimmed.length > 0.15 ? 'zh' : 'en'
}

export function buildDefaultSampleReply(honorific: string, locale: string): string {
  const lang = resolveReplyLanguage(
    locale.startsWith('zh') ? 'zh' : locale.startsWith('en') ? 'en' : 'auto',
    locale,
  )
  const h = String(honorific || '').trim() || defaultHonorific(locale)
  if (lang === 'zh') {
    return `${h}，今日办公室一切正常。需要我为您安排什么吗？`
  }
  return `Good morning, ${h}. The office is running smoothly. What would you like me to handle?`
}

/** Persona summon greeting — respects fixed reply language over a mismatched saved line. */
export function resolvePersonaSampleReply(
  saved: string | undefined,
  honorific: string,
  replyLanguage: ReplyLanguage | undefined,
  uiLocale: string,
): string {
  const lang = resolveReplyLanguage(replyLanguage, uiLocale)
  const h = String(honorific || '').trim() || defaultHonorific(lang === 'zh' ? 'zh-CN' : 'en')
  const defaultLine = buildDefaultSampleReply(h, lang === 'zh' ? 'zh' : 'en')
  const trimmed = String(saved || '').trim()
  if (!trimmed) return defaultLine
  if (replyLanguage === 'auto') return trimmed
  if (detectTextLanguage(trimmed) !== lang) return defaultLine
  const otherDefault = buildDefaultSampleReply(h, lang === 'zh' ? 'en' : 'zh')
  if (trimmed === otherDefault) return defaultLine
  return trimmed
}

export function normalizeHonorific(value: string, locale: string): string {
  const trimmed = String(value || '').trim()
  return trimmed || defaultHonorific(locale)
}

/** Default JARVIS system prompt template. Use `{honorific}` as placeholder. */
export const DEFAULT_JARVIS_PERSONA_PROMPT = `You are Jarvis — the local AI assistant for AntlerOffice. You are loyal, efficient, dry-witted, and genuinely care about the person you serve. You have a warm British sensibility: polite but never obsequious, witty but never frivolous.

ADDRESS:
- Use the honorific: {honorific}
- Use it sparingly (2–3 times per reply), not every sentence

PERSONALITY:
- Anticipate needs; be concise and actionable
- Deliver bad news with constructive dry wit
- Calm under pressure; speak as if aloud (no markdown, bullets, or emojis)

CONSTRAINTS:
- Only state facts you can support from context or tools
- Never invent actions you did not perform
- Prefer short spoken sentences over long paragraphs`

export const DEFAULT_JARVIS_PERSONA_PROMPT_ZH = `你是 Jarvis——AntlerOffice 的本地 AI 助手。你忠诚、高效、略带英式冷幽默，真心关心你服务的人。

称呼：
- 使用敬称：{honorific}
- 不要每句都重复敬称（每段 2–3 次即可）

性格：
- 主动预判需求；回答简洁、可执行
- 坏消息用克制幽默带过，并给出下一步
- 沉着冷静；像在当面说话（不要用 markdown、列表或表情）

约束：
- 只陈述有依据的事实
- 不要编造未执行的操作
- 优先短句，适合朗读`

export function applyPersonaTemplate(template: string, vars: { honorific?: string }): string {
  let text = String(template || '').trim()
  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${key}}`, String(value ?? ''))
  }
  return text
}

/** Strip punctuation so stored phrases match Whisper / openWakeWord transcripts. */
export function normalizeWakePhrase(text: string): string {
  return String(text || '')
    .trim()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function migrateWakePhraseClips(
  phrases: string[],
  clips: Record<string, string>,
): Record<string, string> {
  const byNorm = new Map<string, string>()
  for (const [phrase, clipId] of Object.entries(clips || {})) {
    const key = normalizeWakePhrase(phrase).toLowerCase()
    if (key && clipId) byNorm.set(key, clipId)
  }
  const out: Record<string, string> = {}
  for (const phrase of phrases) {
    const clipId = byNorm.get(normalizeWakePhrase(phrase).toLowerCase())
    if (clipId) out[phrase] = clipId
  }
  return out
}

export function isBuiltinWakePhrase(phrase: string): boolean {
  const norm = normalizeWakePhrase(phrase).toLowerCase()
  return BUILTIN_WAKE_PHRASES.some((p) => p.toLowerCase() === norm)
}

export function dedupeWakePhrases(phrases: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of phrases || []) {
    const phrase = normalizeWakePhrase(raw)
    if (!phrase) continue
    const key = phrase.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(phrase)
  }
  return out
}

export function mergeWakePhrase(phrases: string[], toAdd: string): string[] {
  const phrase = normalizeWakePhrase(toAdd)
  if (!phrase) return dedupeWakePhrases(phrases)
  return dedupeWakePhrases([...(phrases || []), phrase])
}

export function stripLegacyBuiltinWakePhrases(phrases: string[]): string[] {
  const legacy = new Set(BUILTIN_WAKE_PHRASES.map((p) => p.toLowerCase()))
  const kept = dedupeWakePhrases(
    (phrases || []).filter((p) => !legacy.has(normalizeWakePhrase(p).toLowerCase())),
  )
  return kept.length ? kept : [...DEFAULT_SUMMON_WAKE_PHRASES]
}

export function splitWakePhrases(phrases: string[]) {
  const builtin: string[] = []
  const custom: string[] = []
  for (const phrase of dedupeWakePhrases(phrases)) {
    if (isBuiltinWakePhrase(phrase)) builtin.push(phrase)
    else custom.push(phrase)
  }
  return { builtin, custom }
}

export const TTS_VOICE_PRESETS: { id: string; engine: TtsEngine; labelKey: string; voice: string }[] = [
  { id: 'kokoro:bm_george', engine: 'kokoro', labelKey: 'pages.settings.voiceAssistant.voices.kokoroBmGeorge', voice: 'bm_george' },
  { id: 'kokoro:bf_emma', engine: 'kokoro', labelKey: 'pages.settings.voiceAssistant.voices.kokoroBfEmma', voice: 'bf_emma' },
  { id: 'edgetts:en-GB-RyanNeural', engine: 'edgetts', labelKey: 'pages.settings.voiceAssistant.voices.edgeGbRyan', voice: 'en-GB-RyanNeural' },
  { id: 'edgetts:en-GB-SoniaNeural', engine: 'edgetts', labelKey: 'pages.settings.voiceAssistant.voices.edgeGbSonia', voice: 'en-GB-SoniaNeural' },
  { id: 'edgetts:en-US-GuyNeural', engine: 'edgetts', labelKey: 'pages.settings.voiceAssistant.voices.edgeUsGuy', voice: 'en-US-GuyNeural' },
  { id: 'edgetts:zh-CN-YunxiNeural', engine: 'edgetts', labelKey: 'pages.settings.voiceAssistant.voices.edgeZhYunxi', voice: 'zh-CN-YunxiNeural' },
  { id: 'edgetts:zh-CN-XiaoxiaoNeural', engine: 'edgetts', labelKey: 'pages.settings.voiceAssistant.voices.edgeZhXiaoxiao', voice: 'zh-CN-XiaoxiaoNeural' },
  { id: 'kokoro:zf_xiaoni', engine: 'kokoro', labelKey: 'pages.settings.voiceAssistant.voices.kokoroZfXiaoni', voice: 'zf_xiaoni' },
  { id: 'webspeech:system', engine: 'webspeech', labelKey: 'pages.settings.voiceAssistant.voices.webSpeech', voice: 'system' },
]
