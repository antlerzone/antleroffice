<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'

const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })
const emit = defineEmits<{ hired: [] }>()
import { NModal, NButton, NInput, NCheckbox, NSpace, useMessage, useDialog } from 'naive-ui'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useBossStore } from '@/stores/boss'
import { useOfficeShareStore } from '@/stores/officeShare'
import {
  loadCharacterImages,
  registerPreview,
  startSkinPreviews,
  stopSkinPreviews,
  unregisterPreviewsIn,
  SKIN_CANVAS_SIZE,
  AGENT_SKIN_CANVAS,
  DETAIL_AGENT_CANVAS,
} from '@/lib/skin-preview'
import {
  BROWSE_SECTIONS,
  CATEGORY_TABS,
  categoryLabel,
  setCatalogCategories,
  getCategoryTabs,
  filterBrowseTemplates,
  groupTemplatesByCategory,
  isVipTemplate,
  type BrowseSection,
  type CatalogCategory,
  type MarketSection,
} from '@/lib/agent-browse-catalog'
import {
  layoutToAgentColStyle,
  layoutToSceneStyle,
  layoutToStatsStyle,
  loadNpcHireLayout,
} from '@/lib/npc-hire-layout'
import { drawModalBorderVignette } from '@/lib/npc-hire-vignette'
import { looksLikeUuidSearch } from '@/lib/catalog-uuid'
import {
  isDevTemplate,
  waitForDevClisAfterHire,
  type DevCliInstallBundle,
} from '@/lib/dev-cli-install'
import ItGuysSetupModal from '@/components/settings/ItGuysSetupModal.vue'
import NpcOnboardingWizard from '@/components/antler/NpcOnboardingWizard.vue'
import { getNpcOnboardingConfig } from '@/lib/npc-onboarding-configs'
import {
  BILLING_INTERVALS,
  creditsPerPeriod,
  listCreditsPerPeriod,
  firstChargeLabel,
  intervalChargeAdjustment,
  intervalTabLabel,
  paygoRateLabel,
  isPaygo,
  type BillingInterval,
} from '@/lib/billing-interval'

interface Skin {
  id: string
  name: string
  palette: number
  hueShift?: number
}
interface Template {
  id: string
  name: string
  tagline?: string
  role?: string
  category?: string
  departmentId?: string
  bundleTemplateId?: string | null
  templateId?: string
  marketSection?: MarketSection
  sortOrder?: number
  installable?: boolean
  salaryCreditsPerMonth?: number
  billingCreditsByInterval?: Partial<Record<BillingInterval, number>>
  currency?: string
  hired?: boolean
  featured?: boolean
  rating?: number | null
  reviewCount?: number
  hireCount?: number
  highlights?: string[]
  defaultSkinId?: string
  sprite?: number
  hueShift?: number
  skillNames?: string[]
  skillIds?: string[]
  mcpNames?: string[]
  includesLabel?: string
  mcpHints?: string[]
  trustedBy?: string
  description?: string
  examples?: string[]
  catalogUuid?: string | null
  visibility?: 'public' | 'hidden'
  hidden?: boolean
  requiresHirePassword?: boolean
  pricingModel?: string
  hireTier?: string
  hireRequirements?: { colivingOAuth?: boolean; antlerchatOAuth?: boolean; antlerhubOAuth?: boolean }
  ceoDepartmentCount?: number
  ceoPricingNote?: string
  devEngine?: string
  devEngineOptions?: string[]
  devScopeDefault?: { canWrite?: boolean; canReview?: boolean }
}

const FAV_KEY = 'antleroffice.agentBrowseFavorites'
const FILTER_KEY = 'antleroffice.agentBrowseFilters'
const AGENT_BROWSE_VIEW_KEY = 'antleroffice.agentBrowseView'
const LIST_PAGE_KEY = 'antleroffice.agentBrowseListPage'
const LIST_PAGE_SIZES = [10, 20, 50, 100, 200] as const

const api = useAntlerApi()
const boss = useBossStore()
const officeShare = useOfficeShareStore()
const message = useMessage()
const dialog = useDialog()
const router = useRouter()

const skins = ref<Skin[]>([])
const templates = ref<Template[]>([])
const gridRef = ref<HTMLElement | null>(null)
const hiring = ref<string | null>(null)
const filterExpanded = ref(false)
const viewMode = ref<'grid' | 'list'>(
  localStorage.getItem(AGENT_BROWSE_VIEW_KEY) === 'list' ? 'list' : 'grid',
)

const search = ref('')
const browseSection = ref<BrowseSection>('department')
const categoryFilter = ref<CatalogCategory | ''>('')
// Category tabs — start with the built-in fallback, replaced by the server list
// once load() fetches /api/config/agents/categories.
const categoryTabs = ref<{ id: CatalogCategory | ''; label: string }[]>([...CATEGORY_TABS])
const status = ref('')
const role = ref('')
const creditMin = ref('')
const creditMax = ref('')
const ratingMin = ref('')
const sort = ref('')
const favoritesOnly = ref(false)
const listPage = ref(1)
const listPageSize = ref<number>(10)

const detailOpen = ref(false)
const npcHireSceneStyle = ref<Record<string, string>>({})
const npcHireAgentColStyle = ref<Record<string, string>>({})
const npcHireStatsStyle = ref<Record<string, string>>({})
const detailTemplate = ref<Template | null>(null)
const detailStageRef = ref<HTMLElement | null>(null)
const detailCanvasRef = ref<HTMLCanvasElement | null>(null)
const detailModalRef = ref<HTMLElement | null>(null)
const vignetteCanvasRef = ref<HTMLCanvasElement | null>(null)
let vignetteRaf = 0
let vignetteResizeObserver: ResizeObserver | null = null

function stopVignetteObserver() {
  vignetteResizeObserver?.disconnect()
  vignetteResizeObserver = null
}

function startVignetteObserver() {
  stopVignetteObserver()
  const modal = detailModalRef.value
  if (!modal || typeof ResizeObserver === 'undefined') return
  vignetteResizeObserver = new ResizeObserver(() => updateHireVignette())
  vignetteResizeObserver.observe(modal)
}
const hireOpen = ref(false)
const itSetupOpen = ref(false)
const itSetupAgentName = ref('')
const itSetupNeedCursorKey = ref(true)
const itSetupNeedCodexKey = ref(true)
const itSetupNeedClaudeKey = ref(true)

// NPC onboarding wizard (shown after hire for non-dev templates)
const onboardingOpen = ref(false)
const onboardingTemplateId = ref('')
const onboardingAgentName = ref('')
const onboardingAgentRole = ref('')

function triggerOnboarding(t: Template, name: string) {
  const config = getNpcOnboardingConfig(t.id)
  if (config) {
    onboardingTemplateId.value = t.id
    onboardingAgentName.value = name || t.name
    onboardingAgentRole.value = t.role || ''
    onboardingOpen.value = true
  } else {
    message.success(`${name || t.name} joined your office!`)
  }
}
const hireDevScopeCanWrite = ref(true)
const hireDevScopeCanReview = ref(true)
const hireDevEngine = ref('cursor')

const DEV_ENGINE_LABELS: Record<string, string> = {
  cursor: 'Cursor',
  codex: 'Codex',
  claude: 'Claude',
}

const hireEngineOptions = computed<string[]>(() => {
  const t = hireTemplate.value
  if (!t) return []
  const opts = Array.isArray(t.devEngineOptions) ? t.devEngineOptions.filter(Boolean) : []
  return opts.length ? opts : []
})
const hireTemplate = ref<Template | null>(null)
const hireName = ref('')
const hirePassword = ref('')
const hireBillingInterval = ref<BillingInterval>('yearly')
const hireError = ref('')

const hireBillingOverrides = computed(() => hireTemplate.value?.billingCreditsByInterval ?? null)

const hireIsPaygo = computed(() => isPaygo(hireBillingInterval.value))

const hireChargeCredits = computed(() => {
  const t = hireTemplate.value
  if (!t) return 0
  return creditsPerPeriod(t.salaryCreditsPerMonth ?? 0, hireBillingInterval.value, hireBillingOverrides.value)
})

const hireListCredits = computed(() => {
  const t = hireTemplate.value
  if (!t) return 0
  return listCreditsPerPeriod(t.salaryCreditsPerMonth ?? 0, hireBillingInterval.value, hireBillingOverrides.value)
})

const hireShowListPrice = computed(() => hireListCredits.value !== hireChargeCredits.value)

