import { onUnmounted, ref, watch } from 'vue'
import { useWebSocketStore } from '@/stores/websocket'
import { ConnectionState } from '@/api/types'

type GatewayProbe = {
  available?: boolean
  running?: boolean
  ok?: boolean
  url?: string
}

const PROBE_TIMEOUT_MS = 5000
const GATEWAY_START_WAIT_MS = 1200
const OFFLINE_POLL_MS = 5000

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = PROBE_TIMEOUT_MS): Promise<T> {
  const res = await fetch(url, {
    ...init,
    signal: init?.signal || AbortSignal.timeout(timeoutMs),
  })
  return res.json() as Promise<T>
}

export function useLocalGateway() {
  const wsStore = useWebSocketStore()
  const checking = ref(true)
  const live = ref(false)
  const openclawAvailable = ref(false)
  const gatewayUrl = ref('')
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let connectAttempted = false
  let backgroundStarted = false
  let stopWsWatch: (() => void) | null = null

  function applyLiveFromWs() {
    if (wsStore.state === ConnectionState.CONNECTED) {
      live.value = true
      checking.value = false
      stopPolling()
    }
  }

  function bindWsWatch() {
    if (stopWsWatch) return
    stopWsWatch = watch(
      () => wsStore.state,
      () => applyLiveFromWs(),
      { immediate: true },
    )
  }

  async function refresh(options: { markChecking?: boolean } = {}) {
    const markChecking = options.markChecking ?? !live.value
    if (markChecking) checking.value = true
    try {
      const [gwRes, healthRes] = await Promise.all([
        fetchJson<GatewayProbe>('/api/gateway/status').catch(() => ({} as GatewayProbe)),
        fetchJson<{ gateway?: string }>('/api/health').catch(() => ({} as { gateway?: string })),
      ])

      openclawAvailable.value = !!gwRes.available
      gatewayUrl.value = gwRes.url || ''
      const gatewayUp = !!(gwRes.running || gwRes.ok)
      const backendConnected = healthRes.gateway === 'connected'
      const wsUp = wsStore.state === ConnectionState.CONNECTED
      if ((gatewayUp || backendConnected) && !wsUp) {
        await wsStore.ws.syncGatewayState()
        if (wsStore.state !== wsStore.ws.state) wsStore.state = wsStore.ws.state
      }
      live.value = backendConnected || wsStore.state === ConnectionState.CONNECTED
      if (live.value) stopPolling()
    } catch {
      live.value = wsStore.state === ConnectionState.CONNECTED
      if (live.value) stopPolling()
    } finally {
      if (markChecking) checking.value = false
    }
  }

  async function tryStartGateway() {
    if (!openclawAvailable.value || live.value) return
    try {
      await fetchJson('/api/gateway/start', { method: 'POST' }, 8000)
      await new Promise((resolve) => setTimeout(resolve, GATEWAY_START_WAIT_MS))
      await refresh({ markChecking: false })
    } catch {
      /* gateway may still be starting or misconfigured */
    }
  }

  function startPollingWhileOffline() {
    if (live.value || pollTimer) return
    pollTimer = setInterval(() => {
      if (live.value) {
        stopPolling()
        return
      }
      void refresh({ markChecking: false })
    }, OFFLINE_POLL_MS)
  }

  function startBackground() {
    if (backgroundStarted) return
    backgroundStarted = true
    checking.value = true
    bindWsWatch()
    if (!connectAttempted) {
      void wsStore.connect()
      connectAttempted = true
    }
    void (async () => {
      await refresh({ markChecking: true })
      if (!live.value) await tryStartGateway()
      if (!live.value) startPollingWhileOffline()
      else checking.value = false
    })()
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  onUnmounted(() => {
    stopPolling()
    stopWsWatch?.()
    stopWsWatch = null
  })

  return {
    checking,
    live,
    openclawAvailable,
    gatewayUrl,
    refresh,
    startBackground,
    stopPolling,
  }
}
