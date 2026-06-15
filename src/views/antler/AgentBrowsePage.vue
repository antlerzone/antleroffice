<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'

const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })
const emit = defineEmits<{ hired: [] }>()
import { NModal, NButton, NInput, useMessage, useDialog } from 'naive-ui'
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
} from '@/lib/skin-preview'

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
  salaryCreditsPerMonth?: number
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
}

const FAV_KEY = 'antleroffice.agentBrowseFavorites'
const FILTER_KEY = 'antleroffice.agentBrowseFilters'
const AGENT_BROWSE_VIEW_KEY = 'antleroffice.agentBrowseView'

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
const status = ref('')
const role = ref('')
const creditMin = ref('')
const creditMax = ref('')
const ratingMin = ref('')
const sort = ref('')
const favoritesOnly = ref(false)

const detailOpen = ref(false)
const detailTemplate = ref<Template | null>(null)
const hireOpen = ref(false)
const hireTemplate = ref<Template | null>(null)
const hireName = ref('')
const hireError = ref('')

function loadFilterPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || '{}')
    if (typeof saved.search === 'string') search.value = saved.search
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
  if (t.highlights?.length) return t.highlights
  return ['High-quality pixel art', 'Unique NPC design', 'Commercial use']
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

const filterCount = computed(() => {
  let n = 0
  if (status.value) n++
  if (role.value) n++
  if (creditMin.value || creditMax.value) n++
  if (ratingMin.value) n++
  if (sort.value) n++
  if (favoritesOnly.value) n++
  return n
})

const filtered = computed(() => {
  let out = [...templates.value]
  const q = search.value.trim().toLowerCase()
  if (q) {
    out = out.filter((t) => {
      const { skinName } = templatePreviewSkin(t)
      const skills = (t.skillNames || t.skillIds || []).join(' ')
      return [t.name, t.tagline, t.role, skinName, skills].join(' ').toLowerCase().includes(q)
    })
  }
  if (status.value === 'available') out = out.filter((t) => !t.hired)
  else if (status.value === 'hired') out = out.filter((t) => t.hired)
  if (role.value) out = out.filter((t) => t.role === role.value)
  if (creditMin.value) {
    const min = Number(creditMin.value)
    if (Number.isFinite(min)) out = out.filter((t) => (t.salaryCreditsPerMonth ?? 0) >= min)
  }
  if (creditMax.value) {
    const max = Number(creditMax.value)
    if (Number.isFinite(max)) out = out.filter((t) => (t.salaryCreditsPerMonth ?? 0) <= max)
  }
  if (favoritesOnly.value) {
    const favs = new Set(loadFavorites())
    out = out.filter((t) => favs.has(t.id))
  }
  if (ratingMin.value) {
    const minR = Number(ratingMin.value)
    if (Number.isFinite(minR)) {
      out = out.filter((t) => {
        const r = browseRating(t)
        return r != null && r >= minR
      })
    }
  }
  if (sort.value === 'rating_desc') out.sort((a, b) => browseRating(b) - browseRating(a))
  else if (sort.value === 'rating_asc') out.sort((a, b) => browseRating(a) - browseRating(b))
  return out
})

function clearFilters() {
  search.value = ''
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
  const [sk, cat] = await Promise.all([
    api.get<{ skins: Skin[] }>('/api/config/skins'),
    api.get<{ templates: Template[] }>('/api/config/agents/catalog'),
  ])
  skins.value = sk.skins || []
  templates.value = cat.templates || []
  const maxPal = Math.max(0, ...skins.value.map((s) => s.palette ?? 0), ...templates.value.map((t) => t.sprite ?? 0))
  await loadCharacterImages(maxPal + 1)
  await mountPreviews()
}

function openDetail(t: Template) {
  detailTemplate.value = t
  detailOpen.value = true
}

