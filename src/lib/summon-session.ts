import { ref } from 'vue'

/** True after summon until idle timeout (default 5 min). */
export const summonSessionActive = ref(false)

let lastActivityAt = 0
let idleTimer: ReturnType<typeof setInterval> | null = null

export function markSummonSessionActive() {
  summonSessionActive.value = true
  touchSummonActivity()
}

export function clearSummonSession() {
  summonSessionActive.value = false
  stopSummonIdleWatch()
}

export function touchSummonActivity() {
  lastActivityAt = Date.now()
}

export function startSummonIdleWatch(getTimeoutSec: () => number, isActive: () => boolean) {
  stopSummonIdleWatch()
  touchSummonActivity()
  idleTimer = setInterval(() => {
    if (!isActive()) return
    const timeoutMs = Math.max(60, getTimeoutSec()) * 1000
    if (Date.now() - lastActivityAt > timeoutMs) {
      stopSummonIdleWatch()
      window.dispatchEvent(
        new CustomEvent('antler:summon-idle', { detail: { reason: 'client-idle-timeout' } }),
      )
    }
  }, 10_000)
}

export function stopSummonIdleWatch() {
  if (idleTimer) {
    clearInterval(idleTimer)
    idleTimer = null
  }
}