const hireFirstChargeLabel = computed(() => firstChargeLabel(hireBillingInterval.value))

const hireChargeAdjustment = computed(() => {
  const t = hireTemplate.value
  if (!t) return null
  return intervalChargeAdjustment(
    hireBillingInterval.value,
    t.salaryCreditsPerMonth ?? 0,
    hireBillingOverrides.value,
  )
})

function loadFilterPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || '{}')
    if (typeof saved.search === 'string') search.value = saved.search
    if (
      saved.browseSection === 'department'
      || saved.browseSection === 'leadership'
      || saved.browseSection === 'vip'
      || saved.browseSection === 'all'
    ) {
      browseSection.value = saved.browseSection
    }
    if (typeof saved.categoryFilter === 'string') categoryFilter.value = saved.categoryFilter as CatalogCategory | ''
    if (typeof saved.status === 'string') status.value = saved.status
    if (typeof saved.role === 'string') role.value = saved.role
    if (saved.creditMin != null) creditMin.value = String(saved.creditMin)
    if (saved.creditMax != null) creditMax.value = String(saved.creditMax)
    if (typeof saved.ratingMin === 'string') ratingMin.value = saved.ratingMin
    if (typeof saved.sort === 'string') sort.value = saved.sort
    if (typeof saved.favoritesOnly === 'boolean') favoritesOnly.value = saved.favoritesOnly
  } catch { /* ignore */ }
}

function saveFilterPrefs() {
  localStorage.setItem(
    FILTER_KEY,
    JSON.stringify({
      search: search.value,
      browseSection: browseSection.value,
      categoryFilter: categoryFilter.value,
      status: status.value,
      role: role.value,
      creditMin: creditMin.value,
      creditMax: creditMax.value,
      ratingMin: ratingMin.value,
      sort: sort.value,
      favoritesOnly: favoritesOnly.value,
    }),
  )
}

function loadListPagePrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(LIST_PAGE_KEY) || '{}')
    const size = Number(saved.pageSize)
    if ((LIST_PAGE_SIZES as readonly number[]).includes(size)) listPageSize.value = size
  } catch { /* ignore */ }
}

function saveListPagePrefs() {
  localStorage.setItem(LIST_PAGE_KEY, JSON.stringify({ pageSize: listPageSize.value }))
}

function loadFavorites(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FAV_KEY) || '[]')
  } catch {
    return []
  }
}

function isFavorite(id: string) {
  return loadFavorites().includes(id)
}

function toggleFavorite(id: string) {
  const favs = new Set(loadFavorites())
  if (favs.has(id)) favs.delete(id)
  else favs.add(id)
  localStorage.setItem(FAV_KEY, JSON.stringify([...favs]))
}

function templatePreviewSkin(t: Template) {
  if (t.defaultSkinId) {
    const skin = skins.value.find((s) => s.id === t.defaultSkinId)
    if (skin) return { palette: skin.palette, hueShift: skin.hueShift || 0, skinName: skin.name }
  }
  const palette = Number.isInteger(t.sprite) ? (t.sprite as number) : 2
  const hueShift = t.hueShift || 0
  const hit = skins.value.find((s) => s.palette === palette && (s.hueShift || 0) === hueShift)
  return { palette, hueShift, skinName: hit?.name || 'Forest' }
}

function browseRating(t: Template) {
  return typeof t.rating === 'number' ? t.rating : null
}

function formatRating(t: Template) {
  const r = browseRating(t)
  return r != null ? String(r) : '—'
}

function templateHasSocial(t: Template) {
  return (t.reviewCount ?? 0) > 0 || (t.hireCount ?? 0) > 0
}

function templateHighlights(t: Template) {
  return t.highlights || []
}

function templateSkillTags(t: Template) {
  if (t.skillNames?.length) return t.skillNames
  return (t.skillIds || []).map((id) => id.replace(/_/g, ' '))
}

function setView(mode: 'grid' | 'list') {
  viewMode.value = mode
  localStorage.setItem(AGENT_BROWSE_VIEW_KEY, mode)
  void mountPreviews()
}

const roles = computed(() =>
  [...new Set(templates.value.map((t) => t.role).filter(Boolean))].sort() as string[],
)

function templateSearchHaystack(t: Template) {
  const { skinName } = templatePreviewSkin(t)
  const skills = (t.skillNames || t.skillIds || []).join(' ')
  return [t.name, t.tagline, t.role, skinName, skills, categoryLabel(t.category)].join(' ')
}

const filterCount = computed(() => {
  let n = 0
  if (browseSection.value !== 'department') n++
  if (categoryFilter.value) n++
  if (status.value) n++
  if (role.value) n++
  if (creditMin.value || creditMax.value) n++
  if (ratingMin.value) n++
  if (sort.value) n++
  if (favoritesOnly.value) n++
  return n
})

const filtered = computed(() =>
  filterBrowseTemplates(templates.value, {
    section: browseSection.value,
    category: categoryFilter.value,
    search: search.value,
    status: status.value,
    role: role.value,
    creditMin: creditMin.value,
    creditMax: creditMax.value,
    ratingMin: ratingMin.value,
    sort: sort.value,
    favoritesOnly: favoritesOnly.value,
    favoriteIds: new Set(loadFavorites()),
    browseRating,
    searchHaystack: templateSearchHaystack,
    isUuidSearch: looksLikeUuidSearch,
  }) as Template[],
)

const listTotal = computed(() => filtered.value.length)
const listTotalPages = computed(() => Math.max(1, Math.ceil(listTotal.value / listPageSize.value)))
const paginatedList = computed(() => {
  const start = (listPage.value - 1) * listPageSize.value
  return filtered.value.slice(start, start + listPageSize.value)
})
const listPageInfo = computed(() => {
  if (!listTotal.value) return { start: 0, end: 0 }
  return {
    start: (listPage.value - 1) * listPageSize.value + 1,
    end: Math.min(listTotal.value, listPage.value * listPageSize.value),
  }
})

function onListPageChange(page: number) {
  const next = Math.min(Math.max(1, page), listTotalPages.value)
  if (next === listPage.value) return
  listPage.value = next
  void mountPreviews()
}

function onListPageSizeChange(size: number) {
  if (!(LIST_PAGE_SIZES as readonly number[]).includes(size)) return
  listPageSize.value = size
  listPage.value = 1
  saveListPagePrefs()
  void mountPreviews()
}

const activeBrowseSection = computed(
  () => BROWSE_SECTIONS.find((section) => section.id === browseSection.value) || BROWSE_SECTIONS[0],
)

const gridGroups = computed(() => {
  if (categoryFilter.value || browseSection.value === 'leadership') {
    return [{ category: '' as const, label: '', templates: filtered.value }]
  }
  return groupTemplatesByCategory(filtered.value)
})

function setBrowseSection(section: BrowseSection) {
  browseSection.value = section
  if (section === 'leadership') categoryFilter.value = ''
  saveFilterPrefs()
  void mountPreviews()
}

function setCategoryFilter(next: CatalogCategory | '') {
  categoryFilter.value = next
  saveFilterPrefs()
  void mountPreviews()
}

function clearFilters() {
  search.value = ''
  browseSection.value = 'department'
  categoryFilter.value = ''
  status.value = ''
  role.value = ''
  creditMin.value = ''
  creditMax.value = ''
  ratingMin.value = ''
  sort.value = ''
  favoritesOnly.value = false
  saveFilterPrefs()
}

async function mountPreviews() {
  await nextTick()
  const root = gridRef.value
  if (!root) return
  unregisterPreviewsIn(root)
  root.querySelectorAll<HTMLCanvasElement>('canvas[data-palette]').forEach((canvas) => {
    registerPreview({
      canvas,
      palette: Number(canvas.dataset.palette),
      hueShift: Number(canvas.dataset.hue || 0),
    })
  })
  startSkinPreviews()
}

async function load() {
  stopSkinPreviews()
  const [sk, cat, catg] = await Promise.all([
    api.get<{ skins: Skin[] }>('/api/config/skins'),
    api.get<{ templates: Template[] }>('/api/config/agents/catalog'),
    api
      .get<{ categories: { id: string; label: string; sortOrder?: number }[] }>(
        '/api/config/agents/categories',
      )
      .catch(() => null),
  ])
  skins.value = sk.skins || []
  templates.value = cat.templates || []
  // Server-driven category tabs (falls back to CATEGORY_TABS if the call failed).
  if (catg?.categories?.length) {
    setCatalogCategories(catg.categories)
    categoryTabs.value = getCategoryTabs()
  }
  const maxPal = Math.max(0, ...skins.value.map((s) => s.palette ?? 0), ...templates.value.map((t) => t.sprite ?? 0))
  await loadCharacterImages(maxPal + 1)
  await mountPreviews()
}

