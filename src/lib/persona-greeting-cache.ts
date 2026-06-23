import type { SpeakOptions } from '@/composables/useVoiceOutput'

const STORAGE_KEY = 'antleroffice-persona-greeting-v1'
const MAX_B64_CHARS = 900_000

export interface PersonaGreetingCacheEntry {
  cacheKey: string
  text: string
  mimeType: string
  audioB64: string
  savedAt: number
}

export function buildGreetingCacheKey(text: string, opts?: SpeakOptions): string {
  const engine = opts?.engine || 'default'
  const voiceId = opts?.voiceId?.trim() || ''
  return `${engine}|${voiceId}|${text.trim()}`
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const comma = dataUrl.indexOf(',')
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl)
    }
    reader.onerror = () => reject(reader.error || new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}

function base64ToBlob(b64: string, mimeType: string): Blob {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mimeType || 'audio/mpeg' })
}

export function loadPersonaGreetingCache(): PersonaGreetingCacheEntry | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersonaGreetingCacheEntry
    if (!parsed?.cacheKey || !parsed.audioB64) return null
    return parsed
  } catch {
    return null
  }
}

export async function savePersonaGreetingCache(
  text: string,
  opts: SpeakOptions | undefined,
  blob: Blob,
): Promise<void> {
  const cacheKey = buildGreetingCacheKey(text, opts)
  const audioB64 = await blobToBase64(blob)
  if (audioB64.length > MAX_B64_CHARS) {
    throw new Error('Greeting audio too large to cache locally')
  }
  const entry: PersonaGreetingCacheEntry = {
    cacheKey,
    text: text.trim(),
    mimeType: blob.type || 'audio/mpeg',
    audioB64,
    savedAt: Date.now(),
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entry))
}

export function getCachedGreetingBlob(text: string, opts?: SpeakOptions): Blob | null {
  const entry = loadPersonaGreetingCache()
  if (!entry) return null
  const key = buildGreetingCacheKey(text, opts)
  if (entry.cacheKey !== key) return null
  try {
    return base64ToBlob(entry.audioB64, entry.mimeType)
  } catch {
    return null
  }
}

export function clearPersonaGreetingCache() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
