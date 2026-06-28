<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { NModal, NButton, NInput, NDropdown, useMessage, useDialog, type DropdownOption } from 'naive-ui'
import { useAntlerApi } from '@/composables/useAntlerApi'

interface Skill {
  id: string
  name: string
  system?: string
  description?: string
  version?: number
  mcpIds?: string[]
}

interface McpAuthPublic {
  apiKeySet?: boolean
  bearerSet?: boolean
  oauthConnected?: boolean
  oauth?: {
    clientId?: string
    scopes?: string
    authorizeUrl?: string
    tokenUrl?: string
    clientSecretSet?: boolean
    accessTokenSet?: boolean
  }
}

interface McpAccount {
  id: string
  label: string
  authType?: 'none' | 'api_key' | 'bearer' | 'oauth'
  authConnected?: boolean
}

interface McpServer {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  description?: string
  authRequired?: boolean
  suggestedAuthType?: 'none' | 'api_key' | 'bearer' | 'oauth'
  authType: 'none' | 'api_key' | 'bearer' | 'oauth'
  authConnected?: boolean
  accountCount?: number
  connectedAccountCount?: number
  lastProbeAt?: number | null
  accounts?: McpAccount[]
  auth?: McpAuthPublic
}

interface McpProbeResult {
  reachable: boolean
  authRequired?: boolean
  suggestedAuthType?: string
  probedUrl?: string
  error?: string
}

interface HubSkill {
  name: string
  description?: string
  source?: string
  eligible?: boolean
}

const SKILL_VIEW_KEY = 'antleroffice.skillView'

const api = useAntlerApi()
const route = useRoute()
const message = useMessage()
const dialog = useDialog()

const tab = ref<'skills' | 'mcps' | 'browse'>('skills')
const viewMode = ref<'grid' | 'list'>(
  localStorage.getItem(SKILL_VIEW_KEY) === 'list' ? 'list' : 'grid',
)
const skills = ref<Skill[]>([])
const mcps = ref<McpServer[]>([])
const hubSkills = ref<HubSkill[]>([])
const hubAvailable = ref(true)
const hubQuery = ref('')
const hubLoaded = ref(false)
const loading = ref(false)

const skillModalOpen = ref(false)
const skillEditing = ref<Skill | null>(null)
const skillForm = ref({ name: '', system: '', description: '', mcpIds: [] as string[] })
const skillBusy = ref(false)
const skillError = ref('')

const mcpModalOpen = ref(false)
const mcpEditing = ref<McpServer | null>(null)
const mcpForm = ref({ name: '', url: '' })
const mcpBusy = ref(false)
const mcpError = ref('')
const mcpProbeBusy = ref(false)
const mcpProbeResult = ref<McpProbeResult | null>(null)

const manageAccountsOpen = ref(false)
const manageTarget = ref<McpServer | null>(null)
const manageAccounts = ref<McpAccount[]>([])

const addAccountOpen = ref(false)
const addAccountTarget = ref<McpServer | null>(null)
const addAccountForm = ref({ label: '', authType: 'oauth' as McpServer['authType'] })
const addAccountBusy = ref(false)
const addAccountError = ref('')

const authAccountId = ref<string | null>(null)

const authModalOpen = ref(false)
const authTarget = ref<McpServer | null>(null)
const authBusy = ref(false)
const authError = ref('')
const oauthPopup = ref<Window | null>(null)
const authForm = ref({
  apiKey: '',
  bearerToken: '',
  clientId: '',
  clientSecret: '',
  accessToken: '',
  scopes: '',
  authorizeUrl: '',
  tokenUrl: '',
})

const detailOpen = ref(false)
const detailName = ref('')
const detailEligible = ref(false)
const detailGuide = ref('')
const detailText = ref('')

const mcpNameMap = computed(() => Object.fromEntries(mcps.value.map((m) => [m.id, m.name])))

function setTab(next: 'skills' | 'mcps' | 'browse') {
  tab.value = next
  if (next === 'browse' && !hubLoaded.value) void searchHub()
}

function setView(mode: 'grid' | 'list') {
  viewMode.value = mode
  localStorage.setItem(SKILL_VIEW_KEY, mode)
}

function authLabel(m: McpServer) {
  if (effectiveAuthType(m) === 'none') return 'No auth'
  if (m.connectedAccountCount && m.connectedAccountCount > 0) return `${m.connectedAccountCount} connected`
  if (m.authConnected) return 'Connected'
  return 'Needs login'
}

