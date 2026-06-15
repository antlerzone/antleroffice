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

async function loadSkins() {
  const r = await api.get<{ skins: Skin[] }>('/api/config/skins')
  skins.value = r.skins || []
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
    registerPreview({ canvas, palette, hueShift: hue })
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
onUnmounted(() => stopSkinPreviews())
</script>

<template>
  <div class="antler-v1-root">
    <h2 class="view-title">Skins</h2>
    <p v-if="focusAgentName" class="hint focus-agent-hint">
      Pick a skin for <strong>{{ focusAgentName }}</strong> — click Apply on any character below.
    </p>
    <p v-else class="hint">Pick a character look — same animated previews as AntlerOffice 1.0.</p>

    <div ref="gridRef" class="skin-char-grid">
      <div v-for="skin in skins" :key="skin.id" class="skin-char-card">
        <div class="skin-char-stage">
          <canvas
            :width="SKIN_CANVAS_SIZE"
            :height="SKIN_CANVAS_SIZE"
            :data-palette="skin.palette"
            :data-hue="skin.hueShift || 0"
            :aria-label="`${skin.name} character preview`"
            role="img"
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
        <button type="button" class="btn" @click="openApply(skin)">Apply</button>
      </div>
    </div>

    <p v-if="!skins.length" class="hint">No skins loaded yet.</p>

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
</style>