function formatRole(role?: string) {
  if (!role) return 'Office worker'
  return role.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function detailHeroTitle(t: Template) {
  const cleaned = t.name.replace(/^AntlerOffice\s+/i, '').trim()
  return cleaned || formatRole(t.role)
}

function detailHeroSubtitle(t: Template) {
  if (t.tagline) return t.tagline
  return detailShowcaseTagline(t)
}

function detailShowcaseTagline(t: Template) {
  const presets: Record<string, string> = {
    'Create SaaS NPC workers — catalog, bundles & departments': 'Ready to manage your workforce',
  }
  if (t.tagline && presets[t.tagline]) return presets[t.tagline]
  if (t.tagline && t.tagline.length <= 56 && !t.tagline.includes('server/')) return t.tagline
  return `Your plug-and-play ${formatRole(t.role).toLowerCase()} assistant`
}

function detailAgentTitle(t: Template) {
  const cleaned = t.name.replace(/^AntlerOffice\s+/i, '').trim()
  if (cleaned.toLowerCase().endsWith(' agent')) return cleaned
  if (cleaned) return `${cleaned} Agent`
  return `${formatRole(t.role)} Agent`
}

function detailReviewStat(t: Template) {
  const r = browseRating(t)
  const count = t.reviewCount ?? 0
  if (r == null && count === 0) {
    return { value: 'New', suffix: '', foot: 'No reviews yet' }
  }
  return {
    value: r != null ? String(r) : '—',
    suffix: r != null ? '/ 5.0' : '',
    foot: count > 0 ? `Based on ${count} review${count === 1 ? '' : 's'}` : 'No reviews yet',
  }
}

function formatHireCount(t: Template) {
  const n = t.hireCount ?? 0
  if (n <= 0) return '—'
  return `${n >= 1000 ? n.toLocaleString() : String(n)}+`
}

function officeHireCount(t: Template) {
  const n = t.hireCount ?? 0
  return n > 0 ? n : t.hired ? 1 : 0
}

function hireStatusLabel(t: Template) {
  const n = officeHireCount(t)
  if (!n) return 'Available'
  if (n === 1) return 'On your team'
  return `On your team · ×${n}`
}

function hireMenuLabel(t: Template) {
  return t.hired ? 'Hire another' : 'Hire'
}

function defaultHireName(t: Template) {
  const n = officeHireCount(t)
  if (n <= 0) return t.name
  return `${t.name} ${n + 1}`
}

const ROLE_SCOPE_PRESETS: Record<string, { icon: string; label: string; text: string }[]> = {
  human_resource: [
    {
      icon: 'briefcase',
      label: 'Office role',
      text: 'Human Resource — Handles HR tasks and people operations.',
    },
    {
      icon: 'gear',
      label: 'Core skills',
      text: 'Create SaaS Worker — Builds SaaS NPC workers with best practices.',
    },
    {
      icon: 'wrench',
      label: 'Integrated tools',
      text: 'AntlerOffice Tools — Prebuilt tools for server, data and deployment.',
    },
  ],
}

const WHAT_YOU_GET_PRESETS: Record<string, string[]> = {
  human_resource: [
    'Full SaaS NPC worker template',
    'Server / Data + Server / Tools',
    'Git push server to deploy',
    '1 Skill · 1 MCP included',
  ],
}

function detailGlassTitle(t: Template) {
  return t.name || `AntlerOffice ${detailHeroTitle(t)}`
}

function templateIsVip(t: Template) {
  return isVipTemplate(t)
}

function templatePriceLabel(t: Template) {
  if (templateIsVip(t)) return { main: 'Included', sub: 'VIP · Free', vip: true as const }
  return { main: String(t.salaryCreditsPerMonth ?? 0), sub: `${t.currency || 'credits'} / month`, vip: false as const }
}

function detailSalaryDisplay(t: Template) {
  if (templateIsVip(t)) return { amount: 0, unit: 'included', period: 'vip' as const }
  const amount = t.salaryCreditsPerMonth ?? 0
  const unit = (t.currency || 'credits').toLowerCase()
  return { amount, unit, period: 'month' as const }
}

function detailWhatYouGet(t: Template) {
  const preset = WHAT_YOU_GET_PRESETS[t.role || ''] || WHAT_YOU_GET_PRESETS[t.id || '']
  if (preset) return preset

  const items = [...templateHighlights(t)]
  const skills = templateSkillTags(t)
  const mcps = t.mcpNames?.length ? t.mcpNames : (t.mcpHints || [])
  if (skills.length || mcps.length) {
    const parts: string[] = []
    if (skills.length) parts.push(`${skills.length} Skill${skills.length === 1 ? '' : 's'}`)
    if (mcps.length) parts.push(`${mcps.length} MCP${mcps.length === 1 ? '' : 's'}`)
    if (parts.length) items.push(`${parts.join(' + ')} included`)
  }
  if (items.length) return items
  return [
    'Full SaaS NPC worker template',
    'Ready-to-use workflows',
    'One-click deployment',
    'No coding required',
  ]
}

function detailTipText(t: Template) {
  const n = officeHireCount(t)
  if (n === 1) return 'This agent is already on your team and working. Hire another copy if you need more capacity.'
  if (n > 1) return `You have ${n} of this agent on your team. Hire another copy if you need more capacity.`
  return 'Perfect for non-tech founders. Plug & play. No coding needed.'
}

function detailDescription(t: Template) {
  const text = String(t.description || '').trim()
  if (text) return text
  if (t.tagline) return t.tagline
  return `Your plug-and-play ${formatRole(t.role).toLowerCase()} assistant for everyday business tasks.`
}

function detailExamples(t: Template) {
  const items = (t.examples || []).map((x) => String(x || '').trim()).filter(Boolean)
  if (items.length) return items
  return []
}

function isHiddenTemplate(t: Template) {
  return t.visibility === 'hidden' || !!t.hidden || !!t.requiresHirePassword
}

function detailJobScopeCards(t: Template) {
  const preset = ROLE_SCOPE_PRESETS[t.role || ''] || ROLE_SCOPE_PRESETS[t.id || '']
  if (preset) {
    return preset.map((card, i) => ({ key: `preset-${i}`, ...card }))
  }
  const skills = templateSkillTags(t)
  const mcps = t.mcpNames?.length ? t.mcpNames : (t.mcpHints || [])
  const role = formatRole(t.role)
  return [
    {
      key: 'role',
      icon: 'briefcase',
      label: 'Office role',
      text: `${role} — ${t.tagline || `Handles ${role.toLowerCase()} tasks and people operations.`}`,
    },
    {
      key: 'skills',
      icon: 'gear',
      label: 'Core skills',
      text: skills.length
        ? `${skills[0]} — ${skills.slice(1).join(' · ') || 'Built-in specialist capabilities after hire.'}`
        : `${role} — Built-in specialist capabilities after hire.`,
    },
    {
      key: 'tools',
      icon: 'wrench',
      label: 'Integrated tools',
      text: mcps.length
        ? `${mcps[0]} — ${mcps.slice(1).join(' · ') || 'Prebuilt tools for your business workflows.'}`
        : 'AntlerOffice Tools — Prebuilt tools for your business workflows.',
    },
  ]
}

function closeDetail() {
  detailOpen.value = false
}

function updateHireVignette() {
  cancelAnimationFrame(vignetteRaf)
  vignetteRaf = requestAnimationFrame(() => {
    const canvas = vignetteCanvasRef.value
    const modal = detailModalRef.value
    if (!canvas || !modal || !detailOpen.value) return
    drawModalBorderVignette(canvas, modal.getBoundingClientRect())
  })
}

function onVignetteResize() {
  if (detailOpen.value) updateHireVignette()
}

function onDetailKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape' && detailOpen.value) closeDetail()
}

async function mountDetailPreview() {
  await nextTick()
  if (detailStageRef.value) unregisterPreviewsIn(detailStageRef.value)
  const t = detailTemplate.value
  if (!t) return
  const { palette, hueShift } = templatePreviewSkin(t)
  const canvas = detailCanvasRef.value
  if (canvas) registerPreview({ canvas, palette, hueShift })
  startSkinPreviews()
}

