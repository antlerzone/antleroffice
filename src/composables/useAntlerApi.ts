import { useBossStore } from '@/stores/boss'
import { useOfficeShareStore } from '@/stores/officeShare'

export function useAntlerApi() {
  const boss = useBossStore()
  const officeShare = useOfficeShareStore()

  async function resolveRequest(path: string) {
    const share = await officeShare.ensureLoaded()
    if (share?.enabled && share.role === 'member' && share.hostUrl) {
      const base = share.hostUrl.replace(/\/+$/, '')
      return { url: `${base}${path}`, memberToken: share.memberToken }
    }
    return { url: path, memberToken: null }
  }

  function buildHeaders(memberToken: string | null) {
    const headers: Record<string, string> = { ...boss.authHeaders() }
    if (memberToken) headers['X-Office-Member-Token'] = memberToken
    return headers
  }

  async function get<T = unknown>(path: string, opts: { timeoutMs?: number } = {}): Promise<T> {
    const { url, memberToken } = await resolveRequest(path)
    const ctrl = opts.timeoutMs ? new AbortController() : undefined
    const timer = ctrl && opts.timeoutMs
      ? setTimeout(() => ctrl.abort(), opts.timeoutMs)
      : null
    try {
      const res = await fetch(url, {
        headers: buildHeaders(memberToken),
        signal: ctrl?.signal,
      })
      if (!res.ok) throw new Error(`${res.status} ${path}`)
      return res.json() as Promise<T>
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function send<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const { url, memberToken } = await resolveRequest(path)
    const ctrl = opts.timeoutMs ? new AbortController() : undefined
    const timer = ctrl && opts.timeoutMs
      ? setTimeout(() => ctrl.abort(), opts.timeoutMs)
      : null
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...buildHeaders(memberToken),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl?.signal,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || `${res.status}`)
      return data as T
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return { get, send }
}
