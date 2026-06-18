<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AgentBrowsePage from '@/views/antler/AgentBrowsePage.vue'
import OfficeOrgChart from '@/components/antler/OfficeOrgChart.vue'
import AgentResumeModal from '@/components/antler/AgentResumeModal.vue'
import AgentUsageBars from '@/components/antler/AgentUsageBars.vue'
import AgentHireCompareCard from '@/components/antler/AgentHireCompareCard.vue'
import { NDropdown, NModal, NButton, NInput, useMessage, useDialog, type DropdownOption } from 'naive-ui'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { formatTokenCount, useAntlerAgentTokens } from '@/composables/useAntlerAgentTokens'
import {
  loadCharacterImages,
  registerPreview,
  startSkinPreviews,
  stopSkinPreviews,
  unregisterPreviewsIn,
  AGENT_SKIN_CANVAS,
  SKIN_CANVAS_SIZE,
} from '@/lib/skin-preview'

interface Skin {
  id: string
  name: string
  palette: number
  hueShift?: number
}

interface UserAgent {
  id: string
  name: string
  role: string
  runtime: string
  sprite?: number
  hueShift?: number
  skillIds?: string[]
  openclawSkillNames?: string[]
  mcpIds?: string[]
  mcpBindings?: { mcpId: string; accountIds: string[] }[]
  openclawAgentId?: string | null
  salaryCreditsPerMonth?: number | null
  hiredAt?: number | null
  payrollStatus?: string | null
  fireAt?: number | null
  templateId?: string | null
}

interface McpAccount {
  id: string
  label: string
  authType?: string
  authConnected?: boolean
}

interface McpServer {
  id: string
  name: string
  url?: string
  authRequired?: boolean
  accounts?: McpAccount[]
}

interface BuiltinNpc {
  id: string
  label: string
  role: string
  runtime?: string
  charSprite?: number
  hueShift?: number
  npcState?: string
  userAgentId?: string | null
  external?: boolean
  openclawAgentId?: string | null
}

interface Skill {
  id: string
  name: string
}

const AGENT_VIEW_KEY = 'antleroffice.agentView'

type AgentTab = 'mine' | 'browse' | 'hierarchy'

const api = useAntlerApi()
const route = useRoute()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const { lookupTokens, refreshTokenUsage, connected } = useAntlerAgentTokens()

function tabFromQuery(t: unknown): AgentTab {
  if (t === 'browse') return 'browse'
  if (t === 'hierarchy') return 'hierarchy'
  return 'mine'
}

const agentTab = ref<AgentTab>(tabFromQuery(route.query.tab))
const viewMode = ref<'list' | 'grid'>(
  localStorage.getItem(AGENT_VIEW_KEY) === 'grid' ? 'grid' : 'list',
)
const agents = ref<UserAgent[]>([])
const officeSnapshot = ref<BuiltinNpc[]>([])
const builtins = ref<BuiltinNpc[]>([])
const skins = ref<Skin[]>([])
const skills = ref<Skill[]>([])
const mcps = ref<McpServer[]>([])
const mcpModalOpen = ref(false)
const mcpModalAgent = ref<UserAgent | null>(null)
const mcpBindingsForm = ref<{ mcpId: string; accountIds: string[] }[]>([])
const mcpModalBusy = ref(false)
const mcpModalError = ref('')
const entitlementModalOpen = ref(false)
const entitlementWarnings = ref<
  Array<{ item: string; scope: string; otWorkerId?: string; otCreditsPerTask?: number }>
>([])
const entitlementCompare = ref({ otPerTask: 15, monthlySalary: 199, workerName: '' })
const reviewModalOpen = ref(false)
const reviewModalAgent = ref<UserAgent | null>(null)
const reviewStars = ref(0)
const reviewBusy = ref(false)
const reviewError = ref('')
const renameModalOpen = ref(false)
const renameModalAgent = ref<UserAgent | null>(null)
const renameName = ref('')
const renameBusy = ref(false)
const renameError = ref('')
const resumeOpen = ref(false)
const resumeAgent = ref<UserAgent | null>(null)
const resumeBuiltinRole = ref<string | null>(null)
const gridRef = ref<HTMLElement | null>(null)
const loading = ref(false)
const previewMap = new Map<string, ReturnType<typeof registerPreview>>()

function setView(mode: 'list' | 'grid') {
  viewMode.value = mode
  localStorage.setItem(AGENT_VIEW_KEY, mode)
  void mountPreviews()
}

