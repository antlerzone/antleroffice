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
      const contentType = res.headers.get('content-type') || ''
      const data = contentType.includes('json')
        ? await res.json().catch(() => ({}))
        : {}
      if (!res.ok) {
        if (!contentType.includes('json')) {
          const hint =
            contentType.includes('html') || contentType.includes('text/html')
              ? ' (wrong dev port — restart with npm run dev:electron)'
              : ''
          throw new Error(`${res.status}${hint}`)
        }
        throw new Error((data as { error?: string }).error || `${res.status}`)
      }
      if (!contentType.includes('json')) {
        throw new Error('Expected JSON response from API')
      }
      return data as T
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function sendForm<T = unknown>(
    method: string,
    path: string,
    formData: FormData,
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
        headers: buildHeaders(memberToken),
        body: formData,
        signal: ctrl?.signal,
      })
      const contentType = res.headers.get('content-type') || ''
      if (!res.ok) {
        const data = contentType.includes('json')
          ? await res.json().catch(() => ({}))
          : {}
        throw new Error((data as { error?: string }).error || `${res.status}`)
      }
      if (contentType.includes('json')) {
        return res.json() as Promise<T>
      }
      return res as unknown as T
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function getBlob(path: string, opts: { timeoutMs?: number } = {}): Promise<Blob> {
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
      return res.blob()
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function postBlob(
    path: string,
    body: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ blob: Blob; engine?: string } | { fallback: string; error?: string }> {
    const { url, memberToken } = await resolveRequest(path)
    const ctrl = opts.timeoutMs ? new AbortController() : undefined
    const timer = ctrl && opts.timeoutMs
      ? setTimeout(() => ctrl.abort(), opts.timeoutMs)
      : null
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildHeaders(memberToken),
        },
        body: JSON.stringify(body),
        signal: ctrl?.signal,
      })
      const contentType = res.headers.get('content-type') || ''
      if (res.ok && !contentType.includes('json')) {
        const blob = await res.blob()
        const engine = res.headers.get('X-Voice-Engine') || undefined
        return { blob, engine }
      }
      const data = await res.json().catch(() => ({}))
      return {
        fallback: (data as { fallback?: string }).fallback || 'webspeech',
        error: (data as { error?: string }).error || `HTTP ${res.status}`,
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return { get, send, sendForm, getBlob, postBlob }
}
