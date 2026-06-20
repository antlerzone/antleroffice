import { computed } from 'vue'
import { useSessionStore } from '@/stores/session'
import { useWebSocketStore } from '@/stores/websocket'
import { ConnectionState } from '@/api/types'

export function formatTokenCount(num: number): string {
  if (!num) return '0'
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`
  return String(num)
}

export function useAntlerAgentTokens() {
  const sessionStore = useSessionStore()
  const wsStore = useWebSocketStore()

  const byOpenClawId = computed(() => {
    const stats: Record<string, { input: number; output: number; total: number }> = {}
    for (const session of sessionStore.sessions) {
      const id = (session.agentId || 'main').trim()
      if (!stats[id]) stats[id] = { input: 0, output: 0, total: 0 }
      if (session.tokenUsage) {
        stats[id].input += session.tokenUsage.totalInput || 0
        stats[id].output += session.tokenUsage.totalOutput || 0
        stats[id].total += (session.tokenUsage.totalInput || 0) + (session.tokenUsage.totalOutput || 0)
      }
    }
    return stats
  })

  async function refreshTokenUsage() {
    if (wsStore.state !== ConnectionState.CONNECTED) return
    try {
      await sessionStore.fetchSessions()
    } catch {
      /* ignore — show em dash when unavailable */
    }
  }

  function lookupTokens(openclawAgentId?: string | null, fallbackRole?: string) {
    const key = openclawAgentId || (fallbackRole === 'secretary' || fallbackRole === 'coo' ? 'main' : '') || ''
    if (!key) return null
    const hit = byOpenClawId.value[key]
    if (!hit || !hit.total) return hit || { input: 0, output: 0, total: 0 }
    return hit
  }

  return {
    byOpenClawId,
    refreshTokenUsage,
    lookupTokens,
    connected: computed(() => wsStore.state === ConnectionState.CONNECTED),
  }
}