function mcpStatusClass(m: McpServer): 'ready' | 'setup' | 'login' {
  const auth = effectiveAuthType(m)
  if (auth === 'none') return 'ready'
  const connected = (m.connectedAccountCount ?? 0) > 0 || !!m.authConnected
  if (connected) return 'ready'
  // Reaching here means auth is already not 'none' (guarded above), so this
  // server always needs a login/connection. (The old `auth !== 'none'` check
  // was always true — TS flagged it as a no-op comparison.)
  return 'login'
}

function mcpStatusText(m: McpServer) {
  const cls = mcpStatusClass(m)
  if (cls === 'ready') return 'Ready'
  if (cls === 'login') return 'Needs login'
  return 'Needs setup'
}

function mcpMenuOptions(m: McpServer): DropdownOption[] {
  const opts: DropdownOption[] = [
    { label: 'Edit', key: 'edit' },
    { label: 'Add account', key: 'add-account' },
    { label: 'Manage accounts', key: 'manage-accounts' },
  ]
  if (effectiveAuthType(m) !== 'none') {
    opts.push({ label: 'Login (default account)', key: 'login' })
  }
  opts.push({ label: 'Remove', key: 'remove' })
  return opts
}

function onMcpMenu(key: string, m: McpServer) {
  if (key === 'edit') openEditMcp(m)
  else if (key === 'add-account') openAddAccount(m)
  else if (key === 'manage-accounts') void openManageAccounts(m)
  else if (key === 'login') openAuth(m)
  else if (key === 'remove') void removeMcp(m.id)
}

async function probeMcpUrl() {
  const url = mcpForm.value.url.trim()
  if (!url) {
    mcpProbeResult.value = null
    return null
  }
  mcpProbeBusy.value = true
  mcpError.value = ''
  try {
    const r = await api.send<{ ok?: boolean; probe?: McpProbeResult; error?: string }>(
      'POST',
      '/api/config/mcps/probe',
      { url },
    )
    mcpProbeResult.value = r.probe || { reachable: true }
    if (r.probe?.probedUrl) mcpForm.value.url = r.probe.probedUrl
    return r.probe || null
  } catch (e) {
    mcpProbeResult.value = { reachable: false, error: e instanceof Error ? e.message : 'Probe failed' }
    return null
  } finally {
    mcpProbeBusy.value = false
  }
}

function linkedMcpNames(skill: Skill) {
  return (skill.mcpIds || []).map((id) => mcpNameMap.value[id]).filter(Boolean)
}

async function loadMine() {
  const [skillsRes, mcpsRes] = await Promise.all([
    api.get<{ skills?: Skill[] }>('/api/config/skills'),
    api.get<{ mcps?: McpServer[] }>('/api/config/mcps'),
  ])
  skills.value = skillsRes.skills || []
  mcps.value = mcpsRes.mcps || []
}

async function searchHub() {
  loading.value = true
  hubLoaded.value = true
  try {
    const r = await api.get<{ available?: boolean; skills?: HubSkill[] }>(
      `/api/clawhub/search?q=${encodeURIComponent(hubQuery.value.trim())}`,
    )
    hubAvailable.value = r.available !== false
    hubSkills.value = r.skills || []
  } catch {
    hubAvailable.value = false
    hubSkills.value = []
    message.error('Skill search failed')
  } finally {
    loading.value = false
  }
}

async function refresh() {
  loading.value = true
  try {
    await loadMine()
    if (tab.value === 'browse') await searchHub()
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Could not load skills')
  } finally {
    loading.value = false
  }
}

function openAddSkill() {
  skillEditing.value = null
  skillForm.value = { name: '', system: '', description: '', mcpIds: [] }
  skillError.value = ''
  skillModalOpen.value = true
}

function openEditSkill(skill: Skill) {
  skillEditing.value = skill
  skillForm.value = {
    name: skill.name,
    system: skill.system || '',
    description: skill.description || '',
    mcpIds: [...(skill.mcpIds || [])],
  }
  skillError.value = ''
  skillModalOpen.value = true
}

function toggleSkillMcp(id: string) {
  const set = new Set(skillForm.value.mcpIds)
  if (set.has(id)) set.delete(id)
  else set.add(id)
  skillForm.value.mcpIds = [...set]
}

