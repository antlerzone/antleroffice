/** Chrome blocks Audio.play() until a user gesture — unlock once per session. */
let unlocked = false

export function isAudioPlaybackUnlocked() {
  return unlocked
}

/** Awaitable unlock — must run in a user-gesture handler before TTS playback. */
export async function unlockAudioPlayback(): Promise<boolean> {
  if (unlocked || typeof window === 'undefined') return unlocked
  try {
    const silent = new Audio(
      'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==',
    )
    silent.volume = 0.01
    await silent.play()
    silent.pause()
    unlocked = true
    return true
  } catch {
    /* fall through to AudioContext */
  }
  try {
    const Ctx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (Ctx) {
      const ctx = new Ctx()
      await ctx.resume()
      await ctx.close()
      unlocked = true
      return true
    }
  } catch {
    /* ignore */
  }
  return unlocked
}

export function installAudioUnlockOnGesture() {
  if (typeof window === 'undefined' || unlocked) return () => {}
  const handler = () => {
    void unlockAudioPlayback().then((ok) => {
      if (ok) {
        window.removeEventListener('pointerdown', handler, true)
        window.removeEventListener('keydown', handler, true)
      }
    })
  }
  window.addEventListener('pointerdown', handler, true)
  window.addEventListener('keydown', handler, true)
  return () => {
    window.removeEventListener('pointerdown', handler, true)
    window.removeEventListener('keydown', handler, true)
  }
}
