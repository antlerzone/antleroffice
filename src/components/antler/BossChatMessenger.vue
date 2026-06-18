<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { NIcon, NSelect, useMessage, useDialog } from 'naive-ui'
import {
  ChatbubblesOutline,
  CloseOutline,
  RemoveOutline,
  AddOutline,
  PinOutline,
  TrashOutline,
  PaperPlaneOutline,
  PeopleOutline,
} from '@vicons/ionicons5'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useBossStore } from '@/stores/boss'
import { useAiSetupStore } from '@/stores/aiSetup'
import { useOfficeShareStore } from '@/stores/officeShare'
import { useWebSocketStore } from '@/stores/websocket'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { ConnectionState } from '@/api/types'
import AgentChatPanel from '@/components/office/AgentChatPanel.vue'
import {
  normalizeOpenClawSessionKey,
  readSelectedOpenClawSessionKey,
  sessionKeysMatch,
  writeSelectedOpenClawSessionKey,
} from '@/utils/openclaw-session-key'

interface OfficeAgent {
  id: string
  label: string
  role: string
  npcState?: string
  bubbleText?: string
  awaitingBossInput?: boolean
  currentJob?: { label?: string; step?: string; progress?: number; total?: number } | null
  userAgentId?: string | null
  openclawAgentId?: string | null
  external?: boolean
}

interface ChatMsg {
  id: string
  from: string
  text: string
  ts: number
  authorName?: string | null
}

interface ChatThread {
  id: string
  agentId: string
  title: string
  pinned: boolean
  createdAt: number
  updatedAt: number
  messageCount: number | null
  openclawSessionKey?: string | null
  openclawAgentId?: string | null
  gatewayBacked?: boolean
}

const WHO: Record<string, string> = {
  boss: 'Boss',
  secretary: 'Reception',
  coo: 'COO',
  it: 'IT',
  worker: 'Worker',
  system: 'System',
}

const PIN_KEY = 'antleroffice.bossChatPinned'
const THREAD_KEY = 'antleroffice.bossChatActiveThread'
const PANEL_KEY = 'antleroffice.bossChatPanels'

interface PanelPrefs {
  team: boolean
  chats: boolean
}

interface OfficeSnapshot {
  agents?: OfficeAgent[]
  chat?: ChatMsg[]
  threads?: ChatThread[]
  activeThreadId?: string | null
  ownerKey?: string
  ownerName?: string | null
}

const api = useAntlerApi()
const boss = useBossStore()
const aiSetup = useAiSetupStore()
const officeShare = useOfficeShareStore()
const wsStore = useWebSocketStore()
const chatStore = useChatStore()
const sessionStore = useSessionStore()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()

const open = ref(false)
const agents = ref<OfficeAgent[]>([])
const threads = ref<ChatThread[]>([])
const chat = ref<ChatMsg[]>([])
const connected = ref(false)
const chatText = ref('')
const sending = ref(false)
const chatMode = ref<'agent' | 'plan'>('agent')
const selectedAgentId = ref('')
const selectedThreadId = ref('')
const scopeKey = ref('local:boss')
const scopeName = ref(boss.session?.username || 'Boss')
const pinnedIds = ref<string[]>([])
const showTeamPanel = ref(loadPanelPrefs().team)
const showChatsPanel = ref(loadPanelPrefs().chats)
const chatLogRef = ref<HTMLElement | null>(null)
const lastChatLen = ref(0)
const queueHint = ref('')
const openClawSessionKey = ref('')
const openClawSessionLoading = ref(false)

const modeOptions = [
  { label: '⚡ Agent', value: 'agent' },
  { label: '📋 Plan', value: 'plan' },
]

let pollTimer: ReturnType<typeof setInterval> | null = null
let chatEvents: EventSource | null = null
const savedPlanAssistantIds = new Set<string>()

function eventsUrl() {
  const params = new URLSearchParams()
  if (selectedAgentId.value) params.set('agentId', selectedAgentId.value)
  if (selectedThreadId.value) params.set('threadId', selectedThreadId.value)
  if (boss.token) params.set('bossToken', boss.token)
  const share = officeShare.share
  const base =
    share?.enabled && share.role === 'member' && share.hostUrl
      ? share.hostUrl.replace(/\/+$/, '')
      : ''
  return `${base}/api/office/events?${params.toString()}`
}

function disconnectEvents() {
  chatEvents?.close()
  chatEvents = null
}

function connectEvents() {
  disconnectEvents()
  if (!open.value) return
  try {
    chatEvents = new EventSource(eventsUrl())
    chatEvents.addEventListener('chat', () => {
      void poll()
    })
    chatEvents.addEventListener('office', () => {
      void poll()
    })
  } catch {
    /* SSE optional — poll fallback remains */
  }
}

function loadPanelPrefs(): PanelPrefs {
  try {
    const raw = localStorage.getItem(PANEL_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PanelPrefs>
      return {
        team: parsed.team ?? false,
        chats: parsed.chats ?? true,
      }
    }
  } catch {
    /* ignore */
  }
  return { team: false, chats: true }
}

function savePanelPrefs() {
  localStorage.setItem(
    PANEL_KEY,
    JSON.stringify({ team: showTeamPanel.value, chats: showChatsPanel.value }),
  )
}

function toggleTeamPanel() {
  showTeamPanel.value = !showTeamPanel.value
  savePanelPrefs()
}

function toggleChatsPanel() {
  showChatsPanel.value = !showChatsPanel.value
  savePanelPrefs()
}

const bodyGridColumns = computed(() => 'var(--boss-chat-side-menu-width, 44px) 1fr')

const panelsGridColumns = computed(() => {
  const cols: string[] = []
  if (showTeamPanel.value) cols.push('200px')
  if (showChatsPanel.value) cols.push('180px')
  cols.push('1fr')
  return cols.join(' ')
})

