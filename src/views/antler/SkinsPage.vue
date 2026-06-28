<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { NModal, NButton, useMessage } from 'naive-ui'
import { useAntlerApi } from '@/composables/useAntlerApi'
import {
  loadCharacterImages,
  registerPreview,
  startSkinPreviews,
  stopSkinPreviews,
  unregisterPreviewsIn,
  SKIN_CANVAS_SIZE,
} from '@/lib/skin-preview'

interface Skin {
  id: string
  name: string
  palette: number
  hueShift?: number
  // Paid-skin overlay (from ECS store; builtins default to owned/free)
  priceCredits?: number
  owned?: boolean
  isDefault?: boolean
  previewUrl?: string | null
  assetUrl?: string | null
}

interface StoreSkin {
  id: string
  name: string
  priceCredits: number
  isDefault: boolean
  owned: boolean
  previewUrl?: string | null
  assetUrl?: string | null
}

interface OfficeAgent {
  id: string
  label: string
  role: string
  userAgentId?: string | null
  external?: boolean
}

interface SkinTarget {
  id: string
  name: string
  kind: 'user' | 'builtin'
  role?: string
}

const api = useAntlerApi()
const message = useMessage()
const route = useRoute()
const skins = ref<Skin[]>([])
const agents = ref<SkinTarget[]>([])
const focusAgentId = ref('')
const focusAgentName = computed(() => agents.value.find((a) => a.id === focusAgentId.value)?.name || '')
const gridRef = ref<HTMLElement | null>(null)
const applyOpen = ref(false)
const applySkin = ref<Skin | null>(null)
const applyAgentId = ref('')
const applyError = ref('')
const saving = ref(false)
const renaming = ref<string | null>(null)

// Filter + search + purchase state
const filterMode = ref<'all' | 'owned' | 'unowned'>('all')
const searchText = ref('')
const purchasing = ref<string | null>(null)

const filteredSkins = computed(() => {
  const q = searchText.value.trim().toLowerCase()
  return skins.value.filter((s) => {
    const owned = s.owned !== false
    if (filterMode.value === 'owned' && !owned) return false
    if (filterMode.value === 'unowned' && owned) return false
    if (q && !s.name.toLowerCase().includes(q)) return false
    return true
  })
})

async function loadSkins() {
  const r = await api.get<{ skins: Skin[] }>('/api/config/skins')
  const base = r.skins || []
  // Overlay paid-skin ownership/price from the ECS store. Failures are non-fatal:
  // builtins simply stay free + owned so the page always works.
  let overlay: Record<string, StoreSkin> = {}
  try {
    const store = await api.get<{ ok: boolean; skins?: StoreSkin[] }>('/api/skins/store')
    for (const s of store.skins || []) overlay[s.id] = s
  } catch {
    overlay = {}
  }
  const baseIds = new Set(base.map((s) => s.id))
  const builtins = base.map((s) => {
    const o = overlay[s.id]
    return {
      ...s,
      priceCredits: o ? o.priceCredits : 0,
      isDefault: o ? o.isDefault : true,
      owned: o ? o.owned : true, // no store entry → treat as owned builtin
      previewUrl: o ? o.previewUrl ?? null : null,
      assetUrl: o ? o.assetUrl ?? null : null,
    }
  })
  // ECS custom skins (not builtins, not already in the local list).
  const custom: Skin[] = Object.values(overlay)
    .filter((o) => !o.isDefault && !baseIds.has(o.id))
    .map((o) => ({
      id: o.id,
      name: o.name,
      palette: 0,
      hueShift: 0,
      priceCredits: o.priceCredits,
      isDefault: false,
      owned: o.owned,
      previewUrl: o.previewUrl ?? null,
      assetUrl: o.assetUrl ?? null,
    }))
  skins.value = [...builtins, ...custom]
}

// A skin animates on a canvas when it's a builtin (palette) or an owned custom
// skin with its full sprite sheet. Unpurchased custom skins show a still image.
function animatable(skin: Skin): boolean {
  if (!skin.previewUrl) return true // builtin palette skin
  return skin.owned !== false && !!skin.assetUrl
}
function customSheet(skin: Skin): string {
  return skin.owned !== false && skin.assetUrl ? skin.assetUrl : ''
}