async function saveSkill() {
  skillError.value = ''
  const name = skillForm.value.name.trim()
  if (!name) {
    skillError.value = 'Name is required.'
    return
  }
  skillBusy.value = true
  const wasEdit = !!skillEditing.value
  try {
    const body = {
      name,
      system: skillForm.value.system.trim(),
      description: skillForm.value.description.trim(),
      mcpIds: skillForm.value.mcpIds,
    }
    if (skillEditing.value) {
      await api.send('PUT', `/api/config/skills/${skillEditing.value.id}`, body)
    } else {
      await api.send('POST', '/api/config/skills', body)
    }
    skillModalOpen.value = false
    await loadMine()
    dialog.success({
      title: wasEdit ? 'Skill updated' : 'Skill added',
      content: wasEdit
        ? `"${name}" has been saved.`
        : `"${name}" is now in My Skills. You can assign it to agents from the Agents page.`,
      positiveText: 'OK',
    })
  } catch (e) {
    skillError.value = e instanceof Error ? e.message : 'Save failed'
  } finally {
    skillBusy.value = false
  }
}

async function removeSkill(id: string) {
  if (!window.confirm('Remove this skill?')) return
  try {
    await api.send('DELETE', `/api/config/skills/${id}`)
    await loadMine()
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Could not remove skill')
  }
}

function mcpEndpoint(m: McpServer) {
  if (m.url) return m.url
  if (m.command) return [m.command, ...(m.args || [])].join(' ')
  return '—'
}

function openAddMcp() {
  mcpEditing.value = null
  mcpForm.value = { name: '', url: '' }
  mcpError.value = ''
  mcpProbeResult.value = null
  mcpModalOpen.value = true
}

function openEditMcp(mcp: McpServer) {
  mcpEditing.value = mcp
  mcpForm.value = {
    name: mcp.name,
    url: mcp.url || '',
  }
  mcpError.value = ''
  mcpProbeResult.value = null
  mcpModalOpen.value = true
}

async function openManageAccounts(mcp: McpServer) {
  manageTarget.value = mcp
  manageAccountsOpen.value = true
  try {
    const r = await api.get<{ accounts?: McpAccount[] }>(`/api/config/mcps/${mcp.id}/accounts`)
    manageAccounts.value = r.accounts || mcp.accounts || []
  } catch {
    manageAccounts.value = mcp.accounts || []
  }
}

function openAddAccount(mcp: McpServer) {
  addAccountTarget.value = mcp
  addAccountForm.value = {
    label: `Account ${(mcp.accountCount || mcp.accounts?.length || 0) + 1}`,
    authType: effectiveAuthType(mcp) === 'none' ? 'bearer' : effectiveAuthType(mcp),
  }
  addAccountError.value = ''
  addAccountOpen.value = true
}

async function saveAddAccount() {
  if (!addAccountTarget.value) return
  const label = addAccountForm.value.label.trim()
  if (!label) {
    addAccountError.value = 'Account label is required.'
    return
  }
  addAccountBusy.value = true
  addAccountError.value = ''
  try {
    const r = await api.send<{ account?: McpAccount; mcp?: McpServer }>(
      'POST',
      `/api/config/mcps/${addAccountTarget.value.id}/accounts`,
      { label, authType: addAccountForm.value.authType },
    )
    addAccountOpen.value = false
    await loadMine()
    if (r.account && addAccountForm.value.authType !== 'none') {
      const mcp = mcps.value.find((m) => m.id === addAccountTarget.value?.id)
      if (mcp) openAuth(mcp, r.account.id)
    } else {
      message.success('Account added')
    }
  } catch (e) {
    addAccountError.value = e instanceof Error ? e.message : 'Could not add account'
  } finally {
    addAccountBusy.value = false
  }
}

async function disconnectAccount(mcp: McpServer, accountId: string) {
  try {
    await api.send('POST', `/api/config/mcps/${mcp.id}/accounts/${accountId}/disconnect`, {})
    message.success('Account disconnected')
    await loadMine()
    if (manageTarget.value?.id === mcp.id) await openManageAccounts(mcp)
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Disconnect failed')
  }
}

function loginAccount(mcp: McpServer, accountId: string) {
  openAuth(mcp, accountId)
}