function openDetail(t: Template) {
  detailTemplate.value = t
  detailOpen.value = true
  void nextTick(() => {
    void mountDetailPreview()
    updateHireVignette()
  })
}

function openHire(t: Template) {
  if (officeShare.isMemberClient) {
    message.warning('Hiring is only available on the host office.')
    return
  }
  hireTemplate.value = t
  hireName.value = defaultHireName(t)
  hirePassword.value = ''
  hireBillingInterval.value = t.pricingModel === 'per_department' ? 'daily' : 'yearly'
  hireError.value = ''
  if (isDevTemplate(t)) {
    hireDevScopeCanWrite.value = t.devScopeDefault?.canWrite !== false
    hireDevScopeCanReview.value = t.devScopeDefault?.canReview !== false
    const opts = Array.isArray(t.devEngineOptions) ? t.devEngineOptions.filter(Boolean) : []
    hireDevEngine.value = t.devEngine || opts[0] || 'cursor'
  }
  hireOpen.value = true
  detailOpen.value = false
}

const PORTAL_OAUTH_PARTNERS: Record<
  string,
  { partner: string; label: string; docsUrl: string }
> = {
  vip_coliving_admin: {
    partner: 'coliving',
    label: 'Coliving JB',
    docsUrl: 'https://portal.colivingjb.com/docs?tab=mcp',
  },
  vip_antlerchat_cs: {
    partner: 'antlerchat',
    label: 'AntlerChat',
    docsUrl: 'https://chat.antlerzone.com/docs?tab=mcp',
  },
  vip_antlerhub_admin: {
    partner: 'antlerhub',
    label: 'AntlerHub',
    docsUrl: 'https://system.antlerzone.com/docs?tab=mcp',
  },
}

function templatePortalOAuthMeta(t: Template) {
  if (PORTAL_OAUTH_PARTNERS[t.id]) return PORTAL_OAUTH_PARTNERS[t.id]
  const req = t.hireRequirements || {}
  if (req.colivingOAuth) return PORTAL_OAUTH_PARTNERS.vip_coliving_admin
  if (req.antlerchatOAuth) return PORTAL_OAUTH_PARTNERS.vip_antlerchat_cs
  if (req.antlerhubOAuth) return PORTAL_OAUTH_PARTNERS.vip_antlerhub_admin
  return null
}

function templateRequiresPortalOAuth(t: Template) {
  return templatePortalOAuthMeta(t) != null
}

let portalOAuthPopup: Window | null = null
let portalOAuthWaiter: ((err: string | null) => void) | null = null

function onPortalOAuthMessage(ev: MessageEvent) {
  const data = ev.data
  if (!data || data.type !== 'antleroffice-portal-oauth') return
  if (portalOAuthPopup && !portalOAuthPopup.closed) portalOAuthPopup.close()
  portalOAuthPopup = null
  if (portalOAuthWaiter) {
    portalOAuthWaiter(data.ok === true ? null : (data.error || 'Portal sign-in failed'))
    portalOAuthWaiter = null
  }
}

async function ensurePortalOAuthForHire(t: Template): Promise<string | null> {
  const meta = templatePortalOAuthMeta(t)
  if (!meta) return null
  try {
    const status = await api.send<{ ok?: boolean; connected?: boolean }>(
      'GET',
      `/api/config/portal-oauth/${meta.partner}/status`,
    )
    if (status.connected) return null
  } catch {
    /* proceed to OAuth popup */
  }

  const start = await api.send<{ ok?: boolean; authorizeUrl?: string }>(
    'GET',
    `/api/config/portal-oauth/${meta.partner}/start?provider=google`,
  )
  if (!start.authorizeUrl) return `Could not start ${meta.label} sign-in`

  return new Promise((resolve) => {
    portalOAuthWaiter = resolve
    if (portalOAuthPopup && !portalOAuthPopup.closed) portalOAuthPopup.close()
    portalOAuthPopup = window.open(
      start.authorizeUrl,
      `antleroffice-portal-oauth-${meta.partner}`,
      'width=520,height=720,noopener',
    )
    if (!portalOAuthPopup) {
      portalOAuthWaiter = null
      resolve('Allow pop-ups to sign in to the partner portal')
      return
    }
    window.setTimeout(() => {
      if (portalOAuthWaiter && portalOAuthPopup?.closed) {
        portalOAuthWaiter(`${meta.label} sign-in was cancelled`)
        portalOAuthWaiter = null
        portalOAuthPopup = null
      }
    }, 120000)
  })
}

async function maybeShowItGuysSetup(agentName: string, devEngine?: string) {
  try {
    const res = await fetch('/api/dev/tools/status')
    const data = await res.json()
    if (!res.ok || !data.ok) return
    const engine = devEngine || 'cursor'
    const needCursorKey = engine === 'cursor' && !data.cursor?.apiKeySet
    const needCodexKey = engine === 'codex' && !data.codex?.authReady
    const needClaudeKey = engine === 'claude' && !data.claude?.apiKeySet
    if (!needCursorKey && !needCodexKey && !needClaudeKey) return
    itSetupAgentName.value = agentName
    itSetupNeedCursorKey.value = needCursorKey
    itSetupNeedCodexKey.value = needCodexKey
    itSetupNeedClaudeKey.value = needClaudeKey
    itSetupOpen.value = true
  } catch {
    /* non-fatal */
  }
}

async function confirmHire() {
  const t = hireTemplate.value
  if (!t) return
  hiring.value = t.id
  hireError.value = ''
  try {
    if (templateRequiresPortalOAuth(t)) {
      const oauthErr = await ensurePortalOAuthForHire(t)
      if (oauthErr) {
        hireError.value = oauthErr
        return
      }
    }
    const hireBody: Record<string, unknown> = {
      templateId: t.id,
      name: hireName.value.trim() || t.name,
      hirePassword: hirePassword.value.trim() || undefined,
      billingInterval: hireBillingInterval.value,
    }
    if (isDevTemplate(t)) {
      hireBody.devScope = {
        canWrite: hireDevScopeCanWrite.value,
        canReview: hireDevScopeCanReview.value,
      }
      if (hireEngineOptions.value.length) {
        hireBody.devEngine = hireDevEngine.value
      }
    }
    const r = await api.send<{
      ok: boolean
      creditBalance?: number
      error?: string
      postInstall?: { mcps?: { mcpId: string; name: string; hint?: string }[] } | null
      codexInstall?: DevCliInstallBundle['codex']
      cursorInstall?: DevCliInstallBundle['cursor']
      claudeInstall?: DevCliInstallBundle['claude']
      devCliInstall?: DevCliInstallBundle
      devEngine?: string
    }>(
      'POST',
      '/api/config/agents/hire',
      hireBody,
    )
    if (boss.session && r.creditBalance !== undefined) {
      boss.session.creditBalance = r.creditBalance
    }
    hireOpen.value = false
    await load()
    emit('hired')

    const mcps = r.postInstall?.mcps || []
    const showMcpDialog = () => {
      if (!mcps.length) return
      dialog.info({
        title: `${t.name} hired — add MCP accounts`,
        content:
          `${t.name} is in your office. Connect MCP accounts before this agent can use bundled tools:\n\n` +
          mcps.map((m) => `• ${m.hint || m.name}`).join('\n'),
        positiveText: 'Go to MCP servers',
        onPositiveClick: () => {
          void router.push({ name: 'AntlerSkills', query: { tab: 'mcps' } })
        },
      })
    }

    if (isDevTemplate(t) && t.id !== 'cto') {
      const bundle = r.devCliInstall || { cursor: r.cursorInstall, codex: r.codexInstall, claude: r.claudeInstall }
      const engine = r.devEngine || t.devEngine || 'cursor'
      const needsInstall =
        (bundle?.cursor?.ok && !bundle.cursor.skipped && !bundle.cursor.alreadyInstalled) ||
        (bundle?.codex?.ok && !bundle.codex.skipped && !bundle.codex.alreadyInstalled) ||
        (bundle?.claude?.ok && !bundle.claude.skipped && !bundle.claude.alreadyInstalled)
      let loading: ReturnType<typeof message.loading> | null = null
      if (needsInstall) {
        loading = message.loading(`正在安装 ${engine} CLI…`, { duration: 0 })
      }
      const { cursor, codex, claude, lines } = await waitForDevClisAfterHire(bundle, (label, logLines) => {
        const last = logLines[logLines.length - 1]
        if (loading) {
          loading.content = last ? `正在安装 ${label}…\n${last}` : `正在安装 ${label}…`
        }
      })
      loading?.destroy()
      const installed =
        (engine === 'cursor' && cursor) ||
        (engine === 'codex' && codex) ||
        (engine === 'claude' && claude)
      if (installed) {
        message.success(`${t.name} 已加入办公室 · ${engine} CLI 已就绪`)
      } else if (needsInstall) {
        message.warning(
          `${t.name} 已加入办公室。${engine} CLI 可能未安装完成 — 请到 Settings → Dev tools 重试。` +
            (lines.length ? `\n${lines.slice(-2).join('\n')}` : ''),
          { duration: 8000 },
        )
      } else {
        message.success(`${t.name} 已加入办公室！请到 Settings → Dev tools 安装开发 CLI。`)
      }
      await maybeShowItGuysSetup(t.name, engine)
      showMcpDialog()
    } else if (t.id === 'cto') {
      // CTO writes no code (no engine key). Onboarding asks about server (SSH) access.
      if (mcps.length) showMcpDialog()
      triggerOnboarding(t, hireName.value)
    } else if (mcps.length) {
      showMcpDialog()
      triggerOnboarding(t, hireName.value)
    } else {
      triggerOnboarding(t, hireName.value)
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : 'Hire failed'
    hireError.value =
      raw === '500' || raw === 'HTTP 500'
        ? 'Server error (500). Restart AntlerOffice backend, or try again in a moment.'
        : /^HTTP \d+/.test(raw) && !raw.includes(' ')
          ? `Server error (${raw.replace('HTTP ', '')}). Check backend logs.`
          : raw
  } finally {
    hiring.value = null
  }
}

function onFavClick(t: Template, ev: Event) {
  ev.stopPropagation()
  toggleFavorite(t.id)
  if (favoritesOnly.value) void load()
}

function onListHireClick(t: Template, ev: Event) {
  ev.stopPropagation()
  openHire(t)
}

watch(detailOpen, (open) => {
  if (open) {
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onDetailKeydown)
    window.addEventListener('resize', onVignetteResize)
    void nextTick(() => {
      updateHireVignette()
      startVignetteObserver()
    })
  } else {
    document.body.style.overflow = ''
    window.removeEventListener('keydown', onDetailKeydown)
    window.removeEventListener('resize', onVignetteResize)
    stopVignetteObserver()
    cancelAnimationFrame(vignetteRaf)
    if (detailStageRef.value) unregisterPreviewsIn(detailStageRef.value)
  }
})

