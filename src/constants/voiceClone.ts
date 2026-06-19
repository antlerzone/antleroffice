/** Fixed script users read when recording a voice clone reference. */
export const VOICE_CLONE_RECORD_SCRIPT_ZH =
  '你好，这是我的声音样本，请用我的声音说话。'

export const VOICE_CLONE_RECORD_SCRIPT_EN =
  'Hello, this is my voice sample for cloning.'

/** Keep short — long scripts make clone slow and may repeat the recording. */
export const VOICE_CLONE_MAX_SCRIPT_CHARS = 48
export const VOICE_CLONE_MAX_RECORD_SEC = 10

export const VOICE_CLONE_PREVIEW_ZH = '仓库已经补货，请到前台领取。'
export const VOICE_CLONE_PREVIEW_EN = 'Your package has arrived at the front desk.'

export type VoiceCloneLang = 'zh' | 'en'

export function defaultRecordLang(locale?: string): VoiceCloneLang {
  const lang = (locale || '').toLowerCase()
  return lang.startsWith('zh') ? 'zh' : 'en'
}

export function defaultRecordScript(locale?: string) {
  return scriptForLang(defaultRecordLang(locale))
}

export function scriptForLang(lang: VoiceCloneLang) {
  return lang === 'zh' ? VOICE_CLONE_RECORD_SCRIPT_ZH : VOICE_CLONE_RECORD_SCRIPT_EN
}

export function previewForLang(lang: VoiceCloneLang) {
  return lang === 'zh' ? VOICE_CLONE_PREVIEW_ZH : VOICE_CLONE_PREVIEW_EN
}

export function inferLangFromText(text: string): VoiceCloneLang {
  return /[\u4e00-\u9fff]/.test(text) ? 'zh' : 'en'
}

export function profileLang(profile: { lang?: string | null; refText?: string | null }): VoiceCloneLang | null {
  if (profile.lang === 'zh' || profile.lang === 'en') return profile.lang
  if (profile.refText?.trim()) return inferLangFromText(profile.refText)
  return null
}

export function langMismatchForTexts(refText: string, preview: string) {
  if (!refText.trim() || !preview.trim()) return false
  return inferLangFromText(refText) !== inferLangFromText(preview)
}

/** Shared opening between script and preview may cause poor clone quality. */
export function sharesOpening(refText: string, preview: string, minChars = 4) {
  const a = refText.replace(/\s/g, '')
  const b = preview.replace(/\s/g, '')
  if (!a || !b) return false
  const limit = Math.min(minChars, a.length, b.length)
  for (let n = limit; n >= 2; n -= 1) {
    if (a.slice(0, n) === b.slice(0, n)) return true
  }
  return false
}