function setAgentTab(tab: AgentTab) {
  if (agentTab.value === 'browse' && tab !== 'browse') stopSkinPreviews()
  if (agentTab.value === 'mine' && tab !== 'mine') stopSkinPreviews()
  agentTab.value = tab
  void router.replace({
    name: 'AntlerAgents',
    query: tab === 'mine' ? {} : { tab },
  })
  if (tab === 'mine') void nextTick(() => mountPreviews())
}

function onHired() {
  void refresh()
  setAgentTab('mine')
}

function fmtDate(ts?: number | null) {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString()
}

function skinIdForAgent(agent: UserAgent) {
  const hit = skins.value.find(
    (s) => s.palette === agent.sprite && (s.hueShift || 0) === (agent.hueShift || 0),
  )
  return hit?.id || skins.value[0]?.id || ''
}

function skinForAgent(agent: UserAgent) {
  return skins.value.find((s) => s.id === skinIdForAgent(agent)) || null
}

function agentSkinMeta(agent: UserAgent) {
  const skin = skinForAgent(agent)
  return {
    palette: skin?.palette ?? agent.sprite ?? 0,
    hueShift: skin?.hueShift ?? agent.hueShift ?? 0,
    name: skin?.name || 'Default',
  }
}

function skinForBuiltin(npc: BuiltinNpc) {
  const palette = typeof npc.charSprite === 'number' ? npc.charSprite : 0
  const hue = npc.hueShift || 0
  return skins.value.find((s) => s.palette === palette && (s.hueShift || 0) === hue)
}

function builtinSkinMeta(npc: BuiltinNpc) {
  const skin = skinForBuiltin(npc)
  return {
    palette: typeof npc.charSprite === 'number' ? npc.charSprite : 0,
    hueShift: npc.hueShift || 0,
    name: skin?.name || 'Built-in',
  }
}

function skillTags(agent: UserAgent) {
  const oc = agent.openclawSkillNames || []
  if (oc.length) return oc
  return (agent.skillIds || [])
    .map((id) => skills.value.find((s) => s.id === id)?.name)
    .filter(Boolean) as string[]
}

function isWorking(agent: UserAgent) {
  const npc = builtins.value.find((n) => n.userAgentId === agent.id)
  return npc?.npcState === 'working'
}

function tokenLabel(openclawAgentId?: string | null, role?: string) {
  if (!connected.value) return '—'
  const stats = lookupTokens(openclawAgentId, role)
  if (!stats) return '—'
  return formatTokenCount(stats.total)
}

async function loadAll() {
  const [agentsRes, snapRes, skinsRes, skillsRes, mcpsRes] = await Promise.all([
    api.get<{ agents?: UserAgent[] }>('/api/config/agents'),
    api.get<{ agents?: BuiltinNpc[] }>('/api/office/snapshot'),
    api.get<{ skins?: Skin[] }>('/api/config/skins'),
    api.get<{ skills?: Skill[] }>('/api/config/skills'),
    api.get<{ mcps?: McpServer[] }>('/api/config/mcps'),
  ])
  agents.value = agentsRes.agents || []
  const snap = snapRes.agents || []
  officeSnapshot.value = snap
  builtins.value = snap.filter((a) => !a.userAgentId && !a.external)
  skins.value = skinsRes.skins || []
  skills.value = skillsRes.skills || []
  mcps.value = mcpsRes.mcps || []
}

async function mountPreviews() {
  await nextTick()
  const root = gridRef.value
  if (!root) return
  unregisterPreviewsIn(root)
  previewMap.clear()
  root.querySelectorAll<HTMLCanvasElement>('canvas[data-palette]').forEach((canvas) => {
    const palette = Number(canvas.dataset.palette) || 0
    const hue = Number(canvas.dataset.hue) || 0
    const entry = registerPreview({ canvas, palette, hueShift: hue })
    const agentId = canvas.dataset.agentPreview
    if (agentId) previewMap.set(agentId, entry)
  })
  startSkinPreviews()
}

async function refresh() {
  loading.value = true
  stopSkinPreviews()
  try {
    await loadAll()
    await refreshTokenUsage()
    try {
      await loadCharacterImages(Math.max(0, ...skins.value.map((s) => s.palette ?? 0)) + 1)
    } catch {
      /* sprites optional */
    }
    await mountPreviews()
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Could not load agents')
  } finally {
    loading.value = false
  }
}