function scopedPinKey() {
  return `${PIN_KEY}:${scopeKey.value}`
}

function scopedThreadKey() {
  return `${THREAD_KEY}:${scopeKey.value}`
}

function reloadScopePrefs() {
  pinnedIds.value = loadPinned()
}

function loadPinned(): string[] {
  try {
    const raw = localStorage.getItem(scopedPinKey())
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function loadThreadMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(scopedThreadKey())
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function saveThreadForAgent(agentId: string, threadId: string) {
  const map = loadThreadMap()
  map[agentId] = threadId
  localStorage.setItem(scopedThreadKey(), JSON.stringify(map))
}

function savePinned() {
  localStorage.setItem(scopedPinKey(), JSON.stringify(pinnedIds.value))
}

const listAgents = computed(() => {
  const list = agents.value.filter((a) => !a.external)
  const pinSet = new Set(pinnedIds.value)
  return [...list].sort((a, b) => {
    const ap = pinSet.has(a.id) ? 0 : 1
    const bp = pinSet.has(b.id) ? 0 : 1
    if (ap !== bp) return ap - bp
    if (a.role === 'coo') return -1
    if (b.role === 'coo') return 1
    return a.label.localeCompare(b.label)
  })
})

const selectedAgent = computed(
  () => listAgents.value.find((a) => a.id === selectedAgentId.value) || null,
)

const composerTargetLabel = computed(() => {
  const a = selectedAgent.value
  if (!a) return 'COO · OpenClaw'
  return a.label
})

const activeThread = computed(
  () => threads.value.find((t) => t.id === selectedThreadId.value) || null,
)

const agentIsWorking = computed(() => selectedAgent.value?.npcState === 'working')

function openClawAgentIdFor(agent: OfficeAgent | null | undefined): string | null {
  if (!agent || agent.external) return null
  if (agent.openclawAgentId) return agent.openclawAgentId
  if (agent.role === 'coo') return 'main'
  return null
}

const selectedOpenClawAgentId = computed(() => openClawAgentIdFor(selectedAgent.value))

const useOpenClawBossChat = computed(() => {
  const id = selectedOpenClawAgentId.value
  if (!id) return false
  if (chatMode.value === 'agent') return true
  if (chatMode.value === 'plan' && selectedAgent.value?.role === 'coo') return true
  return false
})

const gatewayConnected = computed(() => wsStore.state === ConnectionState.CONNECTED)

const agentActivityLabel = computed(() => {
  const a = selectedAgent.value
  if (!a || a.npcState !== 'working') return ''
  const name = a.label || whoLabel(a.role)
  if (a.awaitingBossInput) return `${name} is waiting for you`
  const step = String(a.currentJob?.step || '').toLowerCase()
  const bubble = String(a.bubbleText || '').toLowerCase()
  const blob = `${step} ${bubble}`
  if (/wait|needs input|key/.test(blob)) return `${name} is waiting for you`
  if (/search|fetch|browse|exec|tool|web|curl|git|read file|using/.test(blob)) {
    return `${name} is searching`
  }
  if (/typ|reply|produc|draft/.test(blob)) {
    return `${name} is typing`
  }
  return `${name} is thinking`
})

function displayName(m: ChatMsg) {
  if (m.authorName) return m.authorName
  return whoLabel(m.from)
}

function whoLabel(from: string) {
  return WHO[from] || from
}

function isPinned(id: string) {
  return pinnedIds.value.includes(id)
}

function isThreadPinned(id: string) {
  return threads.value.find((t) => t.id === id)?.pinned ?? false
}

function togglePin(id: string) {
  if (isPinned(id)) pinnedIds.value = pinnedIds.value.filter((x) => x !== id)
  else pinnedIds.value = [...pinnedIds.value, id]
  savePinned()
}

function ensureDefaultAgent() {
  if (selectedAgentId.value && listAgents.value.some((a) => a.id === selectedAgentId.value)) return
  const coo = listAgents.value.find((a) => a.role === 'coo')
  selectedAgentId.value = coo?.id || listAgents.value[0]?.id || ''
}

function ensureDefaultThread() {
  if (!selectedAgentId.value) {
    if (selectedThreadId.value && threads.value.some((t) => t.id === selectedThreadId.value)) return
    selectedThreadId.value = threads.value[0]?.id || ''
    return
  }
  if (selectedThreadId.value && threads.value.some((t) => t.id === selectedThreadId.value)) return
  const saved = loadThreadMap()[selectedAgentId.value]
  if (saved && threads.value.some((t) => t.id === saved)) {
    selectedThreadId.value = saved
    return
  }
  const forAgent = threads.value.find((t) => t.agentId === selectedAgentId.value)
  selectedThreadId.value = forAgent?.id || threads.value[0]?.id || ''
}

function threadAgentLabel(thread: ChatThread) {
  const agent = agents.value.find((a) => a.id === thread.agentId)
  return agent?.label || thread.agentId
}

function threadMetaLabel(thread: ChatThread) {
  if (thread.gatewayBacked) return 'live session'
  const count = thread.messageCount ?? 0
  return `${count} message${count === 1 ? '' : 's'}`
}

function snapshotQuery() {
  const params = new URLSearchParams()
  if (selectedAgentId.value) params.set('agentId', selectedAgentId.value)
  if (selectedThreadId.value) params.set('threadId', selectedThreadId.value)
  const q = params.toString()
  return q ? `?${q}` : ''
}

function scrollChatIfNeeded(force = false) {
  const el = chatLogRef.value
  if (!el) return
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  if (force || atBottom) el.scrollTop = el.scrollHeight
}

async function poll() {
  try {
    const base = await api.get<OfficeSnapshot>('/api/office/snapshot')
    if (base.ownerKey) scopeKey.value = base.ownerKey
    if (base.ownerName) scopeName.value = base.ownerName
    else if (boss.session?.username) scopeName.value = boss.session.username

    agents.value = base.agents || []
    threads.value = base.threads || []
    ensureDefaultAgent()
    ensureDefaultThread()

    let snap = base
    if (selectedAgentId.value && !useOpenClawBossChat.value) {
      snap = await api.get<OfficeSnapshot>(`/api/office/snapshot${snapshotQuery()}`)
      if (snap.threads?.length) threads.value = snap.threads
    }

    if (!useOpenClawBossChat.value) {
      const nextChat = snap.chat || []
      if (nextChat.length !== lastChatLen.value) {
        chat.value = nextChat
        lastChatLen.value = nextChat.length
        await nextTick()
        scrollChatIfNeeded()
      } else {
        chat.value = nextChat
      }
    }
    if (snap.activeThreadId && !selectedThreadId.value) {
      selectedThreadId.value = snap.activeThreadId
    }
    ensureDefaultThread()
    if (selectedThreadId.value && selectedAgentId.value) {
      saveThreadForAgent(selectedAgentId.value, selectedThreadId.value)
    }
    if (
      open.value &&
      useOpenClawBossChat.value &&
      selectedThreadId.value &&
      !openClawSessionKey.value &&
      !openClawSessionLoading.value
    ) {
      void loadOpenClawSession()
    }
    connected.value = true
    schedulePoll()
  } catch {
    connected.value = false
  }
}

function startPoll() {
  stopPoll()
  void poll()
  connectEvents()
  schedulePoll()
}

function schedulePoll() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  const ms = agentIsWorking.value ? 1200 : open.value ? 5000 : 8000
  pollTimer = setInterval(() => void poll(), ms)
}

function stopPoll() {
  disconnectEvents()
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function toggleOpen() {
  open.value = !open.value
  if (open.value) {
    startPoll()
    void nextTick(() => scrollChatIfNeeded(true))
  }
}

function selectAgent(id: string) {
  selectedAgentId.value = id
  const saved = loadThreadMap()[id]
  selectedThreadId.value = saved && threads.value.some((t) => t.id === saved && t.agentId === id) ? saved : ''
  connectEvents()
  void poll()
  void loadOpenClawSession()
}

function persistUnifiedSession(key: string) {
  const agentId = selectedOpenClawAgentId.value || 'main'
  const normalized = normalizeOpenClawSessionKey(key, agentId)
  openClawSessionKey.value = normalized
  writeSelectedOpenClawSessionKey(normalized, agentId)
  chatStore.setSessionKey(normalized)
}

function syncThreadFromStoredSession() {
  const stored = readSelectedOpenClawSessionKey()
  if (!stored || !threads.value.length) return
  const match = threads.value.find(
    (t) =>
      t.openclawSessionKey &&
      sessionKeysMatch(t.openclawSessionKey, stored, t.openclawAgentId || 'main'),
  )
  if (!match || match.id === selectedThreadId.value) return
  const thread = match
  if (thread.agentId !== selectedAgentId.value) {
    selectedAgentId.value = thread.agentId
  }
  selectedThreadId.value = thread.id
  saveThreadForAgent(selectedAgentId.value, thread.id)
  void loadOpenClawSession()
}

function selectThread(id: string) {
  const thread = threads.value.find((t) => t.id === id)
  if (thread && thread.agentId !== selectedAgentId.value) {
    selectedAgentId.value = thread.agentId
  }
  selectedThreadId.value = id
  saveThreadForAgent(selectedAgentId.value, id)
  lastChatLen.value = 0
  connectEvents()
  void poll()
  void loadOpenClawSession()
}

async function loadOpenClawSession() {
  openClawSessionKey.value = ''
  if (!useOpenClawBossChat.value || !selectedThreadId.value) return
  openClawSessionLoading.value = true
  try {
    const res = await api.get<{
      ok: boolean
      openclawSessionKey?: string
      openclawAgentId?: string
    }>(`/api/boss-chats/${selectedThreadId.value}/openclaw-session`)
    if (res.openclawSessionKey) {
      persistUnifiedSession(res.openclawSessionKey)
      threads.value = threads.value.map((t) =>
        t.id === selectedThreadId.value
          ? {
              ...t,
              openclawSessionKey: res.openclawSessionKey!,
              openclawAgentId: res.openclawAgentId || selectedOpenClawAgentId.value,
              gatewayBacked: true,
            }
          : t,
      )
      if (gatewayConnected.value) void sessionStore.fetchSessions()
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Could not load OpenClaw session')
  } finally {
    openClawSessionLoading.value = false
  }
}

async function maybeUpdateThreadTitleFromGateway() {
  if (!useOpenClawBossChat.value || !selectedThreadId.value || !openClawSessionKey.value) return
  if (chatStore.sessionKey !== openClawSessionKey.value) return
  const thread = threads.value.find((t) => t.id === selectedThreadId.value)
  if (!thread || (thread.title !== 'New chat' && thread.title.trim())) return

  const firstUser = chatStore.messages.find(
    (m) => m.role === 'user' && String(m.content || '').trim(),
  )
  if (!firstUser) return

  let text = String(firstUser.content || '').trim()
  if (text.startsWith('Produce a clear, step-by-step PLAN')) {
    const idx = text.indexOf('Task: ')
    text = idx >= 0 ? text.slice(idx + 6).trim() : text
  }
  const title = text.length > 42 ? `${text.slice(0, 42)}…` : text
  if (!title || title === thread.title) return

  try {
    await api.send('PATCH', `/api/boss-chats/${thread.id}`, { title })
    threads.value = threads.value.map((t) => (t.id === thread.id ? { ...t, title } : t))
    if (gatewayConnected.value) {
      void sessionStore.patchSessionLabel(openClawSessionKey.value, title)
    }
  } catch {
    /* title sync is best-effort */
  }
}

async function newChat() {
  if (!selectedAgentId.value) return
  try {
    const res = await api.send<{ ok: boolean; thread?: ChatThread }>('POST', '/api/boss-chats', {
      agentId: selectedAgentId.value,
    })
    if (res.thread) {
      threads.value = [res.thread, ...threads.value]
      const openclawId = openClawAgentIdFor(selectedAgent.value)
      const agentThreads = threads.value
        .filter((t) => t.agentId === selectedAgentId.value)
        .sort((a, b) => a.createdAt - b.createdAt)
      const isDefaultThread = agentThreads[0]?.id === res.thread.id

      if (openclawId && gatewayConnected.value && !isDefaultThread) {
        try {
          const key = await sessionStore.createSession({
            agentId: openclawId,
            peer: `boss-${res.thread.id}`,
            label: res.thread.title,
          })
          await api.send('PATCH', `/api/boss-chats/${res.thread.id}`, { openclawSessionKey: key })
          res.thread.openclawSessionKey = key
          res.thread.gatewayBacked = true
          threads.value = threads.value.map((t) =>
            t.id === res.thread.id ? { ...t, openclawSessionKey: key, gatewayBacked: true } : t,
          )
        } catch {
          /* ensure endpoint assigns a deterministic key on first open */
        }
      }

      selectThread(res.thread.id)
      if (!useOpenClawBossChat.value) {
        chat.value = []
        lastChatLen.value = 0
      }
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Could not create chat')
  }
}

async function toggleThreadPin(thread: ChatThread) {
  try {
    const res = await api.send<{ ok: boolean; thread?: ChatThread }>(
      'PATCH',
      `/api/boss-chats/${thread.id}`,
      { pinned: !thread.pinned },
    )
    if (res.thread) {
      threads.value = threads.value
        .map((t) => (t.id === thread.id ? { ...t, pinned: res.thread!.pinned } : t))
        .sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
          return b.updatedAt - a.updatedAt
        })
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Could not pin chat')
  }
}

function confirmDeleteThread(thread: ChatThread) {
  dialog.warning({
    title: 'Delete chat',
    content: `Delete "${thread.title}"? This cannot be undone.`,
    positiveText: 'Delete',
    negativeText: 'Cancel',
    onPositiveClick: async () => {
      try {
        await api.send('DELETE', `/api/boss-chats/${thread.id}`, {})
        threads.value = threads.value.filter((t) => t.id !== thread.id)
        if (selectedThreadId.value === thread.id) {
          selectedThreadId.value = threads.value[0]?.id || ''
          chat.value = []
          lastChatLen.value = 0
          if (!selectedThreadId.value && selectedAgentId.value) {
            await newChat()
          } else {
            await poll()
          }
        }
        message.success('Chat deleted')
      } catch (e) {
        message.error(e instanceof Error ? e.message : 'Could not delete chat')
      }
    },
  })
}

function addAgent() {
  open.value = false
  void router.push({ name: 'AntlerAgents', query: { tab: 'browse' } })
}

function confirmRemove(agent: OfficeAgent) {
  if (!agent.userAgentId) return
  dialog.warning({
    title: 'Remove agent',
    content: `Fire "${agent.label}"? They will leave per your payroll rules.`,
    positiveText: 'Remove',
    negativeText: 'Cancel',
    onPositiveClick: async () => {
      try {
        await api.send('POST', `/api/config/agents/${agent.userAgentId}/fire`, {})
        message.success(`${agent.label} scheduled for removal`)
        if (selectedAgentId.value === agent.id) selectedAgentId.value = ''
        await poll()
      } catch (e) {
        message.error(e instanceof Error ? e.message : 'Could not remove agent')
      }
    },
  })
}

async function sendBossChat() {
  const text = chatText.value.trim()
  if (!text || sending.value) return
  if (!selectedAgentId.value) {
    message.warning('Select an agent first')
    return
  }
  if (!selectedThreadId.value) {
    await newChat()
    if (!selectedThreadId.value) return
  }
  sending.value = true
  queueHint.value = ''
  try {
    const res = await api.send<{
      ok: boolean
      queued?: boolean
      queuePosition?: number
    }>('POST', '/api/chat', {
      text,
      mode: chatMode.value,
      targetAgentId: selectedAgentId.value || undefined,
      threadId: selectedThreadId.value || undefined,
    })
    if (res.queued && res.queuePosition) {
      queueHint.value = `Queued (position ${res.queuePosition})`
    }
    chatText.value = ''
    await poll()
    await nextTick()
    scrollChatIfNeeded(true)
  } catch (e) {
    if (!aiSetup.maybePromptFromError(e)) {
      message.error(e instanceof Error ? e.message : 'Could not send')
    }
  } finally {
    sending.value = false
  }
}

function onComposerKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void sendBossChat()
  }
}

async function maybeSavePlanDeliverable() {
  if (chatMode.value !== 'plan' || !selectedThreadId.value || !openClawSessionKey.value) return
  if (chatStore.sessionKey !== openClawSessionKey.value || chatStore.sending) return

  const msgs = chatStore.messages
  const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant' && String(m.content || '').trim())
  if (!lastAssistant?.id || savedPlanAssistantIds.has(lastAssistant.id)) return

  const lastUser = [...msgs].reverse().find((m) => m.role === 'user' && String(m.content || '').trim())
  if (!lastUser) return

  let task = String(lastUser.content || '').trim()
  if (task.startsWith('Produce a clear, step-by-step PLAN')) {
    const idx = task.indexOf('Task: ')
    task = idx >= 0 ? task.slice(idx + 6).trim() : task
  }

  const result = String(lastAssistant.content || '').trim()
  if (!task || !result) return

  try {
    await api.send('POST', `/api/boss-chats/${selectedThreadId.value}/plan-deliverable`, { task, result })
    savedPlanAssistantIds.add(lastAssistant.id)
    message.success('Plan saved — see Complete Job')
  } catch {
    /* deliverable save is best-effort */
  }
}

watch(open, (v) => {
  startPoll()
  if (v) {
    wsStore.connect()
    void poll().then(() => {
      syncThreadFromStoredSession()
      void loadOpenClawSession()
    })
    void nextTick(() => scrollChatIfNeeded(true))
  }
})

watch([useOpenClawBossChat, selectedThreadId, selectedOpenClawAgentId], () => {
  if (open.value) void loadOpenClawSession()
})

watch(
  () =>
    [
      chatMode.value,
      openClawSessionKey.value,
      chatStore.sending,
      chatStore.messages.map((m) => `${m.id || ''}:${m.role}:${String(m.content || '').length}`).join('|'),
    ].join('::'),
  () => {
    void maybeSavePlanDeliverable()
    void maybeUpdateThreadTitleFromGateway()
  },
)

watch(agentIsWorking, () => {
  if (open.value) schedulePoll()
})

watch(
  () => boss.chatOwnerKey,
  (next, prev) => {
    if (next === prev) return
    scopeKey.value = next
    reloadScopePrefs()
    selectedThreadId.value = ''
    threads.value = []
    chat.value = []
    lastChatLen.value = 0
    openClawSessionKey.value = ''
    if (open.value) void poll()
  },
)

onMounted(() => {
  scopeKey.value = boss.chatOwnerKey
  reloadScopePrefs()
  void officeShare.refresh()
  startPoll()
})
onUnmounted(stopPoll)
</script>

<template>
  <div class="boss-chat-messenger">
    <button
      v-show="!open"
      type="button"
      class="boss-chat-fab"
      aria-label="Open Boss Chat"
      @click="toggleOpen"
    >
      <NIcon :component="ChatbubblesOutline" :size="26" />
    </button>

    <Transition name="boss-chat-panel">
      <div v-if="open" class="boss-chat-panel" role="dialog" aria-label="Boss Chat">
        <header class="boss-chat-panel-head">
          <div>
            <strong>Boss Chat</strong>
            <span v-if="scopeName" class="boss-chat-user-tag">{{ scopeName }}</span>
            <span class="boss-chat-conn" :class="{ ok: connected }">
              {{ connected ? 'Connected' : 'Offline' }}
            </span>
          </div>
          <div class="boss-chat-head-actions">
            <button type="button" class="boss-chat-icon-btn" title="Minimize" @click="open = false">
              <NIcon :component="RemoveOutline" />
            </button>
            <button type="button" class="boss-chat-icon-btn" title="Close" @click="open = false">
              <NIcon :component="CloseOutline" />
            </button>
          </div>
        </header>

        <div class="boss-chat-body" :style="{ gridTemplateColumns: bodyGridColumns }">
          <nav class="boss-chat-side-menu" aria-label="Panel toggles">
            <button
              type="button"
              class="boss-chat-side-btn"
              :class="{ active: showTeamPanel }"
              title="Team"
              @click="toggleTeamPanel"
            >
              <NIcon :component="PeopleOutline" :size="18" />
              <span class="boss-chat-side-label">Team</span>
            </button>
            <button
              type="button"
              class="boss-chat-side-btn"
              :class="{ active: showChatsPanel }"
              title="Chats"
              @click="toggleChatsPanel"
            >
              <NIcon :component="ChatbubblesOutline" :size="18" />
              <span class="boss-chat-side-label">Chats</span>
            </button>
          </nav>

          <div class="boss-chat-panels" :style="{ gridTemplateColumns: panelsGridColumns }">
          <aside v-if="showTeamPanel" class="boss-chat-agents">
            <div class="boss-chat-agents-head">
              <span>Team</span>
              <button type="button" class="boss-chat-add-btn" title="Hire agent" @click="addAgent">
                <NIcon :component="AddOutline" />
              </button>
            </div>
            <ul class="boss-chat-agent-list">
              <li
                v-for="a in listAgents"
                :key="a.id"
                class="boss-chat-agent-item"
                :class="{ active: selectedAgentId === a.id, pinned: isPinned(a.id) }"
              >
                <button type="button" class="boss-chat-agent-main" @click="selectAgent(a.id)">
                  <span class="boss-chat-agent-avatar">{{ a.label.slice(0, 1) }}</span>
                  <span class="boss-chat-agent-meta">
                    <span class="boss-chat-agent-name">{{ a.label }}</span>
                    <span class="boss-chat-agent-role">
                      {{ a.npcState === 'working' ? 'Working' : a.role.replace(/_/g, ' ') }}
                      <span v-if="openClawAgentIdFor(a)" class="boss-chat-agent-oc"> · OpenClaw</span>
                    </span>
                  </span>
                </button>
                <div class="boss-chat-agent-actions">
                  <button
                    type="button"
                    class="boss-chat-icon-btn sm"
                    :class="{ on: isPinned(a.id) }"
                    title="Pin agent"
                    @click.stop="togglePin(a.id)"
                  >
                    <NIcon :component="PinOutline" />
                  </button>
                  <button
                    v-if="a.userAgentId"
                    type="button"
                    class="boss-chat-icon-btn sm danger"
                    title="Remove"
                    @click.stop="confirmRemove(a)"
                  >
                    <NIcon :component="TrashOutline" />
                  </button>
                </div>
              </li>
            </ul>
            <p v-if="!listAgents.length" class="boss-chat-agents-empty">No agents yet.</p>
          </aside>

          <aside v-if="showChatsPanel" class="boss-chat-threads">
            <div class="boss-chat-threads-head">
              <span>Your chats · {{ scopeName }}</span>
              <button
                type="button"
                class="boss-chat-add-btn"
                title="New chat"
                :disabled="!selectedAgentId"
                @click="newChat"
              >
                <NIcon :component="AddOutline" />
              </button>
            </div>
            <ul class="boss-chat-thread-list">
              <li
                v-for="t in threads"
                :key="t.id"
                class="boss-chat-thread-item"
                :class="{ active: selectedThreadId === t.id, pinned: t.pinned }"
              >
                <button type="button" class="boss-chat-thread-main" @click="selectThread(t.id)">
                  <span class="boss-chat-thread-title">{{ t.title }}</span>
                  <span class="boss-chat-thread-meta">
                    {{ threadAgentLabel(t) }} · {{ threadMetaLabel(t) }}
                  </span>
                </button>
                <div class="boss-chat-thread-actions">
                  <button
                    type="button"
                    class="boss-chat-icon-btn sm"
                    :class="{ on: isThreadPinned(t.id) }"
                    title="Pin chat"
                    @click.stop="toggleThreadPin(t)"
                  >
                    <NIcon :component="PinOutline" />
                  </button>
                  <button
                    type="button"
                    class="boss-chat-icon-btn sm danger"
                    title="Delete chat"
                    @click.stop="confirmDeleteThread(t)"
                  >
                    <NIcon :component="TrashOutline" />
                  </button>
                </div>
              </li>
            </ul>
            <p v-if="!threads.length" class="boss-chat-agents-empty">
              No chats yet. Pick an agent under Team and start one with +.
            </p>
          </aside>

          <section class="boss-chat-main">
            <div class="boss-chat-target-bar">
              <span v-if="activeThread">{{ activeThread.title }}</span>
              <span v-else>
                Chatting with <strong>{{ composerTargetLabel }}</strong>
              </span>
              <span v-if="selectedAgent?.role === 'coo'" class="boss-chat-default-tag">default</span>
              <span v-if="useOpenClawBossChat" class="boss-chat-openclaw-tag">OpenClaw</span>
              <span v-if="chatMode === 'plan'" class="boss-chat-plan-tag">Plan</span>
              <NSelect
                v-if="selectedAgent?.role === 'coo'"
                v-model:value="chatMode"
                class="boss-chat-mode-select boss-chat-mode-select--bar"
                :options="modeOptions"
                size="small"
                :consistent-menu-width="false"
              />
            </div>

            <div v-if="useOpenClawBossChat" class="boss-chat-openclaw">
              <p v-if="!gatewayConnected" class="boss-chat-gateway-hint">
                OpenClaw Gateway is disconnected. Reconnect from the app header or restart
                <code>npm run dev:all</code>.
              </p>
              <p v-else-if="openClawSessionLoading" class="boss-chat-empty">Loading OpenClaw session…</p>
              <AgentChatPanel
                v-else-if="openClawSessionKey"
                :key="`${openClawSessionKey}:${chatMode}`"
                compact
                :plan-mode="chatMode === 'plan'"
                :external-session-key="openClawSessionKey"
                :title="activeThread?.title || composerTargetLabel"
              />
              <p v-else class="boss-chat-empty">Select or create a chat thread.</p>
            </div>

            <template v-else>
            <div ref="chatLogRef" class="boss-chat-log">
              <p v-if="queueHint" class="boss-chat-queue-hint">{{ queueHint }}</p>
              <div
                v-for="m in chat"
                :key="m.id"
                class="msg"
                :class="m.from"
              >
                <span class="who">{{ displayName(m) }}</span>
                {{ m.text }}
              </div>
              <div v-if="agentActivityLabel" class="boss-chat-typing" :class="selectedAgent?.role">
                <span class="boss-chat-typing-label">{{ agentActivityLabel }}</span>
                <span class="boss-chat-typing-dots" aria-hidden="true">
                  <span></span><span></span><span></span>
                </span>
              </div>
              <p v-if="!chat.length && !agentActivityLabel" class="boss-chat-empty">Tell your team what to do — plain language.</p>
            </div>
            <form class="boss-chat-composer" @submit.prevent="sendBossChat">
              <textarea
                v-model="chatText"
                class="boss-chat-input"
                rows="3"
                placeholder="e.g. Draft a welcome email for new customers…  (Enter to send · Shift+Enter for new line)"
                @keydown="onComposerKeydown"
              />
              <div class="boss-chat-composer-bar">
                <NSelect
                  v-model:value="chatMode"
                  class="boss-chat-mode-select"
                  :options="modeOptions"
                  size="small"
                  :consistent-menu-width="false"
                />
                <button
                  class="boss-chat-send"
                  type="submit"
                  :disabled="sending || !chatText.trim() || !selectedAgentId"
                  title="Send message"
                >
                  <NIcon :component="PaperPlaneOutline" :size="16" />
                  <span>{{ sending ? 'Sending…' : 'Send' }}</span>
                </button>
              </div>
            </form>
            </template>
          </section>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.boss-chat-messenger {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 1100;
}

.boss-chat-fab,
.boss-chat-panel {
  pointer-events: auto;
}

.boss-chat-fab {
  position: fixed;
  right: 24px;
  bottom: 24px;
  left: auto;
  width: 56px;
  height: 56px;
  border: none;
  border-radius: 50%;
  background: linear-gradient(145deg, #0084ff, #006ee6);
  color: #fff;
  box-shadow: 0 8px 24px rgba(0, 132, 255, 0.45);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.boss-chat-fab:hover {
  transform: scale(1.05);
  box-shadow: 0 10px 28px rgba(0, 132, 255, 0.55);
}

.boss-chat-panel {
  --boss-chat-bg: #1e222d;
  --boss-chat-bg-2: #252a36;
  --boss-chat-surface: #11151c;
  --boss-chat-text: #f3f6fa;
  --boss-chat-muted: rgba(255, 255, 255, 0.62);
  --boss-chat-line: rgba(255, 255, 255, 0.14);
  --boss-chat-accent: #46d160;
  position: fixed;
  right: 20px;
  bottom: 20px;
  left: auto;
  width: min(1040px, calc(100vw - 40px));
  height: min(calc(100vh - var(--header-height, 64px) - 40px), 820px);
  max-height: calc(100vh - var(--header-height, 64px) - 40px);
  display: flex;
  flex-direction: column;
  color-scheme: dark;
  color: var(--boss-chat-text);
  background: var(--boss-chat-bg);
  border: 1px solid var(--boss-chat-line);
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
}

.boss-chat-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--boss-chat-line);
  background: var(--boss-chat-bg-2);
  color: var(--boss-chat-text);
}

.boss-chat-panel-head strong {
  font-size: 15px;
}

.boss-chat-user-tag {
  margin-left: 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--boss-chat-muted);
}

