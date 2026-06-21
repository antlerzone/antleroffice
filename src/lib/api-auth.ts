import { useAuthStore } from '@/stores/auth'
import { useBossStore } from '@/stores/boss'

export function getApiAuthToken(): string {
  const authStore = useAuthStore()
  const bossStore = useBossStore()
  return authStore.getToken() || bossStore.token || ''
}

export function getApiAuthHeaders(options: { contentType?: string | false } = {}): Record<string, string> {
  const bossStore = useBossStore()
  const token = getApiAuthToken()
  const headers: Record<string, string> = { ...bossStore.authHeaders() }
  const { contentType = 'application/json' } = options
  if (contentType) headers['Content-Type'] = contentType
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

/** Boss session + admin gateway auth (Live Chat /api/rpc requires both when AUTH_* is set). */
export async function ensureApiSession(): Promise<void> {
  const authStore = useAuthStore()
  const bossStore = useBossStore()
  await bossStore.ensureSession().catch(() => {})
  await authStore.checkAuthConfig()
  if (!authStore.authEnabled) return
  const valid = await authStore.checkAuth().catch(() => false)
  if (!valid) {
    await authStore.login('admin', 'admin').catch(() => {})
  }
}
