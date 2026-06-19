export type WakeEngine = 'openwakeword' | 'porcupine' | 'whisper'
export type WakeChimeMode = 'off' | 'beep' | 'tts'
export type TtsEngine = 'cosyvoice' | 'kokoro' | 'edgetts' | 'webspeech'

export const BUILTIN_WAKE_PHRASES = [
  'Hey Antler',
  'Jarvis',
  '你好 Antler',
  '贾维斯',
] as const

export type BuiltinWakePhrase = (typeof BUILTIN_WAKE_PHRASES)[number]

export function defaultHonorific(locale: string): string {
  return locale.startsWith('zh') ? '老板' : 'sir'
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

export function applyPersonaTemplate(template: string, vars: { honorific?: string }): string {
  let text = String(template || '').trim()
  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${key}}`, String(value ?? ''))
  }
  return text
}

export function normalizeWakePhrase(text: string): string {
  return String(text || '').trim().replace(/\s+/g, ' ')
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
  { id: 'kokoro:bm_george', engine: 'kokoro', labelKey: 'voiceAssistant.voices.kokoroBmGeorge', voice: 'bm_george' },
  { id: 'kokoro:bf_emma', engine: 'kokoro', labelKey: 'voiceAssistant.voices.kokoroBfEmma', voice: 'bf_emma' },
  { id: 'edgetts:en-GB-RyanNeural', engine: 'edgetts', labelKey: 'voiceAssistant.voices.edgeGbRyan', voice: 'en-GB-RyanNeural' },
  { id: 'edgetts:en-GB-SoniaNeural', engine: 'edgetts', labelKey: 'voiceAssistant.voices.edgeGbSonia', voice: 'en-GB-SoniaNeural' },
  { id: 'edgetts:en-US-GuyNeural', engine: 'edgetts', labelKey: 'voiceAssistant.voices.edgeUsGuy', voice: 'en-US-GuyNeural' },
  { id: 'cosyvoice:clone', engine: 'cosyvoice', labelKey: 'voiceAssistant.voices.cosyClone', voice: 'clone' },
  { id: 'webspeech:system', engine: 'webspeech', labelKey: 'voiceAssistant.voices.webSpeech', voice: 'system' },
]
