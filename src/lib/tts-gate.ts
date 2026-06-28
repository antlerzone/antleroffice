/**
 * TTS gate — a tiny shared signal that says "a voice is playing right now".
 *
 * The realtime microphone (VAD) must stay silent while ANY voice plays — the summon
 * greeting, the holding-pattern phrases, or realtime's own replies — otherwise the mic
 * hears the speaker and replies to itself (the "office running smoothly" echo loop).
 *
 * Every TTS playback path calls ttsBegin() when audio starts and ttsEnd() when it stops.
 * A short tail keeps the mic muted just after audio ends, to swallow speaker decay/echo.
 */

let speakingCount = 0
let releaseAt = 0
const TAIL_MS = 700

export function ttsBegin(): void {
  speakingCount++
}

export function ttsEnd(): void {
  speakingCount = Math.max(0, speakingCount - 1)
  // Keep the gate closed for a short tail after the last voice stops.
  releaseAt = Date.now() + TAIL_MS
}

/** True while any voice is playing, or within the short tail after it stopped. */
export function isTtsActive(): boolean {
  return speakingCount > 0 || Date.now() < releaseAt
}

/** Hard reset — used when a session ends, so a stuck counter can't mute the mic forever. */
export function ttsGateReset(): void {
  speakingCount = 0
  releaseAt = 0
}
