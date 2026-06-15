import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import os from 'os'

/** Read gateway auth token from ~/.openclaw/openclaw.json */
export function readOpenClawGatewayToken() {
  try {
    const configPath = join(os.homedir(), '.openclaw', 'openclaw.json')
    if (!existsSync(configPath)) return ''
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'))
    const token = cfg?.gateway?.auth?.token
    return typeof token === 'string' ? token.trim() : ''
  } catch {
    return ''
  }
}

/** Resolve gateway auth: prefer real token from openclaw.json when .env is empty or placeholder. */
export function resolveOpenClawGatewayAuth(parsed = {}) {
  const envToken = String(parsed.OPENCLAW_AUTH_TOKEN || '').trim()
  const envPassword = String(parsed.OPENCLAW_AUTH_PASSWORD || '').trim()
  const fileToken = readOpenClawGatewayToken()

  const placeholderTokens = new Set(['1212', 'changeme', 'token', 'test'])
  const useFileToken = fileToken && (!envToken || placeholderTokens.has(envToken.toLowerCase()))

  return {
    OPENCLAW_AUTH_TOKEN: useFileToken ? fileToken : envToken,
    OPENCLAW_AUTH_PASSWORD: envPassword,
    tokenSource: useFileToken ? 'openclaw.json' : envToken ? 'env' : 'none',
  }
}
