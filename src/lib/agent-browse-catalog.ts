export type BrowseSection = 'department' | 'leadership' | 'vip' | 'all'

export type MarketSection = 'department' | 'leadership'

// Category ids are server-driven now, so this is a plain string. The literals
// below are kept only as the built-in fallback list (CATEGORY_TABS).
export type CatalogCategory = string

export type BrowseTemplate = {
  id: string
  name: string
  tagline?: string
  description?: string
  examples?: string[]
  role?: string
  category?: string
  departmentId?: string
  bundleTemplateId?: string | null
  templateId?: string
  marketSection?: MarketSection
  sortOrder?: number
  installable?: boolean
  salaryCreditsPerMonth?: number
  hired?: boolean
  catalogUuid?: string | null
  visibility?: 'public' | 'hidden'
  hidden?: boolean
  requiresHirePassword?: boolean
  pricingModel?: string
  hireTier?: string
  includesLabel?: string
  currency?: string
  ceoPricingNote?: string
  hireCount?: number
  reviewCount?: number
}

export const BROWSE_SECTIONS: { id: BrowseSection; label: string; hint: string }[] = [
  {
    id: 'all',
    label: 'All',
    hint: 'Every hireable NPC in the catalog.',
  },
  {
    id: 'department',
    label: 'Department',
    hint: 'Full department bundles — hire a whole team at once.',
  },
  {
    id: 'vip',
    label: 'VIP Workers',
    hint: 'Included free — admin only.',
  },
]

export const CATEGORY_TABS: { id: CatalogCategory | ''; label: string }[] = [
  { id: '', label: 'All categories' },
  { id: 'operations', label: 'Operations' },
  { id: 'customer', label: 'Customer' },
  { id: 'creative', label: 'Creative' },
  { id: 'growth', label: 'Growth' },
  { id: 'digital', label: 'Digital' },
  { id: 'executive', label: 'Executive' },
]

const ROLE_CATEGORY: Record<string, CatalogCategory> = {
  admin: 'operations',
  accounting: 'operations',
  human_resource: 'operations',
  security: 'operations',
  customer_service: 'customer',
  antlerchat_cs: 'customer',
  antlerhub_admin: 'operations',
  coliving_admin: 'operations',
  graphic_design: 'creative',
  web_design: 'creative',
  marketing: 'growth',
  marketing_editor: 'growth',
  marketing_junior: 'growth',
  product_research: 'growth',
  sales: 'growth',
  business_development: 'growth',
  web_development: 'digital',
  it: 'digital',
  ceo: 'executive',
}

// Server-driven: accept ANY non-empty category id (e.g. "finance", "product"),
// don't force unknown ones into "operations". Empty falls back to "operations".
export function normalizeCategory(value?: string | null): CatalogCategory {
  return String(value || '').trim().toLowerCase() || 'operations'
}

// Category list pushed from the server (via /api/config/agents/categories).
// When set, it drives the tabs, labels and grouping order. Falls back to the
// hardcoded CATEGORY_TABS below when not loaded.
let serverCategories: { id: string; label: string; sortOrder?: number }[] | null = null

export function setCatalogCategories(
  list: { id: string; label: string; sortOrder?: number }[] | null,
) {
  serverCategories =
    list && list.length
      ? [...list].sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999))
      : null
}

export function getCategoryTabs(): { id: CatalogCategory | ''; label: string }[] {
  if (!serverCategories) return CATEGORY_TABS
  return [
    { id: '', label: 'All categories' },
    ...serverCategories.map((c) => ({ id: c.id, label: c.label })),
  ]
}

export function inferTemplateCategory(template: Pick<BrowseTemplate, 'category' | 'role'>): CatalogCategory {
  if (template.category) return normalizeCategory(template.category)
  const role = String(template.role || '')
    .trim()
    .toLowerCase()
  return ROLE_CATEGORY[role] || 'operations'
}

export function templateMarketSection(template: Pick<BrowseTemplate, 'category' | 'role' | 'marketSection'>) {
  if (template.marketSection === 'leadership' || template.marketSection === 'department') {
    return template.marketSection
  }
  const role = String(template.role || '')
    .trim()
    .toLowerCase()
  if (role === 'ceo') return 'leadership'
  return inferTemplateCategory(template) === 'executive' ? 'leadership' : 'department'
}

export function categoryLabel(category?: string | null) {
  const id = normalizeCategory(category)
  if (serverCategories) {
    const hit = serverCategories.find((c) => c.id === id)
    if (hit) return hit.label
  }
  const tab = CATEGORY_TABS.find((t) => t.id === id)
  if (tab) return tab.label
  // Unknown id (e.g. a new server category) → capitalize it.
  return id.charAt(0).toUpperCase() + id.slice(1)
}