async function saveMcp() {
  mcpError.value = ''
  const name = mcpForm.value.name.trim()
  const url = mcpForm.value.url.trim()
  if (!name) {
    mcpError.value = 'Name is required.'
    return
  }
  if (!url) {
    mcpError.value = 'Server URL is required.'
    return
  }
  mcpBusy.value = true
  const wasEdit = !!mcpEditing.value
  try {
    const urlChanged = !mcpEditing.value || url !== (mcpEditing.value.url || '').trim()
    if (!wasEdit || urlChanged) {
      const probe = await probeMcpUrl()
      if (!probe?.reachable) {
        mcpError.value = probe?.error || mcpProbeResult.value?.error || 'MCP server unreachable — check URL and try again.'
        return
      }
    }
    const body: Record<string, unknown> = {
      name,
      url: mcpForm.value.url.trim(),
      transport: 'http',
    }
    if (mcpProbeResult.value?.authRequired !== undefined) {
      body.authRequired = mcpProbeResult.value.authRequired
    }
    if (mcpProbeResult.value?.suggestedAuthType) {
      body.suggestedAuthType = mcpProbeResult.value.suggestedAuthType
    }
    if (mcpEditing.value) {
      await api.send('PUT', `/api/config/mcps/${mcpEditing.value.id}`, body)
    } else {
      await api.send('POST', '/api/config/mcps', body)
    }
    mcpModalOpen.value = false
    await loadMine()
    dialog.success({
      title: wasEdit ? 'MCP updated' : 'MCP added',
      content: wasEdit ? `"${name}" has been saved.` : `"${name}" is ready to link from your skills.`,
      positiveText: 'OK',
    })
  } catch (e) {
    mcpError.value = e instanceof Error ? e.message : 'Save failed'
  } finally {
    mcpBusy.value = false
  }
}

async function removeMcp(id: string) {
  if (!window.confirm('Remove this MCP server?')) return
  try {
    await api.send('DELETE', `/api/config/mcps/${id}`)
    await loadMine()
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Could not remove MCP')
  }
}

function effectiveAuthType(m: McpServer): McpServer['authType'] {
  if (m.authType && m.authType !== 'none') return m.authType
  if (m.suggestedAuthType && m.suggestedAuthType !== 'none') return m.suggestedAuthType
  return m.authRequired ? 'oauth' : 'none'
}

function openAuth(mcp: McpServer, accountId?: string | null) {
  authTarget.value = { ...mcp, authType: effectiveAuthType(mcp) }
  authAccountId.value = accountId || null
  authError.value = ''
  const acc = accountId ? (mcp.accounts || []).find((a) => a.id === accountId) : null
  authForm.value = {
    apiKey: '',
    bearerToken: '',
    clientId: mcp.auth?.oauth?.clientId || '',
    clientSecret: '',
    accessToken: '',
    scopes: mcp.auth?.oauth?.scopes || '',
    authorizeUrl: mcp.auth?.oauth?.authorizeUrl || '',
    tokenUrl: mcp.auth?.oauth?.tokenUrl || '',
  }
  if (acc?.authType && acc.authType !== 'none') {
    authTarget.value = { ...authTarget.value!, authType: acc.authType }
  }
  authModalOpen.value = true
}

async function startOAuthLogin() {
  if (!authTarget.value) return
  authError.value = ''
  authBusy.value = true
  try {
    const m = authTarget.value
    const body = {
      authType: 'oauth' as const,
      accountId: authAccountId.value || undefined,
      auth: {
        oauth: {
          clientId: authForm.value.clientId.trim(),
          clientSecret: authForm.value.clientSecret.trim(),
          scopes: authForm.value.scopes.trim(),
          authorizeUrl: authForm.value.authorizeUrl.trim(),
          tokenUrl: authForm.value.tokenUrl.trim(),
        },
      },
      frontendOrigin: window.location.origin,
    }
    if (!body.auth.oauth.clientId || !body.auth.oauth.authorizeUrl || !body.auth.oauth.tokenUrl) {
      authError.value = 'Client ID, authorize URL, and token URL are required.'
      return
    }
    const startPath = authAccountId.value
      ? `/api/config/mcps/${m.id}/accounts/${authAccountId.value}/oauth/start`
      : `/api/config/mcps/${m.id}/oauth/start`
    const r = await api.send<{ ok?: boolean; authorizeUrl?: string; error?: string }>(
      'POST',
      startPath,
      body,
    )
    if (!r.authorizeUrl) {
      authError.value = 'Could not start OAuth login.'
      return
    }
    if (oauthPopup.value && !oauthPopup.value.closed) oauthPopup.value.close()
    oauthPopup.value = window.open(
      r.authorizeUrl,
      'antleroffice-mcp-oauth',
      'popup=yes,width=520,height=720',
    )
    if (!oauthPopup.value) {
      authError.value = 'Popup blocked — allow popups for this site and try again.'
      return
    }
    message.info('Complete login in the popup window.')
  } catch (e) {
    authError.value = e instanceof Error ? e.message : 'OAuth start failed'
  } finally {
    authBusy.value = false
  }
}

function onOAuthMessage(ev: MessageEvent) {
  const data = ev.data as { type?: string; ok?: boolean; error?: string }
  if (!data || data.type !== 'antleroffice-mcp-oauth') return
  if (oauthPopup.value && !oauthPopup.value.closed) oauthPopup.value.close()
  oauthPopup.value = null
  if (data.ok) {
    message.success('MCP account connected')
    authModalOpen.value = false
    void loadMine()
    return
  }
  authError.value = data.error || 'OAuth login failed'
}