.boss-chat-conn {
  margin-left: 10px;
  font-size: 11px;
  color: var(--boss-chat-muted);
}

.boss-chat-conn.ok {
  color: var(--boss-chat-accent);
}

.boss-chat-head-actions {
  display: flex;
  gap: 4px;
}

.boss-chat-icon-btn {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--boss-chat-text);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.boss-chat-icon-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}

.boss-chat-icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.boss-chat-icon-btn.sm {
  width: 28px;
  height: 28px;
}

.boss-chat-icon-btn.on {
  color: var(--boss-chat-accent);
}

.boss-chat-icon-btn.danger:hover {
  color: #ff6b6b;
}

.boss-chat-body {
  flex: 1;
  min-height: 0;
  display: grid;
  --boss-chat-side-menu-width: 44px;
}

.boss-chat-side-menu {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 6px;
  border-right: 1px solid var(--boss-chat-line);
  background: var(--boss-chat-bg-2);
}

.boss-chat-side-btn {
  width: 32px;
  min-height: 52px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--boss-chat-muted);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 6px 4px;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.boss-chat-side-btn:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--boss-chat-text);
}

.boss-chat-side-btn.active {
  background: rgba(70, 209, 96, 0.14);
  border-color: rgba(70, 209, 96, 0.35);
  color: var(--boss-chat-accent);
}