function confirmFire(agent: UserAgent) {
  const hasPayroll =
    agent.salaryCreditsPerMonth &&
    agent.salaryCreditsPerMonth > 0 &&
    typeof agent.hiredAt === 'number'
  const leaveDate = hasPayroll && agent.hiredAt ? fmtDate(agent.hiredAt) : null
  const msg = leaveDate
    ? `Fire "${agent.name}"?\n\nNo refund. They keep working until the next salary date, then leave.`
    : `Fire "${agent.name}" now?\n\nThey will be removed immediately.`
  dialog.warning({
    title: 'Fire agent',
    content: msg,
    positiveText: 'Fire',
    negativeText: 'Cancel',
    onPositiveClick: async () => {
      try {
        const r = await api.send<{ ok?: boolean; error?: string; immediate?: boolean; fireAt?: number }>(
          'POST',
          `/api/config/agents/${agent.id}/fire`,
        )
        if (r.ok === false) throw new Error(r.error || 'Could not fire')
        message.success(r.immediate ? `${agent.name} has left` : `${agent.name} scheduled to leave`)
        await refresh()
      } catch (e) {
        message.error(e instanceof Error ? e.message : 'Could not fire agent')
      }
    },
  })
}

function mcpBindingFor(mcpId: string) {
  return mcpBindingsForm.value.find((b) => b.mcpId === mcpId)
}

function isMcpLinked(mcpId: string) {
  return !!mcpBindingFor(mcpId)
}

function toggleAgentMcp(mcpId: string) {
  const idx = mcpBindingsForm.value.findIndex((b) => b.mcpId === mcpId)
  if (idx >= 0) {
    mcpBindingsForm.value.splice(idx, 1)
    return
  }
  mcpBindingsForm.value.push({ mcpId, accountIds: [] })
}

function toggleAgentMcpAccount(mcpId: string, accountId: string) {
  let binding = mcpBindingFor(mcpId)
  if (!binding) {
    binding = { mcpId, accountIds: [] }
    mcpBindingsForm.value.push(binding)
  }
  const set = new Set(binding.accountIds)
  if (set.has(accountId)) set.delete(accountId)
  else set.add(accountId)
  binding.accountIds = [...set]
}

function openMcpBindings(agent: UserAgent) {
  mcpModalAgent.value = agent
  mcpModalError.value = ''
  const existing = agent.mcpBindings?.length
    ? agent.mcpBindings.map((b) => ({ mcpId: b.mcpId, accountIds: [...(b.accountIds || [])] }))
    : (agent.mcpIds || []).map((mcpId) => ({ mcpId, accountIds: [] as string[] }))
  mcpBindingsForm.value = existing
  mcpModalOpen.value = true
}

async function saveMcpBindings() {
  if (!mcpModalAgent.value) return
  mcpModalError.value = ''
  mcpModalBusy.value = true
  try {
    const mcpBindings = mcpBindingsForm.value.filter((b) => b.mcpId)
    const res = await api.send<{
      entitlementWarnings?: Array<{ otCreditsPerTask?: number; otWorkerId?: string; item: string }>
    }>('PUT', `/api/config/agents/${mcpModalAgent.value.id}`, { mcpBindings })
    const hit = agents.value.find((a) => a.id === mcpModalAgent.value?.id)
    if (hit) {
      hit.mcpBindings = mcpBindings
      hit.mcpIds = mcpBindings.map((b) => b.mcpId)
    }
    mcpModalOpen.value = false
    message.success('MCP accounts updated')
    if (res.entitlementWarnings?.length) {
      const w = res.entitlementWarnings[0]
      entitlementWarnings.value = res.entitlementWarnings
      entitlementCompare.value = {
        otPerTask: w.otCreditsPerTask ?? 15,
        monthlySalary: hit?.salaryCreditsPerMonth ?? 199,
        workerName: w.otWorkerId || 'specialist',
      }
      entitlementModalOpen.value = true
    }
  } catch (e) {
    mcpModalError.value = e instanceof Error ? e.message : 'Could not save MCP bindings'
  } finally {
    mcpModalBusy.value = false
  }
}

function mcpSummary(agent: UserAgent) {
  const bindings = agent.mcpBindings?.length
    ? agent.mcpBindings
    : (agent.mcpIds || []).map((mcpId) => ({ mcpId, accountIds: [] as string[] }))
  if (!bindings.length) return ''
  const parts = bindings.map((b) => {
    const m = mcps.value.find((x) => x.id === b.mcpId)
    const name = m?.name || b.mcpId
    const count = b.accountIds?.length || 0
    return count ? `${name} (${count})` : name
  })
  return parts.join(', ')
}

