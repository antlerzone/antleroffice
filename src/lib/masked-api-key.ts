export type ProviderKeyRecord = {
  provider: string
  label?: string
  profileId?: string
  masked?: string
}

/** Build display string: bullets + last 4 chars (never full plaintext). */
export function maskedPreviewFromLabel(label: string): string {
  const trimmed = String(label || '').trim()
  if (!trimmed) return ''

  const eq = trimmed.indexOf('=')
  const secret = eq >= 0 ? trimmed.slice(eq + 1).trim() : trimmed
  if (!secret) return '••••••••'

  let tail = secret
  if (secret.includes('...')) {
    tail = secret.split('...').pop() || secret
  }
  const last4 = tail.slice(-4)
  if (!last4) return '••••••••'
  return `••••••••${last4}`
}

export function profileIdFromLabel(label: string): string {
  const trimmed = String(label || '').trim()
  const eq = trimmed.indexOf('=')
  if (eq <= 0) return 'default'
  return trimmed.slice(0, eq).trim() || 'default'
}

/** True when the input still shows a masked placeholder (not a new key). */
export function isMaskedApiKeyDisplay(value: string): boolean {
  const v = String(value || '').trim()
  if (!v) return false
  if (/^[*•]{4,}[A-Za-z0-9_-]{1,12}$/.test(v)) return true
  if (/^[\w-]+\.{3}[\w-]+$/.test(v)) return true
  return false
}

export function indexProviderKeys(keys: ProviderKeyRecord[] = []) {
  const byProvider = new Map<string, ProviderKeyRecord[]>()
  for (const row of keys) {
    const provider = String(row.provider || '').trim()
    if (!provider) continue
    const list = byProvider.get(provider) || []
    list.push({
      ...row,
      provider,
      profileId: row.profileId || profileIdFromLabel(row.label || ''),
      masked: row.masked || maskedPreviewFromLabel(row.label || ''),
    })
    byProvider.set(provider, list)
  }
  return byProvider
}

export function primaryMaskedKeyForProvider(keys: ProviderKeyRecord[], provider: string): string {
  const rows = indexProviderKeys(keys).get(provider) || []
  if (!rows.length) return ''
  const preferred = rows.find((r) => (r.profileId || '').endsWith(':default')) || rows[0]
  return preferred?.masked || maskedPreviewFromLabel(preferred?.label || '')
}

export function profileCountForProvider(keys: ProviderKeyRecord[], provider: string): number {
  return (indexProviderKeys(keys).get(provider) || []).length
}
