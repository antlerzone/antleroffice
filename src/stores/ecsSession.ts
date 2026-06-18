import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useBossStore } from '@/stores/boss'

export type EcsOffice = {
  id: string
  name: string
  role?: string
  creditBalance?: number
  inviteCode?: string
  live?: boolean
  lastHeartbeatAt?: number | null
  totalWorker?: number
  totalCreditPerMonth?: number
}

export type EcsUser = {
  id: string
  email: string
  name: string
}

export type EcsSession = {
  accessToken: string
  bossToken: string
  user: EcsUser
  offices: EcsOffice[]
  selectedOfficeId: string | null
  isSaasAdmin?: boolean
}

const STORAGE_KEY = 'antleroffice-ecs-session-v1'

function loadStored(): EcsSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as EcsSession) : null
  } catch {
    return null
  }
}

function saveStored(s: EcsSession) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
}

export const useEcsSessionStore = defineStore('ecsSession', () => {
  const session = ref<EcsSession | null>(loadStored())

  const isLoggedIn = computed(() => !!session.value?.accessToken && !!session.value?.bossToken)

  function applySession(data: {
    accessToken: string
    bossToken: string
    user: EcsUser
    offices?: EcsOffice[]
    selectedOfficeId?: string | null
    isSaasAdmin?: boolean
  }) {
    const next: EcsSession = {
      accessToken: data.accessToken,
      bossToken: data.bossToken,
      user: data.user,
      offices: data.offices || [],
      selectedOfficeId: data.selectedOfficeId ?? data.offices?.[0]?.id ?? null,
      isSaasAdmin: data.isSaasAdmin,
    }
    session.value = next
    saveStored(next)

    const boss = useBossStore()
    boss.adoptToken(next.bossToken).catch(() => {})
    return next
  }

  async function adoptAccessToken(accessToken: string) {
    const res = await fetch('/api/ecs/auth/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || 'Sign-in failed')
    return applySession({
      accessToken: data.accessToken,
      bossToken: data.bossToken,
      user: data.user,
      offices: data.offices,
      selectedOfficeId: data.selectedOfficeId,
      isSaasAdmin: data.isSaasAdmin,
    })
  }

  async function refreshSession() {
    if (!session.value?.bossToken) return false
    try {
      const res = await fetch('/api/ecs/auth/me', {
        headers: {
          'X-Boss-Token': session.value.bossToken,
          'X-Ecs-Access-Token': session.value.accessToken,
        },
      })
      const data = await res.json()
      if (res.ok && data.ok) {
        applySession({
          accessToken: data.accessToken || session.value.accessToken,
          bossToken: data.bossToken || session.value.bossToken,
          user: data.user,
          offices: data.offices,
          selectedOfficeId: data.selectedOfficeId ?? session.value.selectedOfficeId,
          isSaasAdmin: data.isSaasAdmin,
        })
        return true
      }
      // Server may have restarted (e.g. dev --watch after .env write) — re-adopt ECS token.
      if (session.value.accessToken) {
        await adoptAccessToken(session.value.accessToken)
        return true
      }
      clearSession()
      return false
    } catch {
      if (session.value?.accessToken) {
        try {
          await adoptAccessToken(session.value.accessToken)
          return true
        } catch {
          /* fall through */
        }
      }
      clearSession()
      return false
    }
  }

  async function refreshOffices() {
    if (!session.value?.bossToken) return []
    const res = await fetch('/api/ecs/offices', {
      headers: { 'X-Boss-Token': session.value.bossToken },
    })
    const data = await res.json()
    if (!res.ok || !data.ok) return session.value?.offices || []
    if (session.value) {
      session.value = { ...session.value, offices: data.offices || [] }
      saveStored(session.value)
    }
    return data.offices || []
  }

  function selectOffice(officeId: string) {
    if (!session.value) return
    session.value = { ...session.value, selectedOfficeId: officeId }
    saveStored(session.value)
  }

  function clearSession() {
    const boss = useBossStore()
    boss.logout()
    session.value = null
    localStorage.removeItem(STORAGE_KEY)
  }

  function restoreFromStorage() {
    session.value = loadStored()
    if (session.value?.bossToken) {
      const boss = useBossStore()
      boss.adoptToken(session.value.bossToken).catch(() => {})
    }
    return !!session.value
  }

  return {
    session,
    isLoggedIn,
    applySession,
    adoptAccessToken,
    refreshSession,
    refreshOffices,
    selectOffice,
    clearSession,
    restoreFromStorage,
  }
})