function userMenuOptions(agent: UserAgent): DropdownOption[] {
  const opts: DropdownOption[] = [
    { label: 'View overview', key: 'view' },
    { label: 'Rename', key: 'rename' },
    { label: 'Change skin', key: 'skin' },
    { label: 'Review', key: 'review' },
    { label: 'MCP accounts', key: 'mcps' },
  ]
  if (agent.payrollStatus !== 'pending_termination') {
    opts.push({ label: 'Fire', key: 'fire' })
  }
  return opts
}

async function openReview(agent: UserAgent) {
  reviewModalAgent.value = agent
  reviewError.value = ''
  reviewStars.value = 0
  reviewModalOpen.value = true
  try {
    const r = await api.get<{ review?: { rating?: number } | null }>(`/api/config/agents/${agent.id}/review`)
    reviewStars.value = r.review?.rating || 0
  } catch {
    /* no prior review */
  }
}

async function saveReview() {
  if (!reviewModalAgent.value || reviewStars.value < 1) {
    reviewError.value = 'Pick 1–5 stars.'
    return
  }
  reviewBusy.value = true
  reviewError.value = ''
  try {
    await api.send('PUT', `/api/config/agents/${reviewModalAgent.value.id}/review`, {
      rating: reviewStars.value,
    })
    message.success('Review saved')
    reviewModalOpen.value = false
  } catch (e) {
    reviewError.value = e instanceof Error ? e.message : 'Could not save review'
  } finally {
    reviewBusy.value = false
  }
}

function openRename(agent: UserAgent) {
  renameModalAgent.value = agent
  renameName.value = agent.name
  renameError.value = ''
  renameModalOpen.value = true
}

async function saveRename() {
  if (!renameModalAgent.value) return
  const trimmed = renameName.value.trim()
  if (!trimmed) {
    renameError.value = 'Enter a name.'
    return
  }
  if (trimmed === renameModalAgent.value.name) {
    renameModalOpen.value = false
    return
  }
  renameBusy.value = true
  renameError.value = ''
  try {
    const r = await api.send<{ agent?: UserAgent }>('PUT', `/api/config/agents/${renameModalAgent.value.id}`, {
      name: trimmed,
    })
    const hit = agents.value.find((a) => a.id === renameModalAgent.value!.id)
    if (hit) hit.name = r.agent?.name || trimmed
    message.success('Agent renamed')
    renameModalOpen.value = false
  } catch (e) {
    renameError.value = e instanceof Error ? e.message : 'Could not rename agent'
  } finally {
    renameBusy.value = false
  }
}

function builtinMenuOptions(): DropdownOption[] {
  return [{ label: 'View overview', key: 'view' }]
}

function openOverview(agent: UserAgent) {
  resumeBuiltinRole.value = null
  resumeAgent.value = agent
  resumeOpen.value = true
}

function openBuiltinOverview(npc: BuiltinNpc) {
  resumeBuiltinRole.value = npc.role
  resumeAgent.value = {
    id: npc.id,
    name: npc.label,
    role: npc.role,
    runtime: npc.runtime || 'openclaw',
    sprite: npc.charSprite,
    hueShift: npc.hueShift,
    salaryCreditsPerMonth: null,
    hiredAt: null,
  }
  resumeOpen.value = true
}

function onBuiltinMenu(key: string, npc: BuiltinNpc) {
  if (key === 'view') openBuiltinOverview(npc)
}

function resumeSkinMeta() {
  if (!resumeAgent.value) return { palette: 0, hueShift: 0 }
  if (resumeBuiltinRole.value) {
    const b = builtins.value.find((n) => n.role === resumeBuiltinRole.value)
    if (b) return builtinSkinMeta(b)
    return { palette: resumeAgent.value.sprite ?? 0, hueShift: resumeAgent.value.hueShift ?? 0, name: 'Built-in' }
  }
  return agentSkinMeta(resumeAgent.value)
}

function onUserMenu(key: string, agent: UserAgent) {
  if (key === 'fire') confirmFire(agent)
  else if (key === 'view') openOverview(agent)
  else if (key === 'rename') openRename(agent)
  else if (key === 'skin') void router.push({ name: 'AntlerSkins', query: { agent: agent.id } })
  else if (key === 'review') void openReview(agent)
  else if (key === 'mcps') openMcpBindings(agent)
}

const hasRows = computed(() => builtins.value.length > 0 || agents.value.length > 0)

watch(
  () => resumeOpen.value,
  (open) => {
    if (!open) resumeBuiltinRole.value = null
  },
)

watch(viewMode, () => void mountPreviews())
watch(
  () => route.query.tab,
  (t) => {
    agentTab.value = tabFromQuery(t)
  },
)

