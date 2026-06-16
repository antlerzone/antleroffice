/** Shared with Chat page — one selected OpenClaw session across Boss Chat and /chat */
export const OPENCLAW_SELECTED_SESSION_KEY = 'openclaw_chat_selected_session_v1'

export function primaryAgentSessionKey(openclawAgentId = 'main') {
  const agent = String(openclawAgentId || 'main').trim() || 'main'
  return `agent:${agent}:main`
}

export function normalizeOpenClawSessionKey(key: string, openclawAgentId = 'main') {
  const raw = String(key || '').trim()
  if (!raw || raw === 'main') return primaryAgentSessionKey(openclawAgentId)
  return raw
}

export function readSelectedOpenClawSessionKey(): string {
  try {
    return localStorage.getItem(OPENCLAW_SELECTED_SESSION_KEY)?.trim() || ''
  } catch {
    return ''
  }
}

export function writeSelectedOpenClawSessionKey(key: string, openclawAgentId = 'main') {
  const normalized = normalizeOpenClawSessionKey(key, openclawAgentId)
  if (!normalized) return
  try {
    localStorage.setItem(OPENCLAW_SELECTED_SESSION_KEY, normalized)
  } catch {
    /* ignore */
  }
}

export function sessionKeysMatch(a: string, b: string, openclawAgentId = 'main') {
  return (
    normalizeOpenClawSessionKey(a, openclawAgentId) === normalizeOpenClawSessionKey(b, openclawAgentId)
  )
}