watch([search, browseSection, categoryFilter, status, role, creditMin, creditMax, ratingMin, sort, favoritesOnly], () => {
  listPage.value = 1
  saveFilterPrefs()
  void mountPreviews()
})
watch(listTotalPages, (pages) => {
  if (listPage.value > pages) listPage.value = pages
})
watch(viewMode, () => void mountPreviews())

onMounted(() => {
  window.addEventListener('message', onPortalOAuthMessage)
  loadFilterPrefs()
  loadListPagePrefs()
  load().catch(() => message.error('Could not load catalog'))
  void loadNpcHireLayout().then((layout) => {
    npcHireSceneStyle.value = layoutToSceneStyle(layout)
    npcHireAgentColStyle.value = layoutToAgentColStyle(layout)
    npcHireStatsStyle.value = layoutToStatsStyle(layout)
  })
})
onUnmounted(() => {
  window.removeEventListener('message', onPortalOAuthMessage)
  if (portalOAuthPopup && !portalOAuthPopup.closed) portalOAuthPopup.close()
  stopSkinPreviews()
  document.body.style.overflow = ''
  window.removeEventListener('keydown', onDetailKeydown)
})
</script>

<template>
  <div :class="props.embedded ? 'agent-browse-embedded' : 'antler-v1-root'">
    <template v-if="!props.embedded">
      <h2 class="view-title">Hire an agent</h2>
      <p class="hint">Browse department bundles and leadership talent from the ECS catalog.</p>
    </template>

    <div class="tabs agent-browse-section-tabs" role="tablist">
      <button
        v-for="section in BROWSE_SECTIONS"
        :key="section.id"
        type="button"
        class="tab"
        :class="{ active: browseSection === section.id }"
        @click="setBrowseSection(section.id)"
      >
        {{ section.label }}
      </button>
    </div>
    <p class="hint agent-browse-section-hint">{{ activeBrowseSection?.hint }}</p>

    <div
      v-if="browseSection !== 'leadership'"
      class="seg agent-browse-category-seg"
      role="tablist"
      aria-label="Department category"
    >
      <button
        v-for="cat in categoryTabs"
        :key="cat.id || 'all'"
        type="button"
        class="seg-btn"
        :class="{ active: categoryFilter === cat.id }"
        @click="setCategoryFilter(cat.id)"
      >
        {{ cat.label }}
      </button>
    </div>

    <div class="channels-list-bar agent-browse-list-bar">
      <input
        v-model="search"
        type="search"
        class="channels-search"
        placeholder="Search NPCs, skills… or paste UUID for hidden agents"
        autocomplete="off"
      />
      <button
        type="button"
        class="btn ghost channels-filter-btn"
        :class="{ active: filterExpanded, 'has-filters': filterCount > 0 }"
        @click="filterExpanded = !filterExpanded"
      >
        {{ filterCount ? `Filter (${filterCount})` : 'Filter' }}
      </button>
      <div class="seg agent-browse-view-seg">
        <button
          type="button"
          class="seg-btn"
          :class="{ active: viewMode === 'list' }"
          title="List view"
          @click="setView('list')"
        >
          ≣ List
        </button>
        <button
          type="button"
          class="seg-btn"
          :class="{ active: viewMode === 'grid' }"
          title="Grid view"
          @click="setView('grid')"
        >
          ▦ Grid
        </button>
      </div>
    </div>

    <div v-show="filterExpanded" class="channels-filter-panel is-open">
      <div class="channels-filter-fields">
        <div class="channels-filter-item">
          <label class="channels-filter-label">Category</label>
          <select v-model="categoryFilter" class="channels-filter">
            <option v-for="cat in categoryTabs" :key="cat.id || 'all'" :value="cat.id">
              {{ cat.label }}
            </option>
          </select>
        </div>
        <div class="channels-filter-item">
          <label class="channels-filter-label">Status</label>
          <select v-model="status" class="channels-filter">
            <option value="">All</option>
            <option value="available">Available</option>
            <option value="hired">Hired</option>
          </select>
        </div>
        <div class="channels-filter-item">
          <label class="channels-filter-label">Role</label>
          <select v-model="role" class="channels-filter">
            <option value="">All roles</option>
            <option v-for="r in roles" :key="r" :value="r">{{ r.replace(/_/g, ' ') }}</option>
          </select>
        </div>
        <div class="channels-filter-item">
          <label class="channels-filter-label">Credits / mo</label>
          <div class="agent-browse-credit-range">
            <input v-model="creditMin" type="number" class="channels-filter agent-browse-credit-input" min="0" placeholder="Min" />
            <span class="agent-browse-credit-sep">–</span>
            <input v-model="creditMax" type="number" class="channels-filter agent-browse-credit-input" min="0" placeholder="Max" />
          </div>
        </div>
        <div class="channels-filter-item">
          <label class="channels-filter-label">Min rating</label>
          <select v-model="ratingMin" class="channels-filter">
            <option value="">Any</option>
            <option value="4">4+</option>
            <option value="4.5">4.5+</option>
            <option value="4.8">4.8+</option>
          </select>
        </div>
        <div class="channels-filter-item">
          <label class="channels-filter-label">Sort</label>
          <select v-model="sort" class="channels-filter">
            <option value="">Default</option>
            <option value="rating_desc">Rating ↓</option>
            <option value="rating_asc">Rating ↑</option>
          </select>
        </div>
        <div class="channels-filter-item agent-browse-filter-fav">
          <label class="agent-browse-check-label">
            <input v-model="favoritesOnly" type="checkbox" />
            Favorites only
          </label>
        </div>
      </div>
      <button type="button" class="btn ghost sm" @click="clearFilters">Clear filters</button>
    </div>

    <div
      ref="gridRef"
      class="npc-market-grid"
      :class="{ 'agent-browse-list-view': viewMode === 'list' }"
    >
      <template v-if="viewMode === 'list' && filtered.length">
        <div class="agents-table-wrap">
          <table class="agents-table agents-table--browse">
            <thead>
              <tr>
                <th class="agent-td-fav" />
                <th class="agent-th-skin">Skin</th>
                <th>Name</th>
                <th>Department</th>
                <th>Salary</th>
                <th>Rating</th>
                <th>Skills</th>
                <th>Status</th>
                <th class="agent-th-actions">Hire</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="t in paginatedList"
                :key="t.id"
                class="agent-browse-row"
                :class="{ 'agent-browse-row--on-team': t.hired }"
                tabindex="0"
                role="button"
                :aria-label="`View ${t.name} details`"
                @click="openDetail(t)"
                @keydown.enter="openDetail(t)"
                @keydown.space.prevent="openDetail(t)"
              >
                <td class="agent-td-fav">
                  <button
                    type="button"
                    class="npc-market-fav npc-market-fav-sm"
                    :class="{ active: isFavorite(t.id) }"
                    @click="onFavClick(t, $event)"
                  >
                    ♡
                  </button>
                </td>
                <td class="agent-td-skin">
                  <div class="agent-td-skin-inner">
                    <div class="agent-skin-stage">
                      <canvas
                        class="agent-skin-canvas"
                        :width="AGENT_SKIN_CANVAS"
                        :height="AGENT_SKIN_CANVAS"
                        :data-palette="templatePreviewSkin(t).palette"
                        :data-hue="templatePreviewSkin(t).hueShift"
                        :aria-label="templatePreviewSkin(t).skinName"
                      />
                    </div>
                  </div>
                </td>
                <td class="agent-td-name">
                  <div class="agent-td-name-inner">
                    <strong>{{ t.name }}</strong>
                    <span v-if="t.hired" class="tag on agent-on-team-pill">Working</span>
                  </div>
                  <div class="hint browse-list-sub">
                    {{ templatePreviewSkin(t).skinName }} · {{ t.tagline }}
                  </div>
                </td>
                <td>
                  <span class="tag">{{ categoryLabel(t.category) }}</span>
                </td>
                <td>
                  <template v-if="templateIsVip(t)">
                    <strong class="npc-vip-price">Included</strong>
                    <span class="hint browse-list-sub">VIP · Free</span>
                  </template>
                  <template v-else>
                    <strong>{{ t.salaryCreditsPerMonth ?? 0 }}</strong>
                    {{ t.currency || 'credits' }}/mo
                  </template>
                </td>
                <td><span class="npc-market-star">★</span> {{ formatRating(t) }}</td>
                <td>
                  <div class="agent-td-tags">
                    <span v-for="tag in templateSkillTags(t)" :key="tag" class="tag">{{ tag }}</span>
                  </div>
                </td>
                <td>
                  <span v-if="t.hired" class="tag on agent-on-team-status">{{ hireStatusLabel(t) }}</span>
                  <span v-else class="tag">Available</span>
                </td>
                <td class="agent-td-actions">
                  <div class="agent-td-actions-inner">
                    <button
                      type="button"
                      class="btn sm agent-browse-hire-btn"
                      :class="{ secondary: t.hired }"
                      :disabled="hiring === t.id"
                      @click="onListHireClick(t, $event)"
                    >
                      Hire
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="listTotal" class="agent-browse-list-footer channels-pagination">
          <span class="channels-page-info">
            Showing {{ listPageInfo.start }}–{{ listPageInfo.end }} of {{ listTotal }}
          </span>
          <div class="channels-page-btns">
            <button
              type="button"
              class="btn ghost sm"
              :disabled="listPage <= 1"
              @click="onListPageChange(listPage - 1)"
            >
              Prev
            </button>
            <button
              v-for="p in Math.min(listTotalPages, 5)"
              :key="p"
              type="button"
              class="btn ghost sm"
              :class="{ active: p === listPage }"
              :disabled="p === listPage"
              @click="onListPageChange(p)"
            >
              {{ p }}
            </button>
            <button
              type="button"
              class="btn ghost sm"
              :disabled="listPage >= listTotalPages"
              @click="onListPageChange(listPage + 1)"
            >
              Next
            </button>
          </div>
          <label class="channels-page-size">
            Show
            <select
              :value="listPageSize"
              @change="onListPageSizeChange(Number(($event.target as HTMLSelectElement).value))"
            >
              <option v-for="n in LIST_PAGE_SIZES" :key="n" :value="n">{{ n }}</option>
            </select>
            per page
          </label>
        </div>
      </template>

      <template v-else-if="viewMode === 'grid' && filtered.length">
        <template v-for="group in gridGroups" :key="group.category || 'all'">
          <h3 v-if="gridGroups.length > 1" class="agent-browse-group-title">{{ group.label }}</h3>
          <article
            v-for="t in group.templates"
            :key="t.id"
            class="npc-market-card"
            :class="{ 'npc-market-card--on-team': t.hired }"
          >
          <div class="npc-market-preview">
            <span v-if="t.hired" class="npc-market-on-team-badge">
              <span class="npc-market-on-team-dot" aria-hidden="true" />
              {{ officeHireCount(t) > 1 ? `Working · ×${officeHireCount(t)}` : 'On your team' }}
            </span>
            <span class="npc-market-skin-pill">
              <span class="npc-market-skin-dot" aria-hidden="true" />
              {{ templatePreviewSkin(t).skinName }}
            </span>
            <span class="npc-market-dept-pill">{{ categoryLabel(t.category) }}</span>
            <button
              type="button"
              class="npc-market-fav"
              :class="{ active: isFavorite(t.id) }"
              @click="onFavClick(t, $event)"
            >
              ♡
            </button>
            <div class="npc-market-stage">
              <canvas
                :width="SKIN_CANVAS_SIZE"
                :height="SKIN_CANVAS_SIZE"
                :data-palette="templatePreviewSkin(t).palette"
                :data-hue="templatePreviewSkin(t).hueShift"
                role="img"
                :aria-label="`${t.name} preview`"
              />
            </div>
          </div>
          <div class="npc-market-body">
            <h3 class="npc-market-name">
              {{ t.name }}
              <span v-if="templateIsVip(t)" class="tag npc-vip-badge">VIP</span>
            </h3>
            <div class="npc-market-tagline">
              <span class="npc-market-tagline-icon">◆</span>
              {{ t.tagline }}
            </div>
            <p v-if="t.includesLabel" class="includes-label">Includes: {{ t.includesLabel }}</p>
            <div class="npc-market-info">
              <div class="npc-market-price">
                <div class="npc-market-price-icon">◎</div>
                <div class="npc-market-price-text">
                  <template v-if="templateIsVip(t)">
                    <strong class="npc-vip-price">Included</strong>
                    <span>VIP Worker · no salary</span>
                  </template>
                  <template v-else>
                    <strong>{{ t.salaryCreditsPerMonth ?? 0 }}</strong>
                    <span>{{ t.currency || 'credits' }} / month</span>
                  </template>
                  <span v-if="t.pricingModel === 'per_department'" class="npc-market-price-sub">
                    {{ t.ceoPricingNote || '$1/day per department' }}
                  </span>
                </div>
              </div>
              <ul class="npc-market-features">
                <li v-for="(h, i) in templateHighlights(t)" :key="i">
                  <span class="npc-market-check">✓</span>{{ h }}
                </li>
              </ul>
            </div>
            <div class="npc-market-actions">
              <span v-if="t.hired" class="tag on npc-market-hired">{{ hireStatusLabel(t) }}</span>
              <button
                type="button"
                class="btn npc-market-hire"
                :class="{ secondary: t.hired }"
                :disabled="hiring === t.id"
                @click="openHire(t)"
              >
                {{ t.hired ? '⊕ Hire another' : '▣ Hire' }}
              </button>
              <button type="button" class="btn ghost npc-market-details" @click="openDetail(t)">ⓘ Details</button>
            </div>
            <div v-if="templateHasSocial(t)" class="npc-market-footer">
              <span v-if="(t.hireCount ?? 0) > 0" class="npc-market-trust">
                <strong>{{ t.hireCount }}</strong> hired in this office
              </span>
              <span v-if="(t.reviewCount ?? 0) > 0" class="npc-market-rating">
                <span class="npc-market-star">★</span>
                {{ formatRating(t) }}
                <span class="npc-market-reviews">({{ t.reviewCount }} review{{ t.reviewCount === 1 ? '' : 's' }})</span>
              </span>
            </div>
          </div>
        </article>
        </template>
      </template>

      <p v-else-if="templates.length && !filtered.length" class="hint">
        No NPC templates match your filters.
        <button type="button" class="btn ghost sm" @click="clearFilters">Clear filters</button>
      </p>
      <p v-else class="hint">No NPC templates available yet.</p>
    </div>

    <Teleport to="body">
      <Transition name="agent-resume-fade">
        <section
          v-if="detailOpen && detailTemplate"
          class="npc-hire-page"
          role="dialog"
          aria-modal="true"
          :aria-label="`${detailAgentTitle(detailTemplate)} hire`"
          @click.self="closeDetail"
        >
          <button type="button" class="npc-hire-backdrop" aria-label="Close" @click="closeDetail">
            <canvas ref="vignetteCanvasRef" class="npc-hire-vignette-canvas" aria-hidden="true" />
          </button>
          <div ref="detailModalRef" class="npc-hire-modal">
            <div class="npc-hire-scene npc-hire-scene--modal" :style="npcHireSceneStyle" aria-hidden="true">
              <div class="npc-hire-bg npc-hire-bg--scene" />
              <div class="npc-hire-vignette npc-hire-vignette--modal" />
            </div>
            <div class="npc-hire-content">
              <div class="npc-hire-col npc-hire-col--left" :style="npcHireAgentColStyle">
                <div class="npc-hire-left">
                  <header class="npc-hire-copy">
                    <span class="npc-hire-brand">AntlerOffice</span>
                    <h2 class="npc-hire-title">{{ detailHeroTitle(detailTemplate) }}</h2>
                    <p class="npc-hire-subtitle">{{ detailHeroSubtitle(detailTemplate) }}</p>
                  </header>

                  <div class="npc-hire-showcase">
                    <div ref="detailStageRef" class="npc-hire-character">
                      <canvas
                        ref="detailCanvasRef"
                        :width="DETAIL_AGENT_CANVAS"
                        :height="DETAIL_AGENT_CANVAS"
                        role="img"
                        :aria-label="`${detailAgentTitle(detailTemplate)} character`"
                      />
                    </div>
                  </div>
                </div>

                <div class="npc-hire-stats" :style="npcHireStatsStyle">
                  <div class="npc-hire-stat">
                    <h4 class="npc-hire-stat-title">Reviews</h4>
                    <div class="npc-hire-stat-body">
                      <span class="npc-hire-stat-icon star" aria-hidden="true" />
                      <p class="npc-hire-stat-value">
                        <strong>{{ detailReviewStat(detailTemplate).value }}</strong>
                        <em v-if="detailReviewStat(detailTemplate).suffix">{{
                          detailReviewStat(detailTemplate).suffix
                        }}</em>
                      </p>
                    </div>
                    <p class="npc-hire-stat-foot">{{ detailReviewStat(detailTemplate).foot }}</p>
                  </div>
                  <div class="npc-hire-stat">
                    <h4 class="npc-hire-stat-title">Downloads</h4>
                    <div class="npc-hire-stat-body">
                      <span class="npc-hire-stat-icon download" aria-hidden="true" />
                      <p class="npc-hire-stat-value">
                        <strong>{{ formatHireCount(detailTemplate) }}</strong>
                      </p>
                    </div>
                    <p class="npc-hire-stat-foot">Total downloads</p>
                  </div>
                </div>
              </div>

              <div class="npc-hire-col npc-hire-col--right">
                <div class="npc-hire-right">
                  <div class="npc-hire-glass">
                    <header class="npc-hire-glass-head">
                      <h3 class="npc-hire-glass-title">{{ detailGlassTitle(detailTemplate) }}</h3>
                      <div class="npc-hire-salary">
                        <span class="npc-hire-coin" aria-hidden="true">◎</span>
                        <strong>{{ detailSalaryDisplay(detailTemplate).amount }}</strong>
                        <span class="npc-hire-salary-unit">
                          {{ detailSalaryDisplay(detailTemplate).unit }} / {{ detailSalaryDisplay(detailTemplate).period }}
                        </span>
                        <em class="npc-hire-salary-label">Salary</em>
                      </div>
                      <div class="npc-hire-divider" aria-hidden="true"><span /></div>
                    </header>

                    <p v-if="detailTemplate.hired" class="npc-hire-on-team-banner">
                      <span class="npc-hire-on-team-dot" aria-hidden="true" />
                      {{ hireStatusLabel(detailTemplate) }} — already working in your office.
                    </p>

                    <p v-if="isHiddenTemplate(detailTemplate)" class="hint npc-hire-hidden-banner">
                      Hidden agent — paste this UUID in Browse search:
                      <code class="npc-hire-uuid">{{ detailTemplate.catalogUuid }}</code>
                    </p>

                    <div class="npc-hire-glass-body">
                      <section class="npc-hire-section">
                        <h4 class="npc-hire-section-title">What This Agent Does</h4>
                        <p class="npc-hire-scope-text">{{ detailDescription(detailTemplate) }}</p>
                      </section>

                      <section v-if="detailExamples(detailTemplate).length" class="npc-hire-section">
                        <h4 class="npc-hire-section-title">Examples</h4>
                        <ul class="npc-hire-checklist">
                          <li v-for="(ex, i) in detailExamples(detailTemplate)" :key="`ex-${i}`">
                            <span aria-hidden="true">•</span>{{ ex }}
                          </li>
                        </ul>
                      </section>

                      <section class="npc-hire-section">
                        <h4 class="npc-hire-section-title">Job Scope</h4>
                        <div class="npc-hire-scope-list">
                          <article
                            v-for="card in detailJobScopeCards(detailTemplate)"
                            :key="card.key"
                            class="npc-hire-scope-item"
                          >
                            <span class="npc-hire-scope-icon" :class="card.icon" aria-hidden="true" />
                            <div class="npc-hire-scope-copy">
                              <span class="npc-hire-scope-label">{{ card.label }}</span>
                              <p class="npc-hire-scope-text">{{ card.text }}</p>
                            </div>
                          </article>
                        </div>
                      </section>

                      <section class="npc-hire-section">
                        <h4 class="npc-hire-section-title">What You Get</h4>
                        <ul class="npc-hire-checklist">
                          <li v-for="(item, i) in detailWhatYouGet(detailTemplate)" :key="`get-${i}`">
                            <span aria-hidden="true">✓</span>{{ item }}
                          </li>
                        </ul>
                      </section>

                      <div class="npc-hire-tip">
                        <span class="npc-hire-tip-icon" aria-hidden="true">💡</span>
                        <p>{{ detailTipText(detailTemplate) }}</p>
                      </div>
                    </div>

                    <footer class="npc-hire-glass-footer">
                      <button
                        type="button"
                        class="npc-hire-btn primary"
                        @click="openHire(detailTemplate)"
                      >
                        <span class="npc-hire-btn-icon" aria-hidden="true">⊕</span>
                        {{ detailTemplate.hired ? 'Hire another' : 'Hire Agent' }}
                      </button>
                      <button type="button" class="npc-hire-btn secondary" @click="closeDetail">
                        Cancel
                      </button>
                    </footer>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </Transition>
    </Teleport>

    <NModal
      v-model:show="hireOpen"
      preset="card"
      :title="hireTemplate ? (hireTemplate.hired ? `Hire another ${hireTemplate.name}` : `Hire ${hireTemplate.name}`) : 'Hire'"
      style="max-width: 520px"
    >
      <template v-if="hireTemplate">
        <p v-if="hireTemplate.hired" class="hint agent-hire-again-note">
          You already have {{ officeHireCount(hireTemplate) }} on your team. Each hire is a separate worker with its own salary.
        </p>
        <label class="channels-filter-label">Display name</label>
        <NInput v-model:value="hireName" style="margin: 8px 0 12px" />
        <template v-if="isDevTemplate(hireTemplate)">
          <template v-if="hireEngineOptions.length">
            <label class="channels-filter-label">写代码引擎</label>
            <NSpace style="margin: 8px 0 6px">
              <NButton
                v-for="eng in hireEngineOptions"
                :key="eng"
                size="small"
                :type="hireDevEngine === eng ? 'primary' : 'default'"
                @click="hireDevEngine = eng"
              >
                {{ DEV_ENGINE_LABELS[eng] || eng }}
              </NButton>
            </NSpace>
            <p class="hint sm" style="margin-top: 0">
              聘用后会请您填入 <strong>{{ DEV_ENGINE_LABELS[hireDevEngine] || hireDevEngine }}</strong> 的 API Key。
              没填的话这位员工暂时无法写代码，之后可在 Settings → Dev tools 补上。
            </p>
          </template>
          <label class="channels-filter-label">Job scope</label>
          <NSpace vertical style="margin: 8px 0 12px">
            <NCheckbox v-model:checked="hireDevScopeCanWrite">Can write code</NCheckbox>
            <NCheckbox v-model:checked="hireDevScopeCanReview">Can review code</NCheckbox>
          </NSpace>
          <p class="hint sm" style="margin-top: 0">
            Configure <strong>Writer</strong> and <strong>Reviewer(s)</strong> in Settings → Dev tools after hire.
          </p>
        </template>
        <template v-if="hireTemplate.requiresHirePassword || hireTemplate.hidden">
          <label class="channels-filter-label">Hire password</label>
          <NInput
            v-model:value="hirePassword"
            type="password"
            placeholder="Required for hidden agents"
            style="margin: 8px 0 12px"
          />
        </template>
        <p v-if="templateRequiresPortalOAuth(hireTemplate) && templatePortalOAuthMeta(hireTemplate)" class="hint sm" style="margin-top: 0">
          <strong>{{ templatePortalOAuthMeta(hireTemplate)!.label }} sign-in required.</strong>
          Confirm hire opens Google sign-in for
          <a :href="templatePortalOAuthMeta(hireTemplate)!.docsUrl" target="_blank" rel="noopener">MCP docs</a>.
          If sign-in fails or is cancelled, hire is blocked.
        </p>
        <p v-if="templateIsVip(hireTemplate)" class="hint sm" style="margin-top: 0">
          <strong>VIP Worker</strong> — included at no salary. Does not add to COO $1/day department billing.
        </p>
        <template v-if="(hireTemplate.salaryCreditsPerMonth ?? 0) > 0 && hireTemplate.pricingModel !== 'per_department'">
          <div class="hire-billing-field">
            <p class="hire-billing-byline">by daily, monthly, quarterly, yearly, or pay as you go</p>
            <div class="hire-billing-tabs">
              <button
                v-for="interval in BILLING_INTERVALS"
                :key="interval"
                type="button"
                class="hire-billing-tab"
                :class="{
                  active: hireBillingInterval === interval,
                  'hire-billing-tab--yearly': interval === 'yearly',
                }"
                @click="hireBillingInterval = interval"
              >
                <span v-if="interval === 'yearly'" class="hire-billing-ribbon">Most people choose</span>
                {{ intervalTabLabel(interval) }}
              </button>
            </div>
          </div>
        </template>
        <p v-if="hireTemplate.pricingModel === 'per_department'" class="hint sm" style="margin-top: 0">
          COO salary: <strong>$1/day per hired department</strong> (1 credit = $1 USD). Charged today on hire, then every day at 12:00 AM local time.
          {{ hireTemplate.ceoPricingNote ? `Current: ${hireTemplate.ceoPricingNote}.` : '' }}
        </p>
        <p v-if="hireIsPaygo" class="hint sm" style="margin-top: 0">
          {{ paygoRateLabel() }}. Usage is tracked on your PC; ECS syncs on recovery and only ever catches up (never reduces).
        </p>
        <p v-else class="hint sm" style="margin-top: 0">
          Credits auto-renew each billing period. Use <strong>Resign</strong> on My Agents to stop renewal.
        </p>
        <dl class="agent-browse-detail-list">
          <div v-if="hireIsPaygo" class="agent-browse-detail-row">
            <dt>Rate</dt>
            <dd><strong>{{ paygoRateLabel() }}</strong></dd>
          </div>
          <div v-else class="agent-browse-detail-row">
            <dt>{{ hireFirstChargeLabel }}</dt>
            <dd>
              <span v-if="hireShowListPrice" class="hire-price-was">{{ hireListCredits }}</span>
              <strong>{{ hireChargeCredits }}</strong>
              credits (charged today)<span v-if="hireChargeAdjustment" class="hire-price-adjust">{{ hireChargeAdjustment }}</span>
            </dd>
          </div>
          <div v-if="hireIsPaygo" class="agent-browse-detail-row">
            <dt>{{ hireFirstChargeLabel }}</dt>
            <dd><strong>0</strong> credits (no upfront charge)</dd>
          </div>
          <div class="agent-browse-detail-row">
            <dt>Your balance</dt>
            <dd><strong>{{ boss.session?.creditBalance ?? 0 }}</strong> credits</dd>
          </div>
        </dl>
        <p v-if="hireError" class="apply-error">{{ hireError }}</p>
      </template>
      <template #footer>
        <NButton @click="hireOpen = false">Cancel</NButton>
        <NButton type="primary" :loading="!!hiring" @click="confirmHire">Confirm hire</NButton>
      </template>
    </NModal>

    <ItGuysSetupModal
      v-model:show="itSetupOpen"
      :agent-name="itSetupAgentName"
      :need-cursor-key="itSetupNeedCursorKey"
      :need-codex-key="itSetupNeedCodexKey"
      :need-claude-key="itSetupNeedClaudeKey"
      @skip="message.info('可稍后在 Settings → Dev tools 配置，或跟 COO 说「配置开发工具」')"
    />

    <NpcOnboardingWizard
      v-model:show="onboardingOpen"
      :template-id="onboardingTemplateId"
      :agent-name="onboardingAgentName"
      :agent-role="onboardingAgentRole"
    />
  </div>