onMounted(() => refresh())
onUnmounted(() => stopSkinPreviews())
</script>

<template>
  <div class="antler-v1-root agents-page">
    <div class="view-head">
      <h1 class="view-title">Agents</h1>
    </div>

    <div class="tabs" role="tablist">
      <button
        type="button"
        class="tab"
        :class="{ active: agentTab === 'mine' }"
        @click="setAgentTab('mine')"
      >
        My Agents
      </button>
      <button
        type="button"
        class="tab"
        :class="{ active: agentTab === 'browse' }"
        @click="setAgentTab('browse')"
      >
        Browse
      </button>
      <button
        type="button"
        class="tab"
        :class="{ active: agentTab === 'hierarchy' }"
        @click="setAgentTab('hierarchy')"
      >
        Hierarchy
      </button>
    </div>

    <div v-show="agentTab === 'mine'" class="skilltab">
      <div class="tab-toolbar">
        <p class="hint">
          Your hired NPC employees and built-in departments. Hired agents show hire date and monthly salary.
        </p>
        <div class="inline">
          <div class="seg">
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
          <button type="button" class="btn" @click="setAgentTab('browse')">+ Add Agent</button>
        </div>
      </div>

      <p v-if="loading && !hasRows" class="hint">Loading agents…</p>
      <p v-else-if="!hasRows" class="hint">No agents yet. Click "+ Add Agent" to hire one.</p>

      <div
        v-else
        ref="gridRef"
        class="agent-grid"
        :class="viewMode === 'list' ? 'agent-list-view' : 'npc-market-grid'"
      >
      <template v-if="viewMode === 'list'">
        <div class="agents-table-wrap">
          <table class="agents-table agents-table--tokens">
            <thead>
              <tr>
                <th>Skin</th>
                <th>Name</th>
                <th>Role</th>
                <th>Runtime</th>
                <th>Salary</th>
                <th>Hired</th>
                <th>Skills</th>
                <th>Tokens</th>
                <th class="agent-th-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="b in builtins" :key="b.id" class="agent-row-builtin">
                <td class="agent-td-skin">
                  <div class="agent-td-skin-inner">
                    <div class="agent-skin-stage">
                      <canvas
                        class="agent-skin-canvas"
                        :width="AGENT_SKIN_CANVAS"
                        :height="AGENT_SKIN_CANVAS"
                        :data-palette="b.charSprite ?? 0"
                        :data-hue="b.hueShift ?? 0"
                        :aria-label="skinForBuiltin(b)?.name || 'Built-in'"
                      />
                    </div>
                  </div>
                </td>
                <td class="agent-td-name">
                  <div class="agent-td-name-inner">
                    <strong>{{ b.label }}</strong>
                    <span class="tag built">Built-in</span>
                    <span class="pill" :class="{ ok: b.npcState === 'working' }">
                      {{ b.npcState === 'working' ? 'Working' : 'Idle' }}
                    </span>
                  </div>
                </td>
                <td>{{ b.role }}</td>
                <td>{{ b.runtime || 'openclaw' }}</td>
                <td class="agent-td-muted">—</td>
                <td class="agent-td-muted">—</td>
                <td class="agent-td-muted">—</td>
                <td class="agent-td-muted">{{ tokenLabel(b.openclawAgentId, b.role) }}</td>
                <td class="agent-td-actions">
                  <div class="agent-td-actions-inner">
                    <NDropdown
                      trigger="click"
                      :options="builtinMenuOptions()"
                      @select="(key) => onBuiltinMenu(String(key), b)"
                    >
                      <button type="button" class="btn ghost sm agent-actions-btn">Actions ▾</button>
                    </NDropdown>
                  </div>
                </td>
              </tr>
              <tr v-for="a in agents" :key="a.id">
                <td class="agent-td-skin">
                  <div class="agent-td-skin-inner">
                    <div class="agent-skin-stage">
                      <canvas
                        class="agent-skin-canvas"
                        :width="AGENT_SKIN_CANVAS"
                        :height="AGENT_SKIN_CANVAS"
                        :data-palette="skins.find((s) => s.id === skinIdForAgent(a))?.palette ?? a.sprite ?? 0"
                        :data-hue="skins.find((s) => s.id === skinIdForAgent(a))?.hueShift ?? a.hueShift ?? 0"
                        :data-agent-preview="a.id"
                      />
                    </div>
                  </div>
                </td>
                <td class="agent-td-name">
                  <div class="agent-td-name-inner">
                    <strong>{{ a.name }}</strong>
                    <span class="pill" :class="{ ok: isWorking(a) }">{{ isWorking(a) ? 'Working' : 'Idle' }}</span>
                    <span v-if="a.payrollStatus === 'suspended'" class="tag warn">Suspended</span>
                    <span v-if="a.payrollStatus === 'pending_termination'" class="tag warn">
                      Leaving {{ fmtDate(a.fireAt) }}
                    </span>
                  </div>
                </td>
                <td>{{ a.role }}</td>
                <td>{{ a.runtime }}</td>
                <td class="agent-td-muted">
                  {{ a.salaryCreditsPerMonth ? `${a.salaryCreditsPerMonth} cr/mo` : '—' }}
                </td>
                <td class="agent-td-muted">{{ fmtDate(a.hiredAt) }}</td>
                <td>
                  <div class="agent-td-tags">
                    <span v-for="tag in skillTags(a)" :key="tag" class="tag">{{ tag }}</span>
                    <span v-if="!skillTags(a).length" class="tag">no skills</span>
                    <span v-if="mcpSummary(a)" class="tag mcp-tag">{{ mcpSummary(a) }}</span>
                  </div>
                </td>
                <td>{{ tokenLabel(a.openclawAgentId, a.role) }}</td>
                <td class="agent-td-actions">
                  <div class="agent-td-actions-inner">
                    <NDropdown
                      trigger="click"
                      :options="userMenuOptions(a)"
                      @select="(key) => onUserMenu(String(key), a)"
                    >
                      <button type="button" class="btn ghost sm agent-actions-btn">Actions ▾</button>
                    </NDropdown>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <template v-else>
        <article v-for="b in builtins" :key="b.id" class="npc-market-card npc-market-card-builtin">
          <div class="npc-market-preview">
            <span class="npc-market-skin-pill">
              <span class="npc-market-skin-dot" aria-hidden="true" />
              {{ builtinSkinMeta(b).name }}
            </span>
            <span class="tag built agent-mine-badge">Built-in</span>
            <div class="npc-market-stage">
              <canvas
                :width="SKIN_CANVAS_SIZE"
                :height="SKIN_CANVAS_SIZE"
                :data-palette="builtinSkinMeta(b).palette"
                :data-hue="builtinSkinMeta(b).hueShift"
                :aria-label="b.label"
              />
            </div>
          </div>
          <div class="npc-market-body">
            <h3 class="npc-market-name">{{ b.label }}</h3>
            <div class="npc-market-tagline">
              <span class="npc-market-tagline-icon">◆</span>
              {{ b.role }} · {{ b.runtime || 'openclaw' }}
            </div>
            <div class="npc-market-info">
              <ul class="npc-market-features">
                <li>
                  <span class="npc-market-check">✓</span>
                  {{ b.npcState === 'working' ? 'Working' : 'Idle' }}
                </li>
                <li>
                  <span class="npc-market-check">✓</span>
                  Tokens: {{ tokenLabel(b.openclawAgentId, b.role) }}
                </li>
              </ul>
            </div>
            <div class="npc-market-actions agent-mine-actions">
              <NDropdown
                trigger="click"
                :options="builtinMenuOptions()"
                @select="(key) => onBuiltinMenu(String(key), b)"
              >
                <button type="button" class="btn ghost npc-market-details">Actions ▾</button>
              </NDropdown>
            </div>
            <div class="npc-market-footer">
              <span class="npc-market-trust">
                Tokens: <strong>{{ tokenLabel(b.openclawAgentId, b.role) }}</strong>
              </span>
              <span class="agent-mine-status">
                <span class="pill" :class="{ ok: b.npcState === 'working' }">
                  {{ b.npcState === 'working' ? 'Working' : 'Idle' }}
                </span>
              </span>
            </div>
          </div>
        </article>

        <article v-for="a in agents" :key="a.id" class="npc-market-card">
          <div class="npc-market-preview">
            <span class="npc-market-skin-pill">
              <span class="npc-market-skin-dot" aria-hidden="true" />
              {{ agentSkinMeta(a).name }}
            </span>
            <div class="npc-market-stage">
              <canvas
                :width="SKIN_CANVAS_SIZE"
                :height="SKIN_CANVAS_SIZE"
                :data-palette="agentSkinMeta(a).palette"
                :data-hue="agentSkinMeta(a).hueShift"
                :data-agent-preview="a.id"
                :aria-label="a.name"
              />
            </div>
          </div>
          <div class="npc-market-body">
            <h3 class="npc-market-name">{{ a.name }}</h3>
            <div class="npc-market-tagline">
              <span class="npc-market-tagline-icon">◆</span>
              {{ a.role }} · {{ a.runtime }}
            </div>
            <AgentUsageBars v-if="a.templateId" :agent-id="a.id" />
            <div class="npc-market-info">
              <div v-if="a.salaryCreditsPerMonth" class="npc-market-price">
                <div class="npc-market-price-icon">◎</div>
                <div class="npc-market-price-text">
                  <strong>{{ a.salaryCreditsPerMonth }}</strong>
                  <span>credits / month</span>
                </div>
              </div>
              <ul class="npc-market-features">
                <li v-for="tag in skillTags(a)" :key="tag">
                  <span class="npc-market-check">✓</span>{{ tag }}
                </li>
                <li v-if="!skillTags(a).length">
                  <span class="npc-market-check">✓</span>No skills linked
                </li>
                <li v-if="mcpSummary(a)">
                  <span class="npc-market-check">✓</span>MCP: {{ mcpSummary(a) }}
                </li>
                <li v-if="a.hiredAt">
                  <span class="npc-market-check">✓</span>Hired {{ fmtDate(a.hiredAt) }}
                </li>
              </ul>
            </div>
            <div class="npc-market-actions agent-mine-actions">
              <NDropdown
                trigger="click"
                :options="userMenuOptions(a)"
                @select="(key) => onUserMenu(String(key), a)"
              >
                <button type="button" class="btn ghost npc-market-details">Actions ▾</button>
              </NDropdown>
            </div>
            <div class="npc-market-footer">
              <span class="npc-market-trust">
                Tokens: <strong>{{ tokenLabel(a.openclawAgentId, a.role) }}</strong>
              </span>
              <span class="agent-mine-status">
                <span class="pill" :class="{ ok: isWorking(a) }">
                  {{ isWorking(a) ? 'Working' : 'Idle' }}
                </span>
                <span v-if="a.payrollStatus === 'suspended'" class="tag warn">Suspended</span>
                <span v-if="a.payrollStatus === 'pending_termination'" class="tag warn">
                  Leaving {{ fmtDate(a.fireAt) }}
                </span>
              </span>
            </div>
          </div>
        </article>
      </template>
      </div>
    </div>

    <div v-if="agentTab === 'browse'" class="skilltab">
      <div class="tab-toolbar">
        <p class="hint">
          Browse NPC templates to hire. Salary is deducted from your credit balance — first month on hire, then each month on the hire date.
        </p>
      </div>
      <AgentBrowsePage embedded @hired="onHired" />
    </div>

    <div v-if="agentTab === 'hierarchy'" class="skilltab">
      <OfficeOrgChart :snapshot="officeSnapshot" :user-agents="agents" />
    </div>

    <NModal
      v-model:show="reviewModalOpen"
      preset="card"
      :title="`Review — ${reviewModalAgent?.name || ''}`"
      style="max-width: 420px"
    >
      <p class="hint">Rate this agent 1–5 stars. Your review helps Browse stats for this NPC template.</p>
      <div class="review-stars" role="group" aria-label="Star rating">
        <button
          v-for="n in 5"
          :key="n"
          type="button"
          class="review-star-btn"
          :class="{ active: n <= reviewStars }"
          :aria-label="`${n} star${n === 1 ? '' : 's'}`"
          @click="reviewStars = n"
        >
          ★
        </button>
      </div>
      <p v-if="reviewError" class="modal-error">{{ reviewError }}</p>
      <template #footer>
        <NButton @click="reviewModalOpen = false">Cancel</NButton>
        <NButton type="primary" :loading="reviewBusy" :disabled="reviewStars < 1" @click="saveReview">
          Save review
        </NButton>
      </template>
    </NModal>

    <NModal
      v-model:show="renameModalOpen"
      preset="card"
      title="Rename agent"
      style="max-width: 420px"
    >
      <p class="hint">Display name shown in My Agents and the office.</p>
      <NInput
        v-model:value="renameName"
        placeholder="Agent name"
        maxlength="80"
        @keyup.enter="saveRename"
      />
      <p v-if="renameError" class="modal-error">{{ renameError }}</p>
      <template #footer>
        <NButton @click="renameModalOpen = false">Cancel</NButton>
        <NButton
          type="primary"
          :loading="renameBusy"
          :disabled="!renameName.trim()"
          @click="saveRename"
        >
          Save
        </NButton>
      </template>
    </NModal>

    <NModal
      v-model:show="mcpModalOpen"
      preset="card"
      :title="`MCP accounts — ${mcpModalAgent?.name || ''}`"
      style="max-width: 560px"
    >
      <p class="hint">
        Link MCP servers and choose which accounts this agent may use. Multi-line boss tasks rotate accounts;
        prefix a line with <code>@AccountLabel:</code> to pick a specific account.
      </p>
      <p v-if="!mcps.length" class="hint">No MCP servers yet. Add them under Skills → MCP.</p>
      <div v-for="m in mcps" :key="m.id" class="mcp-bind-block">
        <label class="check-row mcp-bind-head">
          <input type="checkbox" :checked="isMcpLinked(m.id)" @change="toggleAgentMcp(m.id)" />
          <span>{{ m.name }}</span>
        </label>
        <div v-if="isMcpLinked(m.id)" class="mcp-account-list">
          <p v-if="!(m.accounts || []).length" class="hint sm">
            No accounts on this MCP — add one under Skills → MCP → Login.
          </p>
          <label
            v-for="acc in m.accounts || []"
            :key="acc.id"
            class="check-row"
          >
            <input
              type="checkbox"
              :checked="mcpBindingFor(m.id)?.accountIds.includes(acc.id)"
              @change="toggleAgentMcpAccount(m.id, acc.id)"
            />
            <span>{{ acc.label }}</span>
            <span class="tag" :class="{ ok: acc.authConnected !== false }">
              {{ acc.authConnected === false ? 'Needs login' : 'Ready' }}
            </span>
          </label>
          <p v-if="(m.accounts || []).length" class="hint sm">
            Leave all unchecked to use every connected account (default).
          </p>
        </div>
      </div>
      <p v-if="mcpModalError" class="modal-error">{{ mcpModalError }}</p>
      <template #footer>
        <NButton @click="mcpModalOpen = false">Cancel</NButton>
        <NButton type="primary" :loading="mcpModalBusy" @click="saveMcpBindings">Save</NButton>
      </template>
    </NModal>

    <NModal v-model:show="entitlementModalOpen" preset="card" title="Cross-worker binding" style="max-width: 520px">
      <p class="hint">Some bindings are outside this agent&apos;s home worker scope — OT credits apply per task.</p>
      <ul class="entitlement-list">
        <li v-for="w in entitlementWarnings" :key="w.item">{{ w.item }} → OT</li>
      </ul>
      <AgentHireCompareCard
        :ot-per-task="entitlementCompare.otPerTask"
        :monthly-salary="entitlementCompare.monthlySalary"
        :worker-name="entitlementCompare.workerName"
      />
      <template #footer>
        <NButton type="primary" @click="entitlementModalOpen = false">Got it</NButton>
      </template>
    </NModal>

    <AgentResumeModal
      v-model:show="resumeOpen"
      :agent="resumeAgent"
      :builtin-role="resumeBuiltinRole"
      :palette="resumeSkinMeta().palette"
      :hue-shift="resumeSkinMeta().hueShift"
      :skills="skills"
      :mcps="mcps"
    />
  </div>
