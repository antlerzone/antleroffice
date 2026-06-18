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

export async function ensureApiSession(): Promise<void> {
  const bossStore = useBossStore()
  await bossStore.ensureSession().catch(() => {})
}
