import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

const TOKEN_KEY = 'antleroffice2.bossToken'
const ADVANCED_KEY = 'antleroffice2.showAdvanced'

export interface BossSession {
  userId: string
  username: string
  email: string
  plan: string
  creditBalance: number
}

function mapSession(raw: Record<string, unknown> | null): BossSession | null {
  if (!raw) return null
  const user = raw.user as { id?: string; name?: string; email?: string } | undefined
  const subscription = raw.subscription as { plan?: string } | undefined
  const email = user?.email || ''
  const username = user?.name || email || String(raw.username || 'Boss')
  const userId = user?.id || ''
  return {
    userId,
    username,
    email,
    plan: subscription?.plan || '',
    creditBalance: typeof raw.creditBalance === 'number' ? raw.creditBalance : 0,
  }
}

export const useBossStore = defineStore('boss', () => {
  const token = ref(localStorage.getItem(TOKEN_KEY) || '')
  const session = ref<BossSession | null>(null)
  const showAdvanced = ref(localStorage.getItem(ADVANCED_KEY) === '1')
  const ecsEnabled = ref(false)

  const isLoggedIn = computed(() => !!token.value && !!session.value)

  /** Matches server resolveBossOwner — each account gets its own chat threads & queue. */
  const chatOwnerKey = computed(() => {
    if (!session.value) return 'local:boss'
    if (session.value.userId) return `user:${session.value.userId}`
    if (session.value.email) return `email:${session.value.email}`
    return 'local:boss'
  })

  async function loadAuthConfig() {
    try {
      const res = await fetch('/api/boss/auth/config')
      const data = await res.json()
      ecsEnabled.value = !!data.ecsEnabled
      return data
    } catch {
      ecsEnabled.value = false
      return { ecsEnabled: false, mock: true }
    }
  }

  async function login(username: string, password: string) {
    const res = await fetch('/api/boss/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'Login failed')
    token.value = data.token
    session.value = mapSession(data.session)
    localStorage.setItem(TOKEN_KEY, data.token)
  }

  async function refreshSession() {
    if (!token.value) {
      session.value = null
      return false
    }
    const res = await fetch(`/api/boss/auth/session?token=${encodeURIComponent(token.value)}`)
    const data = await res.json()
    if (data.ok) {
      session.value = mapSession(data.session)
      return true
    }
    // Server restarted — boss tokens are in-memory only; re-adopt ECS access token.
    const cfg = await loadAuthConfig()
    if (cfg.ecsEnabled) {
      const { useEcsSessionStore } = await import('@/stores/ecsSession')
      const ecs = useEcsSessionStore()
      ecs.restoreFromStorage()
      if (await ecs.refreshSession().catch(() => false)) return true
    }
    logout()
    return false
  }

  async function heartbeat(retry = true) {
    if (!token.value) return false
    try {
      const res = await fetch('/api/boss/heartbeat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify({ token: token.value }),
      })
      const data = await res.json()
      if (!data.ok) {
        if (retry && res.status === 401 && (await ensureSession())) {
          return heartbeat(false)
        }
        return false
      }
      if (data.session) session.value = mapSession(data.session)
      return true
    } catch {
      return false
    }
  }

  async function adoptToken(nextToken: string) {
    token.value = nextToken
    localStorage.setItem(TOKEN_KEY, nextToken)
    return refreshSession()
  }

  function logout() {
    if (token.value) {
      fetch('/api/boss/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.value }),
      }).catch(() => {})
    }
    token.value = ''
    session.value = null
    localStorage.removeItem(TOKEN_KEY)
  }

  function setShowAdvanced(on: boolean) {
    showAdvanced.value = on
    localStorage.setItem(ADVANCED_KEY, on ? '1' : '0')
  }

  function authHeaders(): Record<string, string> {
    return token.value ? { 'X-Boss-Token': token.value } : {}
  }

  async function ensureSession() {
    if (await refreshSession()) return true
    const cfg = await loadAuthConfig()
    if (cfg.ecsEnabled) {
      // Boss tokens live in server memory — after dev restart, re-adopt ECS access token.
      const { useEcsSessionStore } = await import('@/stores/ecsSession')
      const ecs = useEcsSessionStore()
      ecs.restoreFromStorage()
      if (await ecs.refreshSession().catch(() => false)) return true
      return false
    }
    try {
      await login('boss', 'boss')
      return true
    } catch {
      return false
    }
  }

  return {
    token,
    session,
    showAdvanced,
    ecsEnabled,
    isLoggedIn,
    chatOwnerKey,
    login,
    refreshSession,
    heartbeat,
    adoptToken,
    loadAuthConfig,
    ensureSession,
    logout,
    setShowAdvanced,
    authHeaders,
  }
})