</template>

<style scoped>
.agents-page {
  padding-bottom: 24px;
}
.view-head {
  margin-bottom: 4px;
}
.view-title {
  margin: 0;
  font-size: 24px;
}
.agent-td-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.agent-td-name-inner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.tag.built {
  font-size: 11px;
}
.tag.warn {
  border-color: rgba(240, 180, 60, 0.45);
  color: #f0b43c;
}
.btn.sm {
  font-size: 12px;
  padding: 4px 10px;
}
.agent-mine-badge {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 2;
}
.agent-mine-actions {
  justify-content: flex-end;
}
.review-stars {
  display: flex;
  gap: 8px;
  margin: 16px 0 8px;
}
.review-star-btn {
  font-size: 28px;
  line-height: 1;
  padding: 4px 6px;
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.25);
  cursor: pointer;
}
.review-star-btn.active {
  color: #f0b43c;
}
.review-star-btn:hover {
  color: #f5c842;
}
.agent-mine-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  justify-content: flex-end;
}
.mcp-bind-block {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.mcp-bind-head {
  font-weight: 600;
}
.mcp-account-list {
  margin: 8px 0 0 22px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  cursor: pointer;
}
.hint.sm {
  font-size: 12px;
  margin: 4px 0 0;
}
.mcp-tag {
  border-color: rgba(100, 180, 255, 0.35);
}
.modal-error {
  color: #e88080;
  font-size: 13px;
  margin-top: 10px;
}
.tag.ok {
  border-color: rgba(80, 200, 120, 0.4);
  color: #6ecf8a;
}
</style>
