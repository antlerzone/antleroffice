const CATALOG_NAMESPACE = 'antler-ecs-catalog'

export function isCatalogUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim(),
  )
}

export function looksLikeUuidSearch(value: string): boolean {
  const q = String(value || '').trim().toLowerCase()
  if (!q) return false
  if (isCatalogUuid(q)) return true
  return q.length >= 8 && /^[0-9a-f-]+$/.test(q)
}