async function connectAuth(openBrowser = false) {
  if (!authTarget.value) return
  authError.value = ''
  authBusy.value = true
  try {
    const m = authTarget.value
    const body: Record<string, unknown> = {
      authType: m.authType,
      auth: {} as Record<string, unknown>,
    }
    if (authAccountId.value) body.accountId = authAccountId.value
    if (m.authType === 'api_key') {
      if (!authForm.value.apiKey.trim()) {
        authError.value = 'Enter an API key.'
        return
      }
      body.auth = { apiKey: authForm.value.apiKey.trim() }
    } else if (m.authType === 'bearer') {
      if (!authForm.value.bearerToken.trim()) {
        authError.value = 'Enter a bearer token.'
        return
      }
      body.auth = { bearerToken: authForm.value.bearerToken.trim() }
    } else if (m.authType === 'oauth') {
      if (!authForm.value.accessToken.trim()) {
        if (openBrowser) {
          await startOAuthLogin()
          return
        }
        authError.value = 'Use Start login for browser OAuth, or paste an access token manually.'
        return
      }
      body.auth = {
        oauth: {
          clientId: authForm.value.clientId.trim(),
          clientSecret: authForm.value.clientSecret.trim(),
          accessToken: authForm.value.accessToken.trim(),
          scopes: authForm.value.scopes.trim(),
          authorizeUrl: authForm.value.authorizeUrl.trim(),
          tokenUrl: authForm.value.tokenUrl.trim(),
        },
      }
    }
    const connectPath = authAccountId.value
      ? `/api/config/mcps/${m.id}/accounts/${authAccountId.value}/connect`
      : `/api/config/mcps/${m.id}/auth/connect`
    const r = await api.send<{ ok?: boolean; authorizeUrl?: string; mcp?: McpServer }>(
      'POST',
      connectPath,
      body,
    )
    if (r.authorizeUrl && openBrowser) {
      await startOAuthLogin()
      return
    }
    if (r.authorizeUrl && !authForm.value.accessToken.trim()) {
      authError.value = 'Use Start login to authorize in the browser.'
      return
    }
    message.success('MCP connected')
    authModalOpen.value = false
    await loadMine()
  } catch (e) {
    authError.value = e instanceof Error ? e.message : 'Connect failed'
  } finally {
    authBusy.value = false
  }
}

async function disconnectAuth(mcp: McpServer) {
  try {
    await api.send('POST', `/api/config/mcps/${mcp.id}/auth/disconnect`, {})
    message.success('Disconnected')
    await loadMine()
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Disconnect failed')
  }
}

function stripAnsi(s: string) {
  return String(s)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[\u2500-\u257f]/g, '')
    .trim()
}

async function openDetails(name: string, eligible: boolean) {
  detailName.value = name
  detailEligible.value = eligible
  detailGuide.value = eligible
    ? 'This skill is Ready — your agents can use it now.'
    : 'This skill needs setup before an agent can use it (API key or CLI tool). See details below.'
  detailText.value = 'Loading…'
  detailOpen.value = true
  try {
    const r = await api.get<{ text?: string }>(`/api/clawhub/info?name=${encodeURIComponent(name)}`)
    detailText.value = stripAnsi(r.text || '') || 'No extra details available.'
  } catch {
    detailText.value = 'Could not load details.'
  }
}

onMounted(() => {
  if (route.query.tab === 'mcps') tab.value = 'mcps'
  window.addEventListener('message', onOAuthMessage)
  refresh().catch(() => message.error('Could not load skills'))
})

onUnmounted(() => {
  window.removeEventListener('message', onOAuthMessage)
  if (oauthPopup.value && !oauthPopup.value.closed) oauthPopup.value.close()
})
</script>

