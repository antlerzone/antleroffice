<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AgentBrowsePage from '@/views/antler/AgentBrowsePage.vue'
import OfficeOrgChart from '@/components/antler/OfficeOrgChart.vue'
import AgentResumeModal from '@/components/antler/AgentResumeModal.vue'
import AgentUsageBars from '@/components/antler/AgentUsageBars.vue'
import AgentHireCompareCard from '@/components/antler/AgentHireCompareCard.vue'
import { NDropdown, NModal, NButton, NInput, NCheckbox, NSpace, NSelect, useMessage, useDialog, type DropdownOption } from 'naive-ui'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useWebSocketStore } from '@/stores/websocket'
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
import {
  BILLING_INTERVALS,
  creditsPerPeriod,
  firstChargeLabel,
  intervalChargeAdjustment,
  intervalLabel,
  intervalTabLabel,
  isPaygo,
  listCreditsPerPeriod,
  normalizeBillingInterval,
  paygoRateLabel,
  type BillingInterval,
} from '@/lib/billing-interval'

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
  billingInterval?: BillingInterval | string | null
  billingCreditsByInterval?: Partial<Record<BillingInterval, number>> | null
  autoRenew?: boolean
  hiredAt?: number | null
  nextSalaryDueAt?: number | null
  payrollStatus?: string | null
  fireAt?: number | null
  templateId?: string | null
  devEngine?: string | null
  devScope?: { canWrite?: boolean; canReview?: boolean } | null
}