.boss-chat-side-label {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1;
}

.boss-chat-panels {
  display: grid;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.boss-chat-agents,
.boss-chat-threads {
  border-right: 1px solid var(--boss-chat-line);
  background: var(--boss-chat-bg);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.boss-chat-agents-head,
.boss-chat-threads-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--boss-chat-muted);
  border-bottom: 1px solid var(--boss-chat-line);
}

.boss-chat-add-btn {
  width: 28px;
  height: 28px;
  border: 1px solid var(--boss-chat-line);
  border-radius: 8px;
  background: transparent;
  color: var(--boss-chat-text);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.boss-chat-add-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.boss-chat-agent-list,
.boss-chat-thread-list {
  list-style: none;
  margin: 0;
  padding: 8px;
  overflow-y: auto;
  flex: 1;
}

.boss-chat-agent-item,
.boss-chat-thread-item {
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 10px;
  margin-bottom: 4px;
}

.boss-chat-agent-item.active,
.boss-chat-thread-item.active {
  background: rgba(70, 209, 96, 0.12);
}

.boss-chat-agent-item.pinned .boss-chat-agent-name::after,
.boss-chat-thread-item.pinned .boss-chat-thread-title::after {
  content: ' 📌';
  font-size: 10px;
}

.boss-chat-agent-main,
.boss-chat-thread-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 8px;
  border-radius: 10px;
  text-align: left;
}

