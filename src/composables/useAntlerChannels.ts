import { ref, computed, reactive } from 'vue'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { channelMeta, formatWaPhone, CHANNEL_META } from '@/lib/antler-channel-meta'

export interface RawChannel {
  provider: string
  account: string
  name?: string
  phone?: string
  agentId?: string
  instructionMode?: boolean
}

export interface Agent {
  id: string
  name: string
}

export interface ChannelRow {
  provider: string
  account: string
  name: string | null
  title: string
  contact: string
  phone: string | null
  meta: ReturnType<typeof channelMeta>
  pillClass: string
  pillText: string
  instructionMode: boolean
  agentId: string
  sortName: string
  sortProvider: string
  sortContact: string
  sortStatus: string
}

export interface WaStatus {
  linked?: boolean
  connected?: boolean
  phone?: string
  incomplete?: boolean
  sessionInvalid?: boolean
  disconnected?: boolean
  gateway?: boolean
  instructionMode?: boolean
  instructionHint?: string | null
}

const VIEW_KEY = 'antleroffice.channelView'
const PREFS_KEY = 'antleroffice.channelListPrefs'
const PAGE_SIZES = [10, 20, 50, 100, 200]

function loadPrefs() {
  const defaults = {
    search: '',
    filterProvider: '',
    filterAgent: '',
    sortKey: 'name',
    sortDir: 'asc' as 'asc' | 'desc',
    page: 1,
    pageSize: 10,
  }
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
    if (PAGE_SIZES.includes(saved.pageSize)) defaults.pageSize = saved.pageSize
    if (saved.sortKey) defaults.sortKey = saved.sortKey
    if (saved.sortDir === 'asc' || saved.sortDir === 'desc') defaults.sortDir = saved.sortDir
    if (typeof saved.filterProvider === 'string') defaults.filterProvider = saved.filterProvider
    if (typeof saved.filterAgent === 'string') defaults.filterAgent = saved.filterAgent
  } catch { /* ignore */ }
  return defaults
}

