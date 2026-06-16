export type BrowseSection = 'department' | 'leadership' | 'all'

export type MarketSection = 'department' | 'leadership'

export type CatalogCategory =
  | 'operations'
  | 'customer'
  | 'creative'
  | 'growth'
  | 'digital'
  | 'executive'

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
}

export const BROWSE_SECTIONS: { id: BrowseSection; label: string; hint: string }[] = [
  {
    id: 'department',
    label: 'Departments',
    hint: 'Full department bundles — operations, creative, growth, and more.',
  },
  {
    id: 'leadership',
    label: 'Leadership',
    hint: 'Executive advisors and strategic operators.',
  },
  {
    id: 'all',
    label: 'All',
    hint: 'Every hireable NPC in the catalog.',
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
  customer_service: 'customer',
  graphic_design: 'creative',
  web_design: 'creative',
  marketing: 'growth',
  web_development: 'digital',
  it: 'digital',
}

export function normalizeCategory(value?: string | null): CatalogCategory {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
  if (
    raw === 'operations' ||
    raw === 'customer' ||
    raw === 'creative' ||
    raw === 'growth' ||
    raw === 'digital' ||
    raw === 'executive'
  ) {
    return raw
  }
  return 'operations'
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
  return inferTemplateCategory(template) === 'executive' ? 'leadership' : 'department'
}

export function categoryLabel(category?: string | null) {
  const id = normalizeCategory(category)
  return CATEGORY_TABS.find((tab) => tab.id === id)?.label || 'Operations'
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
  const order: CatalogCategory[] = [
    'operations',
    'customer',
    'creative',
    'growth',
    'digital',
    'executive',
  ]
  const groups = new Map<CatalogCategory, BrowseTemplate[]>()
  for (const t of templates) {
    const cat = inferTemplateCategory(t)
    const list = groups.get(cat) || []
    list.push(t)
    groups.set(cat, list)
  }
  return order
    .filter((cat) => groups.has(cat))
    .map((cat) => ({ category: cat, label: categoryLabel(cat), templates: groups.get(cat)! }))
}