async function purchaseSkin(skin: Skin) {
  if (purchasing.value) return
  purchasing.value = skin.id
  try {
    const r = await api.send<{ ok: boolean; charged?: boolean; creditBalance?: number }>(
      'POST',
      `/api/skins/${skin.id}/purchase`,
      {},
    )
    if (r.ok) {
      message.success(
        r.charged ? `Purchased — ${skin.priceCredits} credits used` : 'Unlocked',
      )
      await refresh()
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Purchase failed')
  } finally {
    purchasing.value = null
  }
}

function agentsFromSnapshot(list: OfficeAgent[]): SkinTarget[] {
  return list
    .filter((a) => !a.external)
    .map((a) => {
      if (a.userAgentId) {
        return { id: a.userAgentId, name: a.label, kind: 'user' as const }
      }
      return {
        id: `builtin:${a.role}`,
        name: a.label,
        kind: 'builtin' as const,
        role: a.role,
      }
    })
}

async function loadAgents() {
  const r = await api.get<{ agents?: OfficeAgent[] }>('/api/office/snapshot')
  agents.value = agentsFromSnapshot(r.agents || [])
}

function maxPalette() {
  return Math.max(0, ...skins.value.map((s) => s.palette ?? 0))
}

async function mountPreviews() {
  await nextTick()
  const root = gridRef.value
  if (!root) return
  unregisterPreviewsIn(root)
  root.querySelectorAll<HTMLCanvasElement>('canvas[data-palette]').forEach((canvas) => {
    const palette = Number(canvas.dataset.palette)
    const hue = Number(canvas.dataset.hue || 0)
    const customSrc = canvas.dataset.customSrc || null
    registerPreview({ canvas, palette, hueShift: hue, customSrc })
  })
  startSkinPreviews()
}

async function refresh() {
  stopSkinPreviews()
  await Promise.all([loadSkins(), loadAgents()])
  try {
    await loadCharacterImages(maxPalette() + 1)
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Could not load sprites')
    return
  }
  await mountPreviews()
}

async function openApply(skin: Skin) {
  applySkin.value = skin
  applyError.value = ''
  try {
    await loadAgents()
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Could not load agents')
  }
  const preferred = focusAgentId.value
  applyAgentId.value =
    (preferred && agents.value.some((a) => a.id === preferred) ? preferred : agents.value[0]?.id) ?? ''
  applyOpen.value = true
}

async function saveApply() {
  if (!applySkin.value || !applyAgentId.value) {
    applyError.value = 'Select an agent first.'
    return
  }
  const target = agents.value.find((a) => a.id === applyAgentId.value)
  if (!target) {
    applyError.value = 'Agent not found.'
    return
  }
  saving.value = true
  applyError.value = ''
  const payload = {
    sprite: applySkin.value.palette,
    hueShift: applySkin.value.hueShift || 0,
  }
  try {
    if (target.kind === 'builtin' && target.role) {
      await api.send('PUT', `/api/config/builtin-agents/${target.role}`, payload)
    } else {
      await api.send('PUT', `/api/config/agents/${target.id}`, payload)
    }
    message.success('Skin applied')
    applyOpen.value = false
  } catch (e) {
    applyError.value = e instanceof Error ? e.message : 'Save failed'
  } finally {
    saving.value = false
  }
}

async function saveSkinName(skin: Skin, name: string) {
  const next = name.trim()
  if (!next || next === skin.name) return
  renaming.value = skin.id
  try {
    const r = await api.send<{ skin?: Skin }>('PUT', `/api/config/skins/${skin.id}`, { name: next })
    skin.name = r.skin?.name || next
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Could not save name')
  } finally {
    renaming.value = null
  }
}

onMounted(async () => {
  const q = route.query.agent
  if (typeof q === 'string' && q.trim()) focusAgentId.value = q.trim()
  try {
    await refresh()
  } catch {
    message.error('Could not load skins')
  }
})
watch(
  () => route.query.agent,
  (q) => {
    focusAgentId.value = typeof q === 'string' ? q.trim() : ''
  },
)
// Re-mount canvas previews whenever the visible (filtered/searched) set changes.
watch(filteredSkins, async () => {
  await mountPreviews()
})
onUnmounted(() => stopSkinPreviews())
</script>

<template>
  <div class="antler-v1-root">
    <h2 class="view-title">Skins</h2>
    <p v-if="focusAgentName" class="hint focus-agent-hint">
      Pick a skin for <strong>{{ focusAgentName }}</strong> — click Apply on any character below.
    </p>
    <p v-else class="hint">Pick a character look — same animated previews as AntlerOffice 1.0.</p>

    <div class="skin-toolbar">
      <select v-model="filterMode" class="skin-filter" aria-label="Filter skins">
        <option value="all">All</option>
        <option value="owned">Purchased</option>
        <option value="unowned">Not purchased</option>
      </select>
      <input
        v-model="searchText"
        class="skin-search"
        type="search"
        placeholder="Search skins by name…"
        aria-label="Search skins"
      />
    </div>

    <div ref="gridRef" class="skin-char-grid">
      <div v-for="skin in filteredSkins" :key="skin.id" class="skin-char-card">
        <div class="skin-char-stage">
          <canvas
            v-if="animatable(skin)"
            :width="SKIN_CANVAS_SIZE"
            :height="SKIN_CANVAS_SIZE"
            :data-palette="skin.palette"
            :data-hue="skin.hueShift || 0"
            :data-custom-src="customSheet(skin)"
            :aria-label="`${skin.name} character preview`"
            role="img"
          />
          <img
            v-else
            :src="skin.previewUrl || ''"
            :width="SKIN_CANVAS_SIZE"
            :height="SKIN_CANVAS_SIZE"
            :alt="`${skin.name} preview`"
            class="skin-char-img"
          />
        </div>
        <input
          class="skin-char-name"
          type="text"
          :value="skin.name"
          :disabled="renaming === skin.id"
          aria-label="Rename character"
          @change="(e) => saveSkinName(skin, (e.target as HTMLInputElement).value)"
          @keydown.enter="(e) => (e.target as HTMLInputElement).blur()"
        />
        <span v-if="skin.owned !== false" class="skin-tag owned">{{ (skin.priceCredits || 0) > 0 ? 'Owned' : 'Free' }}</span>
        <span v-else class="skin-tag price">{{ skin.priceCredits }} credits</span>
        <button
          v-if="skin.owned !== false"
          type="button"
          class="btn"
          @click="openApply(skin)"
        >
          Apply
        </button>
        <button
          v-else
          type="button"
          class="btn btn-buy"
          :disabled="purchasing === skin.id"
          @click="purchaseSkin(skin)"
        >
          {{ purchasing === skin.id ? 'Purchasing…' : 'Purchase' }}
        </button>
      </div>
    </div>

    <p v-if="!skins.length" class="hint">No skins loaded yet.</p>
    <p v-else-if="!filteredSkins.length" class="hint">No skins match your filter.</p>

    <NModal v-model:show="applyOpen" preset="card" :title="applySkin ? `Apply “${applySkin.name}”` : 'Apply skin'" style="max-width: 420px">
      <p class="hint">Choose which agent should wear this character.</p>
      <select
        v-model="applyAgentId"
        class="skin-apply-select"
        :disabled="!agents.length"
        aria-label="Select agent"
      >
        <option v-if="!agents.length" value="">No agents available</option>
        <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name }}</option>
      </select>
      <p v-if="!agents.length" class="hint skin-apply-empty">
        Hire an agent from Agents → Browse, or use the built-in COO · OpenClaw.
      </p>
      <p v-if="applyError" class="apply-error">{{ applyError }}</p>
      <template #footer>
        <NButton @click="applyOpen = false">Cancel</NButton>
        <NButton type="primary" :loading="saving" :disabled="!agents.length" @click="saveApply">Save</NButton>
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
  margin: 0 0 8px;
}
.focus-agent-hint strong {
  color: #e8eaed;
}
.skin-apply-select {
  width: 100%;
  margin: 12px 0;
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: #1e222d;
  color: #e8eaed;
  font-size: 14px;
  box-sizing: border-box;
  color-scheme: dark;
}
.skin-apply-select option {
  background-color: #1e222d;
  color: #e8eaed;
}
.skin-apply-empty {
  font-size: 13px;
  margin-top: 0;
}
.apply-error {
  color: #e88080;
  font-size: 13px;
}
.skin-toolbar {
  display: flex;
  gap: 10px;
  margin: 4px 0 14px;
  flex-wrap: wrap;
}
.skin-filter,
.skin-search {
  padding: 8px 11px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: #1e222d;
  color: #e8eaed;
  font-size: 14px;
  box-sizing: border-box;
  color-scheme: dark;
}
.skin-filter {
  min-width: 150px;
}
.skin-search {
  flex: 1;
  min-width: 180px;
}
.skin-tag {
  display: inline-block;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  margin-bottom: 6px;
}
.skin-tag.owned {
  background: rgba(120, 200, 120, 0.18);
  color: #8fd18f;
}
.skin-tag.price {
  background: rgba(230, 200, 120, 0.18);
  color: #e6c878;
}
.btn-buy {
  background: #3b6fe0;
  color: #fff;
}
.skin-char-img {
  image-rendering: pixelated;
  object-fit: contain;
}
</style>
