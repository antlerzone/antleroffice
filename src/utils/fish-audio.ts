/** Fish Audio TTS reference_id: 1–128 chars of [A-Za-z0-9_-] */
const FISH_REFERENCE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export function normalizeFishAudioReferenceId(input: string): string {
  let s = String(input || '').trim()
  if (!s) return ''
  s = s.replace(/^["']|["']$/g, '')

  const fromUrl = s.match(
    /fish\.audio\/(?:voice\/|m\/|model\/|)?([A-Za-z0-9_-]{1,128})/i,
  )
  if (fromUrl?.[1]) return fromUrl[1]

  if (s.includes('/')) {
    const seg = s.split('/').filter(Boolean).pop() || ''
    if (FISH_REFERENCE_ID_RE.test(seg)) return seg
  }

  return s
}

export function isValidFishAudioReferenceId(input: string): boolean {
  return FISH_REFERENCE_ID_RE.test(normalizeFishAudioReferenceId(input))
}