.boss-chat-agent-main {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.boss-chat-agent-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: linear-gradient(145deg, #3a4558, #2a3140);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 13px;
  flex-shrink: 0;
}

.boss-chat-agent-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.boss-chat-agent-name,
.boss-chat-thread-title {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.boss-chat-agent-role,
.boss-chat-thread-meta {
  font-size: 11px;
  color: var(--boss-chat-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.boss-chat-agent-oc {
  color: #60a5fa;
}

.boss-chat-agent-actions,
.boss-chat-thread-actions {
  display: flex;
  flex-direction: column;
  padding-right: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}

.boss-chat-agent-item:hover .boss-chat-agent-actions,
.boss-chat-agent-item.active .boss-chat-agent-actions,
.boss-chat-thread-item:hover .boss-chat-thread-actions,
.boss-chat-thread-item.active .boss-chat-thread-actions {
  opacity: 1;
}

.boss-chat-agents-empty {
  padding: 12px;
  font-size: 12px;
  color: var(--boss-chat-muted);
}

.boss-chat-main {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  color: var(--boss-chat-text);
}

.boss-chat-target-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 14px;
  font-size: 12px;
  color: var(--boss-chat-muted);
  border-bottom: 1px solid var(--boss-chat-line);
}

.boss-chat-mode-select--bar {
  margin-left: auto;
  width: 108px;
}

.boss-chat-openclaw {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 8px 8px;
}

.boss-chat-openclaw :deep(.chat-panel-card) {
  border: none;
  box-shadow: none;
  background: transparent;
}

.boss-chat-gateway-hint {
  margin: 16px 12px;
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.45;
  color: var(--boss-chat-text);
  background: rgba(255, 180, 60, 0.12);
  border: 1px solid rgba(255, 180, 60, 0.35);
  border-radius: 8px;
}

.boss-chat-gateway-hint code {
  font-size: 12px;
}

.boss-chat-target-bar strong {
  color: var(--boss-chat-text);
}

.boss-chat-default-tag {
  margin-left: 6px;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(70, 209, 96, 0.15);
  color: var(--boss-chat-accent);
}

.boss-chat-openclaw-tag {
  margin-left: 6px;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(96, 165, 250, 0.15);
  color: #60a5fa;
}

.boss-chat-plan-tag {
  margin-left: 6px;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(250, 204, 21, 0.15);
  color: #facc15;
}

.boss-chat-log {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.boss-chat-log .msg {
  max-width: 90%;
  padding: 8px 11px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--boss-chat-text);
}

.boss-chat-log .msg .who {
  display: block;
  font-size: 11px;
  color: var(--boss-chat-muted);
  margin-bottom: 3px;
}

.boss-chat-log .msg.boss {
  align-self: flex-end;
  background: var(--boss-chat-accent);
  color: #102016;
}

.boss-chat-log .msg.boss .who {
  color: #2d4a34;
}

.boss-chat-log .msg.secretary {
  background: #243a55;
}

.boss-chat-log .msg.coo {
  background: #1f3d2e;
}

.boss-chat-log .msg.it {
  background: #2c2348;
}

.boss-chat-log .msg.worker {
  background: var(--boss-chat-bg-2);
}

.boss-chat-log .msg.system {
  align-self: center;
  max-width: 100%;
  background: transparent;
  border: 1px dashed var(--boss-chat-line);
  color: var(--boss-chat-muted);
  font-size: 12px;
}

.boss-chat-empty {
  margin: 0;
  font-size: 13px;
  color: var(--boss-chat-muted);
}

.boss-chat-queue-hint {
  margin: 0 0 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: #2a2410;
  border: 1px solid #5c4a1a;
  color: #f0c674;
  font-size: 12px;
}

.boss-chat-typing {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  align-self: flex-start;
  max-width: 92%;
  margin: 4px 0 8px;
  padding: 10px 14px;
  border-radius: 12px;
  background: #1f3d2e;
  border: 1px solid rgba(70, 209, 96, 0.25);
  color: rgba(255, 255, 255, 0.88);
  font-size: 13px;
}

.boss-chat-typing.it {
  background: #2c2348;
  border-color: rgba(140, 120, 255, 0.25);
}

.boss-chat-typing-label {
  font-style: italic;
  opacity: 0.92;
}

.boss-chat-typing-dots {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}

.boss-chat-typing-dots span {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.55);
  animation: boss-chat-typing-bounce 1.4s infinite ease-in-out;
}

.boss-chat-typing-dots span:nth-child(2) {
  animation-delay: 0.16s;
}

.boss-chat-typing-dots span:nth-child(3) {
  animation-delay: 0.32s;
}

@keyframes boss-chat-typing-bounce {
  0%,
  80%,
  100% {
    transform: translateY(0);
    opacity: 0.45;
  }
  40% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

.boss-chat-composer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px 14px;
  border-top: 1px solid var(--boss-chat-line);
  background: var(--boss-chat-bg-2);
}

.boss-chat-input {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  min-height: 72px;
  max-height: 220px;
  background: var(--boss-chat-surface);
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 10px;
  color: var(--boss-chat-text);
  -webkit-text-fill-color: var(--boss-chat-text);
  caret-color: var(--boss-chat-text);
  padding: 11px 12px;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.45;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.35);
}

.boss-chat-input::placeholder {
  color: rgba(255, 255, 255, 0.45);
  opacity: 1;
}

.boss-chat-input:focus {
  outline: none;
  border-color: var(--boss-chat-accent);
  box-shadow:
    inset 0 1px 3px rgba(0, 0, 0, 0.35),
    0 0 0 2px rgba(70, 209, 96, 0.22);
}

.boss-chat-composer-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.boss-chat-mode-select {
  width: 130px;
  flex-shrink: 0;
}

.boss-chat-main :deep(.boss-chat-mode-select .n-base-selection) {
  background: var(--boss-chat-surface) !important;
  border: 1px solid rgba(255, 255, 255, 0.28) !important;
  border-radius: 999px !important;
}

.boss-chat-main :deep(.boss-chat-mode-select .n-base-selection-label),
.boss-chat-main :deep(.boss-chat-mode-select .n-base-selection-input) {
  color: var(--boss-chat-text) !important;
}

.boss-chat-main :deep(.boss-chat-mode-select .n-base-selection:hover),
.boss-chat-main :deep(.boss-chat-mode-select .n-base-selection--focus) {
  border-color: var(--boss-chat-accent) !important;
  box-shadow: 0 0 0 2px rgba(70, 209, 96, 0.18) !important;
}

.boss-chat-send {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  border-radius: 999px;
  border: none;
  background: var(--boss-chat-accent);
  color: #102016;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
  flex-shrink: 0;
}

.boss-chat-send:hover:not(:disabled) {
  filter: brightness(1.05);
}

.boss-chat-send:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.boss-chat-panel-enter-active,
.boss-chat-panel-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.boss-chat-panel-enter-from,
.boss-chat-panel-leave-to {
  opacity: 0;
  transform: translateY(12px) scale(0.98);
}

@media (max-width: 860px) {
  .boss-chat-panels {
    grid-template-columns: 1fr !important;
    grid-template-rows: auto auto 1fr;
  }

  .boss-chat-side-menu {
    border-bottom: none;
    padding-top: 12px;
  }

  .boss-chat-agents,
  .boss-chat-threads {
    max-height: 120px;
    border-right: none;
    border-bottom: 1px solid var(--boss-chat-line);
  }

  .boss-chat-agent-list,
  .boss-chat-thread-list {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 10px;
  }

  .boss-chat-agent-item,
  .boss-chat-thread-item {
    min-width: 160px;
    margin-bottom: 0;
  }

  .boss-chat-agent-actions,
  .boss-chat-thread-actions {
    opacity: 1;
    flex-direction: row;
  }
}
</style>