function openHire(t: Template) {
  if (t.hired) return
  if (officeShare.isMemberClient) {
    message.warning('Hiring is only available on the host office.')
    return
  }
  hireTemplate.value = t
  hireName.value = t.name
  hireError.value = ''
  hireOpen.value = true
  detailOpen.value = false
}

async function confirmHire() {
  const t = hireTemplate.value
  if (!t) return
  hiring.value = t.id
  hireError.value = ''
  try {
    const r = await api.send<{
      ok: boolean
      creditBalance?: number
      error?: string
      postInstall?: { mcps?: { mcpId: string; name: string; hint?: string }[] } | null
    }>(
      'POST',
      '/api/config/agents/hire',
      { templateId: t.id, name: hireName.value.trim() || t.name },
    )
    if (boss.session && r.creditBalance !== undefined) {
      boss.session.creditBalance = r.creditBalance
    }
    hireOpen.value = false
    await load()
    emit('hired')
    const mcps = r.postInstall?.mcps || []
    if (mcps.length) {
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
    } else {
      message.success(`${t.name} joined your office!`)
    }
  } catch (e) {
    hireError.value = e instanceof Error ? e.message : 'Hire failed'
  } finally {
    hiring.value = null
  }
}

function onFavClick(t: Template, ev: Event) {
  ev.stopPropagation()
  toggleFavorite(t.id)
  if (favoritesOnly.value) void load()
}

watch([search, status, role, creditMin, creditMax, ratingMin, sort, favoritesOnly], () => {
  saveFilterPrefs()
  void mountPreviews()
})
watch(viewMode, () => void mountPreviews())

onMounted(() => {
  loadFilterPrefs()
  load().catch(() => message.error('Could not load catalog'))
})
onUnmounted(() => stopSkinPreviews())
</script>