<template>
  <div class="antler-v1-root skills-page">
    <div class="view-head">
      <h1 class="view-title">Skill Market</h1>
    </div>

    <div class="tabs" role="tablist">
      <button type="button" class="tab" :class="{ active: tab === 'skills' }" @click="setTab('skills')">
        My Skills
      </button>
      <button type="button" class="tab" :class="{ active: tab === 'mcps' }" @click="setTab('mcps')">
        MCP Servers
      </button>
      <button type="button" class="tab" :class="{ active: tab === 'browse' }" @click="setTab('browse')">
        Browse
      </button>
    </div>

    <!-- My Skills -->
    <div v-show="tab === 'skills'" class="skilltab">
      <div class="tab-toolbar">
        <p class="hint">
          Add your own skills like Claude Code — custom instructions plus optional MCP tools.
        </p>
        <div class="inline">
          <div class="seg">
            <button type="button" class="seg-btn" :class="{ active: viewMode === 'grid' }" @click="setView('grid')">▦ Grid</button>
            <button type="button" class="seg-btn" :class="{ active: viewMode === 'list' }" @click="setView('list')">≣ List</button>
          </div>
          <button type="button" class="btn" @click="openAddSkill">+ Add skill</button>
        </div>
      </div>
      <div class="market-grid" :class="{ list: viewMode === 'list' }">
        <p v-if="!skills.length" class="hint">No custom skills yet. Add one or pick MCP servers in the next tab.</p>
        <div v-for="s in skills" :key="s.id" class="market-card skill-card">
          <h3>{{ s.name }}</h3>
          <p>{{ (s.system || '').slice(0, 160) || 'No instructions yet.' }}</p>
          <div v-if="linkedMcpNames(s).length" class="chip-row">
            <span v-for="n in linkedMcpNames(s)" :key="n" class="tag">{{ n }}</span>
          </div>
          <div class="card-actions">
            <button type="button" class="btn ghost sm" @click="openEditSkill(s)">Rename / Edit</button>
            <button type="button" class="btn ghost sm" @click="removeSkill(s.id)">Remove</button>
          </div>
        </div>
      </div>
    </div>

    <!-- MCP Servers -->
    <div v-show="tab === 'mcps'" class="skilltab">
      <div class="tab-toolbar">
        <p class="hint">
          Add remote MCP servers by name and URL — link them from your custom skills.
        </p>
        <button type="button" class="btn" @click="openAddMcp">+ Add MCP</button>
      </div>
      <div class="market-grid">
        <p v-if="!mcps.length" class="hint">No MCP servers yet. Add one with a display name and server URL.</p>
        <div v-for="m in mcps" :key="m.id" class="market-card mcp-card">
          <div class="inline card-head">
            <h3>{{ m.name }}</h3>
            <span class="status-pill" :class="mcpStatusClass(m)">{{ mcpStatusText(m) }}</span>
          </div>
          <p class="mcp-meta">{{ mcpEndpoint(m) }}</p>
          <p v-if="(m.accountCount || m.accounts?.length || 0) > 0" class="hint sm">
            {{ m.connectedAccountCount || 0 }}/{{ m.accountCount || m.accounts?.length }} accounts connected
          </p>
          <div class="card-actions">
            <NDropdown trigger="click" :options="mcpMenuOptions(m)" @select="(key) => onMcpMenu(String(key), m)">
              <button type="button" class="btn ghost sm">Actions ▾</button>
            </NDropdown>
          </div>
        </div>
      </div>
    </div>

    <!-- Browse -->
    <div v-show="tab === 'browse'" class="skilltab">
      <p class="hint">
        Built-in OpenClaw skills catalog. <strong>Ready</strong> = usable now; <strong>Needs setup</strong> = API key or CLI first.
      </p>
      <div class="inline hub-search">
        <input v-model="hubQuery" type="text" placeholder="Filter skills…" @keydown.enter="searchHub" />
        <button type="button" class="btn" :disabled="loading" @click="searchHub">Search</button>
      </div>
      <div class="market-grid">
        <p v-if="loading" class="hint">Loading…</p>
        <p v-else-if="!hubAvailable" class="hint">OpenClaw is not installed yet.</p>
        <p v-else-if="!hubSkills.length" class="hint">No matches.</p>
        <div v-for="s in hubSkills" :key="s.name" class="market-card">
          <div class="inline card-head">
            <h3>{{ s.name }}</h3>
            <span class="status-pill" :class="s.eligible ? 'ready' : 'setup'">{{ s.eligible ? 'Ready' : 'Needs setup' }}</span>
          </div>
          <p>{{ (s.description || '').slice(0, 160) }}</p>
          <button type="button" class="btn ghost" @click="openDetails(s.name, !!s.eligible)">Details</button>
        </div>
      </div>
    </div>

    <!-- Skill modal -->
    <NModal v-model:show="skillModalOpen" preset="card" :title="skillEditing ? 'Edit skill' : 'Add skill'" style="max-width: 560px">
      <label class="modal-label">Name</label>
      <NInput v-model:value="skillForm.name" placeholder="e.g. Code review" />
      <label class="modal-label">Instructions</label>
      <NInput v-model:value="skillForm.system" type="textarea" :rows="5" placeholder="What should agents do when this skill is active?" />
      <label class="modal-label">Description (what's new in this version)</label>
      <NInput
        v-model:value="skillForm.description"
        type="textarea"
        :rows="2"
        placeholder="One line on what this skill adds or changed — shown to users and used in update notices."
      />
      <p v-if="skillEditing" class="modal-hint">
        Editing the instructions bumps this skill to v{{ (skillEditing.version || 1) + 1 }}.
      </p>
      <template v-if="mcps.length">
        <label class="modal-label">Linked MCP servers</label>
        <div class="mcp-checklist">
          <label v-for="m in mcps" :key="m.id" class="check-row">
            <input type="checkbox" :checked="skillForm.mcpIds.includes(m.id)" @change="toggleSkillMcp(m.id)" />
            <span>{{ m.name }}</span>
            <span class="tag" :class="{ ready: m.authConnected }">{{ authLabel(m) }}</span>
          </label>
        </div>
      </template>
      <p v-if="skillError" class="modal-error">{{ skillError }}</p>
      <template #footer>
        <NButton @click="skillModalOpen = false">Cancel</NButton>
        <NButton type="primary" :loading="skillBusy" @click="saveSkill">Save</NButton>
      </template>
    </NModal>

    <!-- MCP modal -->
    <NModal v-model:show="mcpModalOpen" preset="card" :title="mcpEditing ? 'Edit MCP' : 'Add MCP'" style="max-width: 480px">
      <label class="modal-label">Name</label>
      <NInput v-model:value="mcpForm.name" placeholder="e.g. Filesystem" />
      <label class="modal-label">Server URL</label>
      <NInput v-model:value="mcpForm.url" placeholder="https://mcp.example.com/sse" />
      <p class="hint">Remote MCP endpoint — the URL your agent connects to.</p>
      <div class="inline probe-row">
        <NButton size="small" :loading="mcpProbeBusy" @click="probeMcpUrl">Test connection</NButton>
        <span v-if="mcpProbeResult?.reachable" class="probe-ok">Reachable</span>
        <span v-else-if="mcpProbeResult && !mcpProbeResult.reachable" class="probe-bad">Unreachable</span>
      </div>
      <p v-if="mcpProbeResult?.reachable && mcpProbeResult.authRequired" class="hint sm">
        Auth required — save then use Actions → Add account to connect.
      </p>
      <p v-if="mcpProbeResult && !mcpProbeResult.reachable" class="modal-error">{{ mcpProbeResult.error }}</p>
      <p v-if="mcpError" class="modal-error">{{ mcpError }}</p>
      <template #footer>
        <NButton @click="mcpModalOpen = false">Cancel</NButton>
        <NButton type="primary" :loading="mcpBusy" @click="saveMcp">Save</NButton>
      </template>
    </NModal>

    <!-- Auth modal -->
    <NModal v-model:show="authModalOpen" preset="card" :title="`Login — ${authTarget?.name || 'MCP'}`" style="max-width: 520px">
      <template v-if="authTarget?.authType === 'api_key'">
        <label class="modal-label">API key</label>
        <NInput v-model:value="authForm.apiKey" type="password" placeholder="sk-…" />
      </template>
      <template v-else-if="authTarget?.authType === 'bearer'">
        <label class="modal-label">Bearer token</label>
        <NInput v-model:value="authForm.bearerToken" type="password" placeholder="Token" />
      </template>
      <template v-else-if="authTarget?.authType === 'oauth'">
        <label class="modal-label">Client ID</label>
        <NInput v-model:value="authForm.clientId" />
        <label class="modal-label">Client secret</label>
        <NInput v-model:value="authForm.clientSecret" type="password" />
        <label class="modal-label">Authorize URL</label>
        <NInput v-model:value="authForm.authorizeUrl" placeholder="https://…/authorize" />
        <label class="modal-label">Token URL (optional)</label>
        <NInput v-model:value="authForm.tokenUrl" />
        <label class="modal-label">Scopes</label>
        <NInput v-model:value="authForm.scopes" placeholder="read write" />
        <label class="modal-label">Access token (optional manual fallback)</label>
        <NInput v-model:value="authForm.accessToken" type="password" placeholder="Only if provider cannot redirect back" />
        <div class="inline" style="margin-top: 10px">
          <NButton type="primary" :loading="authBusy" @click="startOAuthLogin">Start login</NButton>
        </div>
        <p class="hint">Browser opens the provider login page. After approval, tokens are saved automatically.</p>
      </template>
      <p v-if="authError" class="modal-error">{{ authError }}</p>
      <template #footer>
        <NButton @click="authModalOpen = false">Cancel</NButton>
        <NButton type="primary" :loading="authBusy" @click="connectAuth(false)">Connect</NButton>
      </template>
    </NModal>

    <NModal v-model:show="detailOpen" preset="card" :title="detailName" style="max-width: 560px">
      <p class="hint">{{ detailGuide }}</p>
      <pre class="skill-detail-text">{{ detailText }}</pre>
      <template #footer>
        <NButton @click="detailOpen = false">Done</NButton>
      </template>
    </NModal>

    <NModal
      v-model:show="manageAccountsOpen"
      preset="card"
      :title="`Accounts — ${manageTarget?.name || 'MCP'}`"
      style="max-width: 520px"
    >
      <p v-if="!manageAccounts.length" class="hint">No accounts yet. Use Add account from Actions.</p>
      <div v-for="acc in manageAccounts" :key="acc.id" class="account-row">
        <div>
          <strong>{{ acc.label }}</strong>
          <span class="tag" :class="{ ready: acc.authConnected !== false }">
            {{ acc.authConnected === false ? 'Needs login' : 'Ready' }}
          </span>
        </div>
        <div class="inline">
          <NButton v-if="acc.authConnected === false" size="small" @click="manageTarget && loginAccount(manageTarget, acc.id)">
            Login
          </NButton>
          <NButton v-else size="small" @click="manageTarget && disconnectAccount(manageTarget, acc.id)">
            Disconnect
          </NButton>
        </div>
      </div>
      <template #footer>
        <NButton @click="manageAccountsOpen = false">Close</NButton>
        <NButton type="primary" @click="manageTarget && openAddAccount(manageTarget)">Add account</NButton>
      </template>
    </NModal>

    <NModal v-model:show="addAccountOpen" preset="card" title="Add MCP account" style="max-width: 440px">
      <label class="modal-label">Label</label>
      <NInput v-model:value="addAccountForm.label" placeholder="e.g. Facebook #1" />
      <label class="modal-label">Auth type</label>
      <select v-model="addAccountForm.authType" class="auth-type-select">
        <option value="oauth">OAuth</option>
        <option value="bearer">Bearer token</option>
        <option value="api_key">API key</option>
        <option value="none">None</option>
      </select>
      <p v-if="addAccountError" class="modal-error">{{ addAccountError }}</p>
      <template #footer>
        <NButton @click="addAccountOpen = false">Cancel</NButton>
        <NButton type="primary" :loading="addAccountBusy" @click="saveAddAccount">Add</NButton>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.skills-page { padding-bottom: 24px; }
.view-head { margin-bottom: 8px; }
.view-title { margin: 0; font-size: 24px; }
.hub-search { max-width: 520px; margin-bottom: 10px; }
.hub-search input {
  flex: 1; min-width: 0; padding: 8px 12px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--panel); color: var(--text);
}
.card-head { justify-content: space-between; width: 100%; }
.card-head h3 { margin: 0; }
.card-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.mcp-meta { font-size: 12px; color: var(--muted); font-family: ui-monospace, monospace; }
.modal-label { display: block; font-size: 12px; font-weight: 600; margin: 12px 0 6px; opacity: 0.85; }
.modal-error { color: #e88080; font-size: 13px; margin-top: 10px; }
.mcp-checklist { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
.check-row { display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
.btn.sm { font-size: 12px; padding: 4px 10px; }
.skill-detail-text {
  white-space: pre-wrap; font-size: 13px; max-height: 360px; overflow: auto;
  margin: 12px 0 0; padding: 12px; border-radius: 8px;
  background: rgba(0,0,0,0.2); border: 1px solid var(--line);
}
.status-pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
.status-pill.ready { background: rgba(70,209,96,0.15); color: var(--accent); }
.status-pill.setup { background: rgba(240,180,60,0.15); color: #f0b43c; }
.status-pill.login { background: rgba(240,120,80,0.15); color: #f07850; }
.tag.ready { border-color: rgba(70,209,96,0.35); color: var(--accent); }
.hint.sm { font-size: 12px; margin: 4px 0 0; }
.probe-row { gap: 10px; margin-top: 8px; align-items: center; }
.probe-ok { color: var(--accent); font-size: 12px; font-weight: 600; }
.probe-bad { color: #e88080; font-size: 12px; font-weight: 600; }
.account-row {
  display: flex; justify-content: space-between; align-items: center;
  gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line);
}
.account-row:last-child { border-bottom: none; }
.auth-type-select {
  width: 100%; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--panel); color: var(--text);
}
</style>