function templateVisibility(t: BrowseTemplate) {
  if (t.visibility === 'hidden' || t.hidden) return 'hidden' as const
  return 'public' as const
}

function matchesCatalogUuidSearch(t: BrowseTemplate, query: string) {
  const uuid = String(t.catalogUuid || '').toLowerCase()
  const q = query.trim().toLowerCase()
  if (!uuid || !q) return false
  return uuid === q || uuid.includes(q)
}

export function isVipTemplate(template: Pick<BrowseTemplate, 'pricingModel' | 'hireTier'>) {
  return template.pricingModel === 'vip' || template.hireTier === 'vip'
}

export function filterBrowseTemplates(
  templates: BrowseTemplate[],
  opts: {
    section: BrowseSection
    category: CatalogCategory | ''
    search: string
    status: string
    role: string
    creditMin: string
    creditMax: string
    ratingMin: string
    sort: string
    favoritesOnly: boolean
    favoriteIds: Set<string>
    browseRating: (t: BrowseTemplate) => number | null
    searchHaystack: (t: BrowseTemplate) => string
    isUuidSearch?: (query: string) => boolean
  },
) {
  let out = templates
    .filter((t) => t.installable !== false)
    .map((t) => ({
    ...t,
    category: inferTemplateCategory(t),
    marketSection: templateMarketSection(t),
  }))

  const q = opts.search.trim()
  const qLower = q.toLowerCase()
  const uuidSearch = q && (opts.isUuidSearch ? opts.isUuidSearch(q) : false)

  if (!q) {
    out = out.filter((t) => templateVisibility(t) !== 'hidden')
  } else if (uuidSearch) {
    out = out.filter((t) => matchesCatalogUuidSearch(t, q))
  } else {
    out = out.filter((t) => templateVisibility(t) !== 'hidden')
    out = out.filter((t) => opts.searchHaystack(t).toLowerCase().includes(qLower))
  }

  if (opts.section === 'department') {
    out = out.filter((t) => t.marketSection === 'department')
  } else if (opts.section === 'leadership') {
    out = out.filter((t) => t.marketSection === 'leadership')
  } else if (opts.section === 'vip') {
    out = out.filter((t) => isVipTemplate(t))
  }

  if (opts.category) {
    out = out.filter((t) => t.category === opts.category)
  }

  if (opts.status === 'available') out = out.filter((t) => !t.hired)
  else if (opts.status === 'hired') out = out.filter((t) => t.hired)

  if (opts.role) out = out.filter((t) => t.role === opts.role)

  if (opts.creditMin) {
    const min = Number(opts.creditMin)
    if (Number.isFinite(min)) out = out.filter((t) => (t.salaryCreditsPerMonth ?? 0) >= min)
  }
  if (opts.creditMax) {
    const max = Number(opts.creditMax)
    if (Number.isFinite(max)) out = out.filter((t) => (t.salaryCreditsPerMonth ?? 0) <= max)
  }

  if (opts.favoritesOnly) {
    out = out.filter((t) => opts.favoriteIds.has(t.id))
  }

  if (opts.ratingMin) {
    const minR = Number(opts.ratingMin)
    if (Number.isFinite(minR)) {
      out = out.filter((t) => {
        const r = opts.browseRating(t)
        return r != null && r >= minR
      })
    }
  }

  if (opts.sort === 'rating_desc') {
    out.sort((a, b) => (opts.browseRating(b) ?? -1) - (opts.browseRating(a) ?? -1))
  } else if (opts.sort === 'rating_asc') {
    out.sort((a, b) => (opts.browseRating(a) ?? 999) - (opts.browseRating(b) ?? 999))
  } else {
    out.sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || a.name.localeCompare(b.name))
  }

  return out
}

export function groupTemplatesByCategory(templates: BrowseTemplate[]) {
  const groups = new Map<CatalogCategory, BrowseTemplate[]>()
  for (const t of templates) {
    const cat = inferTemplateCategory(t)
    const list = groups.get(cat) || []
    list.push(t)
    groups.set(cat, list)
  }
  // Order: follow the server category order when available; otherwise the
  // built-in fallback. Any category present in data but missing from the
  // configured order is appended so nothing is ever dropped.
  const order: CatalogCategory[] = serverCategories
    ? serverCategories.map((c) => c.id)
    : ['operations', 'customer', 'creative', 'growth', 'digital', 'executive']
  const seen = new Set(order)
  for (const cat of groups.keys()) {
    if (!seen.has(cat)) {
      order.push(cat)
      seen.add(cat)
    }
  }
  return order
    .filter((cat) => groups.has(cat))
    .map((cat) => ({ category: cat, label: categoryLabel(cat), templates: groups.get(cat)! }))
}