<template>
  <div :class="props.embedded ? 'agent-browse-embedded' : 'antler-v1-root'">
    <template v-if="!props.embedded">
      <h2 class="view-title">Hire an agent</h2>
      <p class="hint">Browse ready-made NPC employees — same market as AntlerOffice 1.0.</p>
    </template>

    <div class="channels-list-bar agent-browse-list-bar">
      <input
        v-model="search"
        type="search"
        class="channels-search"
        placeholder="Search NPCs, skills, skins…"
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
          <table class="agents-table">
            <thead>
              <tr>
                <th class="agent-td-fav" />
                <th>Skin</th>
                <th>Name</th>
                <th>Salary</th>
                <th>Rating</th>
                <th>Skills</th>
                <th>Status</th>
                <th class="agent-th-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in filtered" :key="t.id">
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
                  <strong>{{ t.name }}</strong>
                  <div class="hint browse-list-sub">
                    {{ templatePreviewSkin(t).skinName }} · {{ t.tagline }}
                  </div>
                </td>
                <td>
                  <strong>{{ t.salaryCreditsPerMonth ?? 0 }}</strong>
                  {{ t.currency || 'credits' }}/mo
                </td>
                <td><span class="npc-market-star">★</span> {{ formatRating(t) }}</td>
                <td>
                  <div class="agent-td-tags">
                    <span v-for="tag in templateSkillTags(t)" :key="tag" class="tag">{{ tag }}</span>
                  </div>
                </td>
                <td>
                  <span v-if="t.hired" class="tag on">Hired</span>
                  <span v-else class="tag">Available</span>
                </td>
                <td class="agent-td-actions">
                  <button type="button" class="btn ghost sm" @click="openDetail(t)">Details</button>
                  <button
                    v-if="!t.hired"
                    type="button"
                    class="btn sm"
                    :disabled="hiring === t.id"
                    @click="openHire(t)"
                  >
                    Hire
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <template v-else-if="viewMode === 'grid' && filtered.length">
        <article
          v-for="t in filtered"
          :key="t.id"
          class="npc-market-card"
        >
          <div class="npc-market-preview">
            <span class="npc-market-skin-pill">
              <span class="npc-market-skin-dot" aria-hidden="true" />
              {{ templatePreviewSkin(t).skinName }}
            </span>
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
            <h3 class="npc-market-name">{{ t.name }}</h3>
            <div class="npc-market-tagline">
              <span class="npc-market-tagline-icon">◆</span>
              {{ t.tagline }}
            </div>
            <p v-if="t.includesLabel" class="includes-label">Includes: {{ t.includesLabel }}</p>
            <div class="npc-market-info">
              <div class="npc-market-price">
                <div class="npc-market-price-icon">◎</div>
                <div class="npc-market-price-text">
                  <strong>{{ t.salaryCreditsPerMonth ?? 0 }}</strong>
                  <span>{{ t.currency || 'credits' }} / month</span>
                </div>
              </div>
              <ul class="npc-market-features">
                <li v-for="(h, i) in templateHighlights(t)" :key="i">
                  <span class="npc-market-check">✓</span>{{ h }}
                </li>
              </ul>
            </div>
            <div class="npc-market-actions">
              <span v-if="t.hired" class="tag on npc-market-hired">Hired</span>
              <button v-else type="button" class="btn npc-market-hire" :disabled="hiring === t.id" @click="openHire(t)">
                ▣ Hire
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

      <p v-else-if="templates.length && !filtered.length" class="hint">
        No NPC templates match your filters.
        <button type="button" class="btn ghost sm" @click="clearFilters">Clear filters</button>
      </p>
      <p v-else class="hint">No NPC templates available yet.</p>
    </div>

    <NModal v-model:show="detailOpen" preset="card" :title="detailTemplate?.name || 'NPC'" style="max-width: 480px">
      <template v-if="detailTemplate">
        <p class="npc-market-tagline">{{ detailTemplate.tagline }}</p>
        <dl class="agent-browse-detail-list">
          <div class="agent-browse-detail-row">
            <dt>Salary</dt>
            <dd>{{ detailTemplate.salaryCreditsPerMonth ?? 0 }} {{ detailTemplate.currency || 'credits' }}/mo</dd>
          </div>
          <div class="agent-browse-detail-row">
            <dt>Rating</dt>
            <dd>
              <template v-if="(detailTemplate.reviewCount ?? 0) > 0">
                ★ {{ formatRating(detailTemplate) }} ({{ detailTemplate.reviewCount }} reviews)
              </template>
              <template v-else>No reviews yet</template>
              <span v-if="(detailTemplate.hireCount ?? 0) > 0">
                · {{ detailTemplate.hireCount }} hired in this office
              </span>
            </dd>
          </div>
          <div class="agent-browse-detail-row">
            <dt>Status</dt>
            <dd>{{ detailTemplate.hired ? 'Hired' : 'Available' }}</dd>
          </div>
        </dl>
        <ul class="npc-market-features npc-market-features-modal">
          <li v-for="(h, i) in templateHighlights(detailTemplate)" :key="i">
            <span class="npc-market-check">✓</span>{{ h }}
          </li>
        </ul>
      </template>
      <template #footer>
        <NButton @click="detailOpen = false">Close</NButton>
        <NButton
          v-if="detailTemplate && !detailTemplate.hired"
          type="primary"
          @click="openHire(detailTemplate)"
        >
          Hire
        </NButton>
      </template>
    </NModal>

    <NModal v-model:show="hireOpen" preset="card" :title="hireTemplate ? `Hire ${hireTemplate.name}` : 'Hire'" style="max-width: 440px">
      <template v-if="hireTemplate">
        <label class="channels-filter-label">Display name</label>
        <NInput v-model:value="hireName" style="margin: 8px 0 12px" />
        <dl class="agent-browse-detail-list">
          <div class="agent-browse-detail-row">
            <dt>First month</dt>
            <dd><strong>{{ hireTemplate.salaryCreditsPerMonth ?? 0 }}</strong> credits (charged today)</dd>
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
.includes-label {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--muted);
}
.apply-error {
  color: #e88080;
  font-size: 13px;
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