interface CatalogTemplate {
  id: string
  departmentId?: string
  bundleTemplateId?: string | null
  templateId?: string
  salaryCreditsPerMonth?: number
  billingCreditsByInterval?: Partial<Record<BillingInterval, number>>
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
const wsStore = useWebSocketStore()
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
const catalogTemplates = ref<CatalogTemplate[]>([])
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
const scopeModalOpen = ref(false)
const scopeModalAgent = ref<UserAgent | null>(null)
const scopeCanWrite = ref(true)
const scopeCanReview = ref(true)
const scopeBusy = ref(false)
const scopeError = ref('')
const modelModalOpen = ref(false)
const modelModalAgent = ref<UserAgent | null>(null)
const modelRefInput = ref('')
const modelBusy = ref(false)
const modelError = ref('')
const modelOptions = ref<{ label: string; value: string }[]>([])
const resumeOpen = ref(false)
const resumeAgent = ref<UserAgent | null>(null)
const resumeBuiltinRole = ref<string | null>(null)
const hireBackOpen = ref(false)
const hireBackAgent = ref<UserAgent | null>(null)
const hireBackInterval = ref<BillingInterval>('yearly')
const hireBackBusy = ref(false)
const hireBackError = ref('')
const changeContractOpen = ref(false)
const changeContractAgent = ref<UserAgent | null>(null)
const changeContractInterval = ref<BillingInterval>('yearly')
const changeContractBusy = ref(false)
const changeContractError = ref('')
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

function agentDisplayName(agent: UserAgent) {
  if (agent.role === 'secretary') return 'COO'
  return agent.name
}

function agentDisplayRole(agent: UserAgent) {
  if (agent.role === 'secretary') return 'coo'
  return agent.role
}

function tokenLabel(openclawAgentId?: string | null, role?: string) {
  if (!connected.value) return '—'
  const stats = lookupTokens(openclawAgentId, role)
  if (!stats) return '—'
  return formatTokenCount(stats.total)
}

async function loadAll() {
  const [agentsRes, snapRes, skinsRes, skillsRes, mcpsRes, catalogRes] = await Promise.all([
    api.get<{ agents?: UserAgent[] }>('/api/config/agents'),
    api.get<{ agents?: BuiltinNpc[] }>('/api/office/snapshot'),
    api.get<{ skins?: Skin[] }>('/api/config/skins'),
    api.get<{ skills?: Skill[] }>('/api/config/skills'),
    api.get<{ mcps?: McpServer[] }>('/api/config/mcps'),
    api.get<{ templates?: CatalogTemplate[] }>('/api/config/agents/catalog'),
  ])
  agents.value = agentsRes.agents || []
  catalogTemplates.value = catalogRes.templates || []
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

function catalogForAgent(agent: UserAgent) {
  const keys = [agent.templateId, agent.id].filter(Boolean) as string[]
  return catalogTemplates.value.find((t) =>
    keys.some((k) => k === t.id || k === t.departmentId || k === t.bundleTemplateId || k === t.templateId),
  ) || null
}

function billingOverridesForAgent(agent: UserAgent | null) {
  if (!agent) return null
  return agent.billingCreditsByInterval || catalogForAgent(agent)?.billingCreditsByInterval || null
}

function agentSalaryLabel(agent: UserAgent) {
  if (!agent.salaryCreditsPerMonth) return '—'
  const bill = normalizeBillingInterval(agent.billingInterval || 'monthly')
  const overrides = billingOverridesForAgent(agent)
  const amount = creditsPerPeriod(agent.salaryCreditsPerMonth, bill, overrides)
  return `${amount} / ${intervalLabel(bill)}`
}

function contractEndLabel(agent: UserAgent) {
  const end = agent.nextSalaryDueAt || agent.fireAt
  return end ? fmtDate(end) : '—'
}

function confirmFire(agent: UserAgent) {
  const hasPayroll =
    agent.salaryCreditsPerMonth &&
    agent.salaryCreditsPerMonth > 0 &&
    typeof agent.nextSalaryDueAt === 'number'
  const contractEnd = agent.nextSalaryDueAt || agent.fireAt
  const endLabel = contractEnd ? fmtDate(contractEnd) : null
  const msg = hasPayroll && endLabel
    ? `Resign "${agent.name}"?\n\nThey will keep working until the end of the current contract (${endLabel}), then leave.\n\nNo refund. Auto-renew will be turned off.`
    : `Remove "${agent.name}" now?\n\nThey will leave immediately.`
  dialog.warning({
    title: 'End contract',
    content: msg,
    positiveText: hasPayroll && endLabel ? 'Resign at contract end' : 'Remove now',
    negativeText: 'Cancel',
    onPositiveClick: async () => {
      try {
        const r = await api.send<{ ok?: boolean; error?: string; immediate?: boolean; fireAt?: number }>(
          'POST',
          `/api/config/agents/${agent.id}/fire`,
        )
        if (r.ok === false) throw new Error(r.error || 'Could not resign')
        message.success(
          r.immediate
            ? `${agent.name} has left`
            : `${agent.name} will leave at end of contract (${endLabel})`,
        )
        await refresh()
      } catch (e) {
        message.error(e instanceof Error ? e.message : 'Could not resign agent')
      }
    },
  })
}

function openHireBack(agent: UserAgent) {
  hireBackAgent.value = agent
  hireBackInterval.value = normalizeBillingInterval(agent.billingInterval || 'yearly')
  hireBackError.value = ''
  hireBackOpen.value = true
}

const hireBackOverrides = computed(() => billingOverridesForAgent(hireBackAgent.value))

const hireBackRenewCredits = computed(() => {
  const a = hireBackAgent.value
  if (!a?.salaryCreditsPerMonth) return 0
  return creditsPerPeriod(a.salaryCreditsPerMonth, hireBackInterval.value, hireBackOverrides.value)
})

const hireBackRenewLabel = computed(() => firstChargeLabel(hireBackInterval.value))

const hireBackRenewAdjustment = computed(() => {
  const a = hireBackAgent.value
  if (!a?.salaryCreditsPerMonth) return null
  return intervalChargeAdjustment(hireBackInterval.value, a.salaryCreditsPerMonth, hireBackOverrides.value)
})

const hireBackShowListPrice = computed(() => {
  const a = hireBackAgent.value
  if (!a?.salaryCreditsPerMonth) return false
  const list = listCreditsPerPeriod(a.salaryCreditsPerMonth, hireBackInterval.value, hireBackOverrides.value)
  return list !== hireBackRenewCredits.value
})

const hireBackListCredits = computed(() => {
  const a = hireBackAgent.value
  if (!a?.salaryCreditsPerMonth) return 0
  return listCreditsPerPeriod(a.salaryCreditsPerMonth, hireBackInterval.value, hireBackOverrides.value)
})

async function confirmHireBack() {
  const agent = hireBackAgent.value
  if (!agent) return
  hireBackBusy.value = true
  hireBackError.value = ''
  try {
    const r = await api.send<{ ok?: boolean; error?: string }>(
      'POST',
      `/api/config/agents/${agent.id}/hire-back`,
      { billingInterval: hireBackInterval.value },
    )
    if (r.ok === false) throw new Error(r.error || 'Could not hire back')
    hireBackOpen.value = false
    message.success(`${agent.name} is back on your team — auto-renew resumed`)
    await refresh()
  } catch (e) {
    hireBackError.value = e instanceof Error ? e.message : 'Could not hire back'
  } finally {
    hireBackBusy.value = false
  }
}

function openChangeContract(agent: UserAgent) {
  changeContractAgent.value = agent
  changeContractInterval.value = normalizeBillingInterval(agent.billingInterval || 'yearly')
  changeContractError.value = ''
  changeContractOpen.value = true
}

const changeContractOverrides = computed(() => billingOverridesForAgent(changeContractAgent.value))

const changeContractRenewCredits = computed(() => {
  const a = changeContractAgent.value
  if (!a?.salaryCreditsPerMonth) return 0
  return creditsPerPeriod(a.salaryCreditsPerMonth, changeContractInterval.value, changeContractOverrides.value)
})

const changeContractRenewLabel = computed(() => firstChargeLabel(changeContractInterval.value))

const changeContractRenewAdjustment = computed(() => {
  const a = changeContractAgent.value
  if (!a?.salaryCreditsPerMonth) return null
  return intervalChargeAdjustment(
    changeContractInterval.value,
    a.salaryCreditsPerMonth,
    changeContractOverrides.value,
  )
})

const changeContractShowListPrice = computed(() => {
  const a = changeContractAgent.value
  if (!a?.salaryCreditsPerMonth) return false
  const list = listCreditsPerPeriod(
    a.salaryCreditsPerMonth,
    changeContractInterval.value,
    changeContractOverrides.value,
  )
  return list !== changeContractRenewCredits.value
})

const changeContractListCredits = computed(() => {
  const a = changeContractAgent.value
  if (!a?.salaryCreditsPerMonth) return 0
  return listCreditsPerPeriod(
    a.salaryCreditsPerMonth,
    changeContractInterval.value,
    changeContractOverrides.value,
  )
})

const changeContractUnchanged = computed(() => {
  const a = changeContractAgent.value
  if (!a) return true
  return normalizeBillingInterval(a.billingInterval || 'monthly') === changeContractInterval.value
})

async function confirmChangeContract() {
  const agent = changeContractAgent.value
  if (!agent || changeContractUnchanged.value) return
  changeContractBusy.value = true
  changeContractError.value = ''
  try {
    const r = await api.send<{ ok?: boolean; error?: string }>(
      'POST',
      `/api/config/agents/${agent.id}/contract`,
      { billingInterval: changeContractInterval.value },
    )
    if (r.ok === false) throw new Error(r.error || 'Could not update contract')
    changeContractOpen.value = false
    message.success(
      `${agent.name} contract updated — renews as ${intervalTabLabel(changeContractInterval.value)} on ${contractEndLabel(agent)}`,
    )
    await refresh()
  } catch (e) {
    changeContractError.value = e instanceof Error ? e.message : 'Could not update contract'
  } finally {
    changeContractBusy.value = false
  }
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
      entitlementWarnings.value = res.entitlementWarnings as typeof entitlementWarnings.value
      entitlementCompare.value = {
        otPerTask: w?.otCreditsPerTask ?? 15,
        monthlySalary: hit?.salaryCreditsPerMonth ?? 199,
        workerName: w?.otWorkerId || 'specialist',
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

function isDevAgent(agent: UserAgent) {
  const devTemplates = new Set(['cursor_developer', 'claude_developer', 'codex_developer', 'it_guys'])
  return !!agent.devEngine || (agent.templateId ? devTemplates.has(agent.templateId) : false) || agent.role === 'it'
}

function isCooAgent(agent: UserAgent) {
  return agent.role === 'coo' || agent.role === 'ceo'
}

function userMenuOptions(agent: UserAgent): DropdownOption[] {
  const opts: DropdownOption[] = [
    { label: 'View overview', key: 'view' },
    { label: 'Set model', key: 'model', disabled: !agent.openclawAgentId },
    { label: 'Rename', key: 'rename' },
    { label: 'Edit soul', key: 'soul' },
    { label: 'Apply skin', key: 'skin' },
    { label: 'Review', key: 'review' },
    { label: 'MCP accounts', key: 'mcps' },
  ]
  if (isDevAgent(agent)) {
    opts.splice(2, 0, { label: 'Job scope', key: 'scope' })
  }
  if (agent.salaryCreditsPerMonth && agent.salaryCreditsPerMonth > 0 && !isCooAgent(agent)) {
    opts.push({ label: 'Change contract', key: 'change-contract' })
  }
  if (agent.payrollStatus === 'pending_termination') {
    opts.push({ label: 'Hire back', key: 'hire-back' })
  } else {
    opts.push({ label: 'Resign', key: 'fire' })
  }
  return opts
}

async function loadModelOptions() {
  try {
    const r = await api.get<{ models?: { id?: string; ref?: string; model?: string; provider?: string }[] }>(
      '/api/openclaw/models?all=1',
    )
    const opts: { label: string; value: string }[] = []
    for (const m of r.models || []) {
      const ref = m.ref || m.id || (m.provider && m.model ? `${m.provider}/${m.model}` : m.model)
      if (!ref) continue
      opts.push({ label: ref, value: ref })
    }
    modelOptions.value = opts
  } catch {
    modelOptions.value = []
  }
}

async function openModel(agent: UserAgent) {
  if (!agent.openclawAgentId) {
    message.warning('This agent has no OpenClaw id (demo runtime).')
    return
  }
  modelModalAgent.value = agent
  modelRefInput.value = ''
  modelError.value = ''
  modelModalOpen.value = true
  if (!modelOptions.value.length) await loadModelOptions()
  try {
    const overview = await api.get<{ modelRef?: string }>(`/api/config/agents/${agent.id}/overview`)
    modelRefInput.value = overview.modelRef || ''
  } catch {
    /* optional */
  }
}

async function saveModel() {
  if (!modelModalAgent.value) return
  modelBusy.value = true
  modelError.value = ''
  try {
    await api.send('PUT', `/api/config/agents/${modelModalAgent.value.id}/model`, {
      modelRef: modelRefInput.value.trim(),
    })
    message.success('Model updated')
    modelModalOpen.value = false
  } catch (e) {
    modelError.value = e instanceof Error ? e.message : 'Could not set model'
  } finally {
    modelBusy.value = false
  }
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
  renameBuiltinId.value = null
  renameModalAgent.value = agent
  renameName.value = agent.name
  renameError.value = ''
  renameModalOpen.value = true
}

// ---- Apply skin（弹窗里选皮肤后 Save）----
const skinModalOpen = ref(false)
const skinModalAgent = ref<UserAgent | null>(null)
const skinSelectedId = ref('')
const skinBusy = ref(false)
const skinError = ref('')

function openSkinApply(agent: UserAgent) {
  skinModalAgent.value = agent
  skinSelectedId.value = skinIdForAgent(agent) || skins.value[0]?.id || ''
  skinError.value = ''
  skinModalOpen.value = true
}

// ---- Edit soul（每个 agent 的人格/SOUL，可自定义 + 还原默认）----
const SOUL_FILE = 'SOUL.md'
const SOUL_DEFAULT_FILE = 'SOUL.default.md'
const soulModalOpen = ref(false)
const soulAgentName = ref('')
const soulAgentRpcId = ref('')
const soulContent = ref('')
const soulDefault = ref('')
const soulLoading = ref(false)
const soulBusy = ref(false)
const soulError = ref('')

const soulIsCustomized = computed(
  () => soulContent.value.trim() !== soulDefault.value.trim(),
)

function builtinSoulId(npc: BuiltinNpc) {
  if (npc.role === 'secretary') return 'main'
  return npc.openclawAgentId || 'main'
}

async function openSoulEditor(name: string, rpcId: string | null | undefined) {
  if (!rpcId) {
    message.warning('This agent has no OpenClaw runtime yet (demo).')
    return
  }
  soulAgentName.value = name
  soulAgentRpcId.value = rpcId
  soulContent.value = ''
  soulDefault.value = ''
  soulError.value = ''
  soulModalOpen.value = true
  soulLoading.value = true
  try {
    const cur = await wsStore.rpc.getAgentFile(rpcId, SOUL_FILE)
    soulContent.value = cur.file.content || ''
    // 取已保存的默认快照；没有就把当前内容当默认存一份（首次）
    let def = ''
    try {
      const d = await wsStore.rpc.getAgentFile(rpcId, SOUL_DEFAULT_FILE)
      def = d.file.missing ? '' : d.file.content || ''
    } catch {
      def = ''
    }
    if (!def && soulContent.value.trim()) {
      def = soulContent.value
      try {
        await wsStore.rpc.setAgentFile(rpcId, SOUL_DEFAULT_FILE, def)
      } catch {
        /* 快照失败不阻断编辑 */
      }
    }
    soulDefault.value = def
  } catch (e) {
    soulError.value = e instanceof Error ? e.message : 'Could not load soul'
  } finally {
    soulLoading.value = false
  }
}

async function saveSoul() {
  if (!soulAgentRpcId.value) return
  soulBusy.value = true
  soulError.value = ''
  try {
    await wsStore.rpc.setAgentFile(soulAgentRpcId.value, SOUL_FILE, soulContent.value)
    message.success('Soul saved')
    soulModalOpen.value = false
    void refresh()
  } catch (e) {
    soulError.value = e instanceof Error ? e.message : 'Could not save soul'
  } finally {
    soulBusy.value = false
  }
}

function resetSoulToDefault() {
  if (!soulDefault.value) {
    message.info('No default snapshot for this agent yet.')
    return
  }
  soulContent.value = soulDefault.value
  message.info('Default restored — click Save to apply.')
}

async function saveSkinApply() {
  if (!skinModalAgent.value) return
  const skin = skins.value.find((s) => s.id === skinSelectedId.value)
  if (!skin) {
    skinError.value = 'Pick a skin first.'
    return
  }
  skinBusy.value = true
  skinError.value = ''
  try {
    const payload = { sprite: skin.palette, hueShift: skin.hueShift || 0 }
    const r = await api.send<{ agent?: UserAgent }>(
      'PUT',
      `/api/config/agents/${skinModalAgent.value.id}`,
      payload,
    )
    const hit = agents.value.find((a) => a.id === skinModalAgent.value!.id)
    if (hit) {
      hit.sprite = r.agent?.sprite ?? skin.palette
      hit.hueShift = r.agent?.hueShift ?? (skin.hueShift || 0)
    }
    message.success('Skin applied')
    skinModalOpen.value = false
    void mountPreviews()
  } catch (e) {
    skinError.value = e instanceof Error ? e.message : 'Could not apply skin'
  } finally {
    skinBusy.value = false
  }
}

function openScope(agent: UserAgent) {
  scopeModalAgent.value = agent
  scopeCanWrite.value = agent.devScope?.canWrite !== false
  scopeCanReview.value = agent.devScope?.canReview !== false
  scopeError.value = ''
  scopeModalOpen.value = true
}

async function saveScope() {
  if (!scopeModalAgent.value) return
  scopeBusy.value = true
  scopeError.value = ''
  try {
    const r = await api.send<{ agent?: UserAgent }>('PUT', `/api/config/agents/${scopeModalAgent.value.id}`, {
      devScope: { canWrite: scopeCanWrite.value, canReview: scopeCanReview.value },
    })
    const hit = agents.value.find((a) => a.id === scopeModalAgent.value!.id)
    if (hit && r.agent?.devScope) hit.devScope = r.agent.devScope
    message.success('Job scope updated')
    scopeModalOpen.value = false
  } catch (e) {
    scopeError.value = e instanceof Error ? e.message : 'Could not save job scope'
  } finally {
    scopeBusy.value = false
  }
}

async function saveRename() {
  const trimmed = renameName.value.trim()
  if (!trimmed) {
    renameError.value = 'Enter a name.'
    return
  }
  // 内置 COO 改名：走 voice2 的专用接口（同时改语音助手名字）
  if (renameBuiltinId.value) {
    renameBusy.value = true
    renameError.value = ''
    try {
      await api.send('POST', '/api/voice2/coo-name', { name: trimmed })
      const b = builtins.value.find((n) => n.id === renameBuiltinId.value)
      if (b) b.label = trimmed
      message.success('Renamed')
      renameModalOpen.value = false
      renameBuiltinId.value = null
    } catch (e) {
      renameError.value = e instanceof Error ? e.message : 'Could not rename'
    } finally {
      renameBusy.value = false
    }
    return
  }
  if (!renameModalAgent.value) return
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

function builtinMenuOptions(npc?: BuiltinNpc): DropdownOption[] {
  const opts: DropdownOption[] = [{ label: 'View overview', key: 'view' }]
  // 内置 NPC 也能编辑 soul（人格）
  opts.push({ label: 'Edit soul', key: 'soul' })
  // 内置 COO 可以改名（也就是语音助手 Jarvis 的名字）
  if (npc && (npc.role === 'coo' || npc.role === 'ceo')) {
    opts.unshift({ label: 'Rename', key: 'rename' })
  }
  return opts
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
  else if (key === 'rename') openRenameBuiltin(npc)
  else if (key === 'soul') void openSoulEditor(npc.label, builtinSoulId(npc))
}

const renameBuiltinId = ref<string | null>(null)
function openRenameBuiltin(npc: BuiltinNpc) {
  renameModalAgent.value = null
  renameBuiltinId.value = npc.id || 'coo'
  renameName.value = npc.label
  renameError.value = ''
  renameModalOpen.value = true
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
  else if (key === 'hire-back') openHireBack(agent)
  else if (key === 'change-contract') openChangeContract(agent)
  else if (key === 'view') openOverview(agent)
  else if (key === 'model') void openModel(agent)
  else if (key === 'rename') openRename(agent)
  else if (key === 'soul') void openSoulEditor(agentDisplayName(agent), agent.openclawAgentId)
  else if (key === 'scope') openScope(agent)
  else if (key === 'skin') openSkinApply(agent)
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
          Your hired NPC employees, including your COO. Salary auto-renews each billing period until you resign at contract end.
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
                <th>Contract end</th>
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
                      :options="builtinMenuOptions(b)"
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
                    <strong>{{ agentDisplayName(a) }}</strong>
                    <span class="pill" :class="{ ok: isWorking(a) }">{{ isWorking(a) ? 'Working' : 'Idle' }}</span>
                    <span v-if="a.payrollStatus === 'suspended'" class="tag warn">Suspended</span>
                    <span v-if="a.payrollStatus === 'pending_termination'" class="tag warn">
                      Leaving {{ fmtDate(a.fireAt) }}
                    </span>
                  </div>
                </td>
                <td>{{ agentDisplayRole(a) }}</td>
                <td>{{ a.runtime }}</td>
                <td class="agent-td-muted">{{ agentSalaryLabel(a) }}</td>
                <td class="agent-td-muted">{{ contractEndLabel(a) }}</td>
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
                :options="builtinMenuOptions(b)"
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
            <h3 class="npc-market-name">{{ agentDisplayName(a) }}</h3>
            <div class="npc-market-tagline">
              <span class="npc-market-tagline-icon">◆</span>
              {{ a.role }} · {{ a.runtime }}
            </div>
            <AgentUsageBars v-if="a.templateId" :agent-id="a.id" />
            <div class="npc-market-info">
              <div v-if="a.salaryCreditsPerMonth" class="npc-market-price">
                <div class="npc-market-price-icon">◎</div>
                <div class="npc-market-price-text">
                  <strong>{{ agentSalaryLabel(a) }}</strong>
                  <span>credits · ends {{ contractEndLabel(a) }}</span>
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
                  <span class="npc-market-check">✓</span>{{ agentSalaryLabel(a) }} · ends {{ contractEndLabel(a) }}
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
          Browse NPC templates to hire. First period charged on hire; credits auto-renew until you resign on My Agents.
        </p>
      </div>
      <AgentBrowsePage embedded @hired="onHired" />
    </div>

    <div v-if="agentTab === 'hierarchy'" class="skilltab">
      <div class="tab-toolbar">
        <p class="hint">
          You (CEO) → COO (hire from Browse) → department workers.
        </p>
      </div>
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
      v-model:show="soulModalOpen"
      preset="card"
      :title="soulAgentName ? `Edit soul — ${soulAgentName}` : 'Edit soul'"
      style="max-width: 640px"
    >
      <p class="hint">
        This is the agent's personality (SOUL). It comes with a default — edit it to
        customize, or reset to the default any time.
        <span v-if="soulIsCustomized" class="soul-state soul-state--custom">Customized</span>
        <span v-else class="soul-state">Default</span>
      </p>
      <p v-if="soulLoading" class="hint">Loading soul…</p>
      <NInput
        v-else
        v-model:value="soulContent"
        type="textarea"
        :autosize="{ minRows: 10, maxRows: 22 }"
        placeholder="Describe how this agent should think, talk and behave…"
      />
      <p v-if="soulError" class="modal-error">{{ soulError }}</p>
      <template #footer>
        <div class="soul-footer">
          <NButton
            quaternary
            :disabled="soulLoading || soulBusy || !soulDefault"
            @click="resetSoulToDefault"
          >
            Reset to default
          </NButton>
          <div class="soul-footer-right">
            <NButton @click="soulModalOpen = false">Cancel</NButton>
            <NButton
              type="primary"
              :loading="soulBusy"
              :disabled="soulLoading"
              @click="saveSoul"
            >
              Save
            </NButton>
          </div>
        </div>
      </template>
    </NModal>

    <NModal
      v-model:show="skinModalOpen"
      preset="card"
      :title="skinModalAgent ? `Apply skin — ${skinModalAgent.name}` : 'Apply skin'"
      style="max-width: 460px"
    >
      <p class="hint">Pick a character skin (default or purchased), then Save.</p>
      <div class="skin-pick-grid">
        <button
          v-for="s in skins"
          :key="s.id"
          type="button"
          class="skin-pick-chip"
          :class="{ active: skinSelectedId === s.id }"
          @click="skinSelectedId = s.id"
        >
          <span class="skin-pick-name">{{ s.name }}</span>
        </button>
        <p v-if="!skins.length" class="hint">No skins available yet.</p>
      </div>
      <p v-if="skinError" class="modal-error">{{ skinError }}</p>
      <template #footer>
        <NButton @click="skinModalOpen = false">Cancel</NButton>
        <NButton
          type="primary"
          :loading="skinBusy"
          :disabled="!skinSelectedId || !skins.length"
          @click="saveSkinApply"
        >
          Save
        </NButton>
      </template>
    </NModal>

    <NModal
      v-model:show="modelModalOpen"
      preset="card"
      :title="modelModalAgent ? `Set model — ${modelModalAgent.name}` : 'Set model'"
      style="max-width: 480px"
    >
      <p class="hint">OpenClaw model ref for this worker (e.g. openai/gpt-4o-mini).</p>
      <NSelect
        v-model:value="modelRefInput"
        filterable
        tag
        :options="modelOptions"
        placeholder="provider/model"
        style="width: 100%; margin-top: 8px"
      />
      <p v-if="modelError" class="modal-error">{{ modelError }}</p>
      <template #footer>
        <NButton @click="modelModalOpen = false">Cancel</NButton>
        <NButton type="primary" :loading="modelBusy" @click="saveModel">Save</NButton>
      </template>
    </NModal>

    <NModal
      v-model:show="scopeModalOpen"
      preset="card"
      :title="`Job scope — ${scopeModalAgent?.name || ''}`"
      style="max-width: 420px"
    >
      <p class="hint">Control whether this developer can write code, review code, or both.</p>
      <NSpace vertical>
        <NCheckbox v-model:checked="scopeCanWrite">Can write code</NCheckbox>
        <NCheckbox v-model:checked="scopeCanReview">Can review code</NCheckbox>
      </NSpace>
      <p v-if="scopeError" class="modal-error">{{ scopeError }}</p>
      <template #footer>
        <NButton @click="scopeModalOpen = false">Cancel</NButton>
        <NButton type="primary" :loading="scopeBusy" @click="saveScope">Save</NButton>
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

    <NModal
      v-model:show="hireBackOpen"
      preset="card"
      :title="hireBackAgent ? `Hire back ${hireBackAgent.name}` : 'Hire back'"
      style="max-width: 520px"
    >
      <template v-if="hireBackAgent">
        <p class="hint">
          Cancel resignation and resume auto-renew. Choose the billing period for future renewals.
        </p>
        <p v-if="hireBackAgent.fireAt" class="hint sm">
          Current contract still ends {{ fmtDate(hireBackAgent.fireAt) }} if you do not hire back.
        </p>
        <div v-if="(hireBackAgent.salaryCreditsPerMonth ?? 0) > 0" class="hire-billing-field">
          <p class="hire-billing-byline">by daily, monthly, quarterly, yearly, or pay as you go</p>
          <div class="hire-billing-tabs">
            <button
              v-for="interval in BILLING_INTERVALS"
              :key="interval"
              type="button"
              class="hire-billing-tab"
              :class="{
                active: hireBackInterval === interval,
                'hire-billing-tab--yearly': interval === 'yearly',
              }"
              @click="hireBackInterval = interval"
            >
              <span v-if="interval === 'yearly'" class="hire-billing-ribbon">Most people choose</span>
              {{ intervalTabLabel(interval) }}
            </button>
          </div>
        </div>
        <dl class="agent-browse-detail-list">
          <div v-if="isPaygo(hireBackInterval)" class="agent-browse-detail-row">
            <dt>Rate</dt>
            <dd><strong>{{ paygoRateLabel() }}</strong></dd>
          </div>
          <div v-else class="agent-browse-detail-row">
            <dt>{{ hireBackRenewLabel }} renewal</dt>
            <dd>
              <span v-if="hireBackShowListPrice" class="hire-price-was">{{ hireBackListCredits }}</span>
              <strong>{{ hireBackRenewCredits }}</strong>
              credits per {{ intervalLabel(hireBackInterval) }}
              <span v-if="hireBackRenewAdjustment" class="hire-price-adjust">{{ hireBackRenewAdjustment }}</span>
            </dd>
          </div>
        </dl>
        <p class="hint sm">No charge today — billing resumes on the next renewal date.</p>
        <p v-if="hireBackError" class="modal-error">{{ hireBackError }}</p>
      </template>
      <template #footer>
        <NButton @click="hireBackOpen = false">Cancel</NButton>
        <NButton type="primary" :loading="hireBackBusy" @click="confirmHireBack">Hire back</NButton>
      </template>
    </NModal>

    <NModal
      v-model:show="changeContractOpen"
      preset="card"
      :title="changeContractAgent ? `Change contract — ${changeContractAgent.name}` : 'Change contract'"
      style="max-width: 520px"
    >
      <template v-if="changeContractAgent">
        <p class="hint">
          Switch billing period for this agent. Takes effect on the next renewal — no charge today.
          You can move from yearly to monthly or any other combination.
        </p>
        <p class="hint sm">
          Next renewal: <strong>{{ contractEndLabel(changeContractAgent) }}</strong>
          <span v-if="changeContractAgent.billingInterval">
            · current: {{ intervalTabLabel(changeContractAgent.billingInterval) }}
          </span>
        </p>
        <div class="hire-billing-field">
          <p class="hire-billing-byline">by daily, monthly, quarterly, yearly, or pay as you go</p>
          <div class="hire-billing-tabs">
            <button
              v-for="interval in BILLING_INTERVALS"
              :key="interval"
              type="button"
              class="hire-billing-tab"
              :class="{
                active: changeContractInterval === interval,
                'hire-billing-tab--yearly': interval === 'yearly',
              }"
              @click="changeContractInterval = interval"
            >
              <span v-if="interval === 'yearly'" class="hire-billing-ribbon">Most people choose</span>
              {{ intervalTabLabel(interval) }}
            </button>
          </div>
        </div>
        <dl class="agent-browse-detail-list">
          <div v-if="isPaygo(changeContractInterval)" class="agent-browse-detail-row">
            <dt>Rate</dt>
            <dd><strong>{{ paygoRateLabel() }}</strong></dd>
          </div>
          <div v-else class="agent-browse-detail-row">
            <dt>{{ changeContractRenewLabel }} renewal</dt>
            <dd>
              <span v-if="changeContractShowListPrice" class="hire-price-was">{{ changeContractListCredits }}</span>
              <strong>{{ changeContractRenewCredits }}</strong>
              credits per {{ intervalLabel(changeContractInterval) }}
              <span v-if="changeContractRenewAdjustment" class="hire-price-adjust">{{ changeContractRenewAdjustment }}</span>
            </dd>
          </div>
        </dl>
        <p v-if="changeContractUnchanged" class="hint sm">Already on this billing period.</p>
        <p v-if="changeContractError" class="modal-error">{{ changeContractError }}</p>
      </template>
      <template #footer>
        <NButton @click="changeContractOpen = false">Cancel</NButton>
        <NButton
          type="primary"
          :loading="changeContractBusy"
          :disabled="changeContractUnchanged"
          @click="confirmChangeContract"
        >
          Save contract
        </NButton>
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
.skin-pick-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0 4px;
}
.skin-pick-chip {
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--antler-border, #d0d0d8);
  background: var(--antler-surface, #fff);
  cursor: pointer;
  font-size: 13px;
}
.skin-pick-chip.active {
  border-color: var(--antler-primary, #6750ff);
  box-shadow: 0 0 0 2px var(--antler-primary, #6750ff) inset;
}
.skin-pick-name {
  white-space: nowrap;
}
.soul-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 8px;
}
.soul-footer-right {
  display: flex;
  gap: 8px;
}
.soul-state {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 12px;
  background: var(--antler-surface-2, #eef0f4);
  color: var(--antler-text-muted, #6b7280);
}
.soul-state--custom {
  background: rgba(103, 80, 255, 0.12);
  color: var(--antler-primary, #6750ff);
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
.hire-billing-field {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 8px 0 0;
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
  padding-top: 8px;
}
.hire-billing-tab {
  position: relative;
  overflow: visible;
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.82);
  font-size: 14px;
  font-family: inherit;
  cursor: pointer;
}
.hire-billing-tab.active {
  background: #5eead4;
  color: #101418;
}
.hire-billing-tab--yearly {
  margin-top: 2px;
}
.hire-billing-ribbon {
  position: absolute;
  top: -10px;
  left: 50%;
  transform: translateX(-50%);
  padding: 3px 8px;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  color: #101418;
  background: linear-gradient(135deg, #ffd76a 0%, #f0b429 100%);
  border-radius: 999px;
  white-space: nowrap;
  pointer-events: none;
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
.agent-browse-detail-list {
  margin: 12px 0 0;
}
.agent-browse-detail-row {
  display: flex;
  gap: 12px;
  margin-bottom: 8px;
  font-size: 14px;
}
.agent-browse-detail-row dt {
  min-width: 110px;
  color: var(--muted);
}
</style>
