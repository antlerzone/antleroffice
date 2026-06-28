/**
 * Waiting-phrase cache — pre-rendered "holding pattern" audio in the boss's own voice.
 *
 * Cloud TTS (Fish / ElevenLabs) takes ~2s to synthesize, so generating a waiting phrase
 * on demand makes them overlap and cut each other off (and fall back to a robot voice).
 * Instead the boss presses "Save" after setting their voice; we synthesize every phrase
 * once and store the audio locally. At runtime the holding pattern plays the cached clip
 * instantly — always the right voice, never a delay.
 */

import type { SpeakOptions } from '@/composables/useVoiceOutput'

const STORAGE_KEY = 'antleroffice-waiting-phrases-v1'

interface Entry {
  mimeType: string
  audioB64: string
}
type Store = { voiceKey: string; entries: Record<string, Entry> }

/** Identifies which voice the cache was rendered with (engine + voiceId). */
export function buildVoiceKey(opts?: SpeakOptions): string {
  return `${opts?.engine || 'default'}|${opts?.voiceId?.trim() || ''}`
}

function phraseKey(text: string): string {
  return text.trim()
}

function load(): Store | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Store
    if (!parsed?.voiceKey || !parsed.entries) return null
    return parsed
  } catch {
    return null
  }
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

/** Replace the whole cache with freshly rendered phrases for one voice. */
export async function saveWaitingPhrases(
  opts: SpeakOptions | undefined,
  items: Array<{ text: string; blob: Blob }>,
): Promise<void> {
  const entries: Record<string, Entry> = {}
  for (const { text, blob } of items) {
    entries[phraseKey(text)] = { mimeType: blob.type || 'audio/mpeg', audioB64: await blobToBase64(blob) }
  }
  const store: Store = { voiceKey: buildVoiceKey(opts), entries }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
}

/** Cached clip for this phrase, but only if it was rendered with the current voice. */
export function getCachedWaitingPhraseBlob(text: string, opts?: SpeakOptions): Blob | null {
  const store = load()
  if (!store) return null
  if (store.voiceKey !== buildVoiceKey(opts)) return null
  const entry = store.entries[phraseKey(text)]
  if (!entry?.audioB64) return null
  try {
    return base64ToBlob(entry.audioB64, entry.mimeType)
  } catch {
    return null
  }
}

/** Is the cache present and rendered with the current voice? */
export function waitingPhrasesReady(opts?: SpeakOptions): boolean {
  const store = load()
  return !!store && store.voiceKey === buildVoiceKey(opts) && Object.keys(store.entries).length > 0
}

export function clearWaitingPhrases(): void {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}