export function useAntlerChannels() {
  const api = useAntlerApi()

  const available = ref(false)
  const loading = ref(true)
  const rawChannels = ref<RawChannel[]>([])
  const agents = ref<Agent[]>([])
  const waStatusMap = ref<Record<string, WaStatus>>({})
  const gatewayUp = ref(false)
  const gatewayStarting = ref(false)
  const secretaryLabel = ref('COO')

  const viewMode = ref<'list' | 'grid'>(
    localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list',
  )
  const filterExpanded = ref(false)
  const prefs = reactive({ ...loadPrefs(), search: '' })

  function savePrefs() {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        filterProvider: prefs.filterProvider,
        filterAgent: prefs.filterAgent,
        sortKey: prefs.sortKey,
        sortDir: prefs.sortDir,
        pageSize: prefs.pageSize,
      }),
    )
  }

  function agentNameForId(agentId: string) {
    const id = agentId || 'secretary'
    if (id === 'secretary' || id === 'coo') return secretaryLabel.value
    return agents.value.find((a) => a.id === id)?.name || id
  }

  function buildRow(c: RawChannel): ChannelRow {
    const m = channelMeta(c.provider)
    const isWa = c.provider === 'whatsapp'
    const isTg = c.provider === 'telegram'
    const waStatus = isWa ? waStatusMap.value[c.account] || {} : {}
    const waLinked = !!(waStatus.linked || waStatus.connected)
    const waPairing = !!waStatus.incomplete && !waStatus.connected
    const waInvalid = !!waStatus.sessionInvalid
    const pillClass = isWa ? (waLinked ? 'ok' : 'warn') : isTg ? 'ok' : 'ok'
    const pillText = isWa
      ? waLinked
        ? 'Connected'
        : waInvalid
          ? 'Needs relink'
          : waPairing
            ? 'Pairing…'
            : waStatus.disconnected
              ? 'Disconnected'
              : 'Not linked'
      : isTg
        ? 'Linked'
        : 'Linked'
    const displayName = c.name || null
    const phone = isWa ? formatWaPhone(waStatus.phone || c.phone) : null
    const title = displayName || m.label
    const contact = phone || (c.account !== 'default' ? c.account : '')
    const agentId = c.agentId || 'secretary'
    const instructionMode = isWa && !!(waStatus.instructionMode || c.instructionMode)
    return {
      provider: c.provider,
      account: c.account,
      name: displayName,
      title,
      contact,
      phone,
      meta: m,
      pillClass,
      pillText,
      instructionMode,
      agentId,
      sortName: title.toLowerCase(),
      sortProvider: m.label.toLowerCase(),
      sortContact: (contact || '').toLowerCase(),
      sortStatus: pillText.toLowerCase(),
    }
  }

  const allRows = computed(() => rawChannels.value.map(buildRow))

  const filterCount = computed(() => {
    let n = 0
    if (prefs.filterProvider) n++
    if (prefs.filterAgent) n++
    return n
  })

  const filteredRows = computed(() => {
    const q = prefs.search.trim().toLowerCase()
    let out = allRows.value.slice()
    if (q) {
      out = out.filter((r) => {
        const agentName = agentNameForId(r.agentId).toLowerCase()
        const hay = [r.title, r.contact, r.account, r.meta.label, r.meta.tag, r.provider, agentName]
          .join(' ')
          .toLowerCase()
        return hay.includes(q)
      })
    }
    if (prefs.filterProvider) out = out.filter((r) => r.provider === prefs.filterProvider)
    if (prefs.filterAgent) out = out.filter((r) => r.agentId === prefs.filterAgent)

    const dir = prefs.sortDir === 'desc' ? -1 : 1
    const key = prefs.sortKey
    out.sort((a, b) => {
      let av: string
      let bv: string
      if (key === 'provider') {
        av = a.sortProvider
        bv = b.sortProvider
      } else if (key === 'contact') {
        av = a.sortContact
        bv = b.sortContact
      } else if (key === 'status') {
        av = a.sortStatus
        bv = b.sortStatus
      } else if (key === 'agent') {
        av = agentNameForId(a.agentId).toLowerCase()
        bv = agentNameForId(b.agentId).toLowerCase()
      } else {
        av = a.sortName
        bv = b.sortName
      }
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return a.account.localeCompare(b.account) * dir
    })
    return out
  })

  const total = computed(() => filteredRows.value.length)
  const totalPages = computed(() => Math.max(1, Math.ceil(total.value / prefs.pageSize)))

  const pageRows = computed(() => {
    const p = Math.min(Math.max(1, prefs.page), totalPages.value)
    prefs.page = p
    const start = (p - 1) * prefs.pageSize
    return filteredRows.value.slice(start, start + prefs.pageSize)
  })

  const pageInfo = computed(() => {
    if (!total.value) return { start: 0, end: 0 }
    return {
      start: (prefs.page - 1) * prefs.pageSize + 1,
      end: Math.min(total.value, prefs.page * prefs.pageSize),
    }
  })

  const providerOptions = computed(() => {
    const providers = [...new Set(allRows.value.map((r) => r.provider))].sort((a, b) =>
      channelMeta(a).label.localeCompare(channelMeta(b).label),
    )
    return providers.map((p) => ({ value: p, label: channelMeta(p).label }))
  })

  const agentOptions = computed(() => {
    const ids = new Set(allRows.value.map((r) => r.agentId || 'secretary'))
    const opts = [{ value: 'secretary', label: secretaryLabel.value }]
    for (const a of agents.value) {
      if (ids.has(a.id)) opts.push({ value: a.id, label: a.name })
    }
    for (const id of ids) {
      if (!opts.find((o) => o.value === id)) opts.push({ value: id, label: agentNameForId(id) })
    }
    return opts
  })

  const routeAgentOptions = computed(() => [
    { value: 'secretary', label: secretaryLabel.value },
    ...agents.value.map((a) => ({ value: a.id, label: a.name })),
  ])

  function setView(mode: 'list' | 'grid') {
    viewMode.value = mode
    localStorage.setItem(VIEW_KEY, mode)
    if (mode === 'grid') filterExpanded.value = false
  }

  function toggleSort(key: string) {
    if (prefs.sortKey === key) prefs.sortDir = prefs.sortDir === 'asc' ? 'desc' : 'asc'
    else {
      prefs.sortKey = key
      prefs.sortDir = 'asc'
    }
    savePrefs()
  }

  function sortMark(key: string) {
    if (prefs.sortKey !== key) return ''
    return prefs.sortDir === 'asc' ? ' ▲' : ' ▼'
  }

  function clearFilters() {
    prefs.search = ''
    prefs.filterProvider = ''
    prefs.filterAgent = ''
    prefs.page = 1
    savePrefs()
  }

  async function ensureGateway() {
    if (gatewayUp.value || gatewayStarting.value) return
    gatewayStarting.value = true
    try {
      await api.send('POST', '/api/gateway/start', {}, { timeoutMs: 60000 })
    } catch { /* ignore */ }
    finally {
      gatewayStarting.value = false
    }
  }

  async function refresh() {
    loading.value = true
    try {
      const [data, status, agentsRes, waStatuses] = await Promise.all([
        api.get<{ available?: boolean; channels?: RawChannel[] }>('/api/channels'),
        api.get<{ gateway?: boolean }>('/api/channels/status').catch(() => ({})),
        api.get<{ agents?: Agent[] }>('/api/config/agents').catch(() => ({ agents: [] })),
        api.get<{ accounts?: Record<string, WaStatus> }>('/api/channels/whatsapp/statuses').catch(() => ({})),
      ])
      available.value = !!data.available
      agents.value = agentsRes.agents || []
      waStatusMap.value = (waStatuses as { accounts?: Record<string, WaStatus> }).accounts || {}
      rawChannels.value = (data.channels || [])
        .map((c) => ({
          ...c,
          account: c.account || 'default',
        }))
        .filter((c) => {
          if (c.provider !== 'whatsapp') return true
          const st = waStatusMap.value[c.account || 'default'] || {}
          return !!(st.linked || st.connected || st.incomplete || st.sessionInvalid || c.phone || c.instructionMode)
        })
      gatewayUp.value = !!(status as { gateway?: boolean }).gateway
      if (!gatewayUp.value && available.value) void ensureGateway()

      try {
        const builtins = await api.get<{ agents?: { role?: string; name?: string }[] }>(
          '/api/config/agents',
        )
        const sec = (builtins.agents || []).find((a) => a.role === 'secretary')
        if (sec?.name) secretaryLabel.value = sec.name
      } catch { /* ignore */ }
    } finally {
      loading.value = false
    }
  }

  async function setRoute(provider: string, account: string, agentId: string) {
    await api.send('POST', '/api/channels/route', { provider, account: account || 'default', agentId })
    const hit = rawChannels.value.find(
      (c) => c.provider === provider && (c.account || 'default') === (account || 'default'),
    )
    if (hit) hit.agentId = agentId
  }

  async function renameChannel(provider: string, account: string, currentName: string) {
    const name = window.prompt('Display name', currentName || '')
    if (name === null) return
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Display name cannot be empty.')
    const r = await api.send<{ ok?: boolean; error?: string }>('POST', '/api/channels/rename', {
      provider,
      account: account || 'default',
      name: trimmed,
    })
    if (r.ok === false) throw new Error(r.error || 'Could not save name')
    await refresh()
  }

  async function removeChannel(provider: string, account: string) {
    const r = await api.send<{ ok?: boolean; error?: string }>(
      'DELETE',
      `/api/channels/${encodeURIComponent(provider)}/${encodeURIComponent(account || 'default')}`,
    )
    if (r.ok === false) throw new Error(r.error || 'Could not disconnect')
    await refresh()
  }

  return {
    api,
    available,
    loading,
    rawChannels,
    agents,
    gatewayUp,
    gatewayStarting,
    viewMode,
    filterExpanded,
    prefs,
    filterCount,
    allRows,
    pageRows,
    total,
    totalPages,
    pageInfo,
    providerOptions,
    agentOptions,
    routeAgentOptions,
    PAGE_SIZES,
    CHANNEL_META,
    savePrefs,
    setView,
    toggleSort,
    sortMark,
    clearFilters,
    refresh,
    setRoute,
    renameChannel,
    removeChannel,
    ensureGateway,
    agentNameForId,
  }
}