</template>

<style scoped>
.view-title {
  margin: 0 0 8px;
  font-size: 22px;
}
.hint {
  opacity: 0.75;
}

.agent-hire-again-note {
  margin: 0 0 10px;
  font-size: 13px;
}
.hire-billing-field {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 4px 0 0;
  padding-bottom: 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
}
.hire-billing-byline {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
}
.hire-billing-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  width: 100%;
  padding-top: 8px;
}
.hire-billing-tab {
  position: relative;
  overflow: visible;
  padding: 8px 16px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-2);
  color: var(--text); /* theme-aware: dark text in light mode, light in dark */
  font-size: 14px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s ease;
}
.hire-billing-tab:hover {
  background: var(--line);
}
.hire-billing-tab.active {
  background: #5eead4;
  color: #101418;
}
.hire-billing-tab--yearly {
  margin-top: 2px;
}
.hire-auto-renew {
  margin-top: 6px;
  font-size: 13px;
}
.hire-price-was {
  margin-right: 8px;
  opacity: 0.45;
  text-decoration: line-through;
}
.hire-price-adjust {
  margin-left: 6px;
  font-weight: 600;
  color: #5eead4;
}
.hire-billing-ribbon {
  position: absolute;
  top: -10px;
  left: 50%;
  transform: translateX(-50%);
  padding: 3px 8px;
  font-size: 9px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: #101418;
  background: linear-gradient(135deg, #ffd76a 0%, #f0b429 100%);
  border-radius: 999px;
  white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
  pointer-events: none;
  z-index: 2;
}
.hire-billing-ribbon::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -4px;
  transform: translateX(-50%);
  border: 4px solid transparent;
  border-top-color: #f0b429;
}
.includes-label {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--muted);
}
.npc-market-price-sub {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--muted);
  font-weight: 400;
}
.apply-error {
  color: #e88080;
  font-size: 13px;
}
.npc-hire-hidden-banner {
  margin: 0 0 12px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(255, 193, 7, 0.12);
  font-size: 13px;
}
.npc-hire-uuid {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  word-break: break-all;
}
.tag.on {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  background: rgba(70, 209, 96, 0.15);
  color: var(--accent-2);
  border: 1px solid rgba(70, 209, 96, 0.35);
}
.npc-vip-badge {
  margin-left: 6px;
  vertical-align: middle;
  background: rgba(255, 193, 7, 0.18);
  color: #c9a227;
  border-color: rgba(255, 193, 7, 0.45);
  font-size: 11px;
  font-weight: 600;
}
.npc-vip-price {
  color: var(--accent-2);
}
.btn.ghost {
  background: transparent;
  border: 1px solid var(--line);
  color: inherit;
  cursor: pointer;
  padding: 6px 12px;
  border-radius: 8px;
}
.btn.ghost.sm {
  font-size: 12px;
  padding: 4px 10px;
}
.btn {
  cursor: pointer;
}
</style>
