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
  AttachOutline,
} from '@vicons/ionicons5'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useTheme } from '@/composables/useTheme'
import { useOfficeProfile } from '@/composables/useOfficeProfile'
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
import VoiceMicButton from '@/components/voice/VoiceMicButton.vue'
import { useTTSSettings } from '@/composables/useTTSSettings'
import { useVoiceOutput } from '@/composables/useVoiceOutput'
import { useVoiceWake } from '@/composables/useVoiceWake'
import { useVoice2 } from '@/composables/useVoice2'
import { useStreamingVoiceOutput } from '@/composables/useStreamingVoiceOutput'
interface PendingAttachment {
  path: string
  name: string
  sizeLabel?: string
}

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
  pendingAttachmentId?: string
  attachmentFileName?: string | null
  attachmentResolved?: boolean
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
  boss: 'You',
  secretary: 'COO',
  ceo: 'COO',
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
const { isDark } = useTheme()
const officeProfile = useOfficeProfile()
const boss = useBossStore()
const aiSetup = useAiSetupStore()
const officeShare = useOfficeShareStore()
const wsStore = useWebSocketStore()
const chatStore = useChatStore()
const sessionStore = useSessionStore()
const router = useRouter()
const message = useMessage()
const { settings: ttsSettings } = useTTSSettings()
const { speak: voiceSpeak, stop: voiceStop } = useVoiceOutput()
const { mode: voiceWakeMode } = useVoiceWake()
const { pushDelta, resetStream } = useStreamingVoiceOutput()
const lastSpokenChatId = ref('')
const lastStreamContentLen = ref(0)
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
const pendingAttachments = ref<PendingAttachment[]>([])
const pendingAttachmentChoices = computed(() =>
  chat.value.filter((m) => m.pendingAttachmentId && !m.attachmentResolved),
)
const fileInputRef = ref<HTMLInputElement | null>(null)
const uploadingAttachment = ref(false)

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
    chatEvents.addEventListener('ceoDecision', () => {
      void poll()
    })
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
  const list = agents.value.filter((a) => !a.external && (a.role === 'coo' || a.role === 'secretary'))
  const pinSet = new Set(pinnedIds.value)
  return [...list].sort((a, b) => {
    const ap = pinSet.has(a.id) ? 0 : 1
    const bp = pinSet.has(b.id) ? 0 : 1
    if (ap !== bp) return ap - bp
    return a.label.localeCompare(b.label)
  })
})

const selectedAgent = computed(
  () => listAgents.value.find((a) => a.id === selectedAgentId.value) || null,
)

const composerTargetLabel = computed(() => {
  const a = selectedAgent.value
  if (!a) return 'COO'
  return a.label
})

const activeThread = computed(
  () => threads.value.find((t) => t.id === selectedThreadId.value) || null,
)

const agentIsWorking = computed(() => selectedAgent.value?.npcState === 'working')

function openClawAgentIdFor(agent: OfficeAgent | null | undefined): string | null {
  if (!agent || agent.external) return null
  if (agent.openclawAgentId) return agent.openclawAgentId
  if (agent.role === 'coo' || agent.role === 'secretary') return 'main'
  return null
}

const selectedOpenClawAgentId = computed(() => openClawAgentIdFor(selectedAgent.value))

const useOpenClawBossChat = computed(() => {
  // 语音线程的消息存在 boss-chat-store（不是 OpenClaw 会话）→ 必须用 legacy 渲染器才看得到。
  const vt = threads.value.find((t) => t.id === selectedThreadId.value)
  if (vt && typeof vt.title === 'string' && vt.title.startsWith('语音')) return false
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

function agentForId(agentId: string): OfficeAgent | undefined {
  return agents.value.find((a) => a.id === agentId || a.role === agentId)
}

function threadAgentKeys(agent: OfficeAgent | null | undefined): Set<string> {
  const keys = new Set<string>()
  if (!agent) return keys
  keys.add(agent.id)
  if (agent.role) keys.add(agent.role)
  if (agent.userAgentId) {
    keys.add(agent.userAgentId)
    keys.add(`user:${agent.userAgentId}`)
  }
  return keys
}

function threadMatchesAgent(thread: ChatThread, agentId: string): boolean {
  if (!agentId) return true
  if (thread.agentId === agentId) return true
  const agent = agentForId(agentId)
  if (!agent) return false
  return threadAgentKeys(agent).has(thread.agentId)
}

function ensureDefaultAgent() {
  if (selectedAgentId.value && listAgents.value.some((a) => a.id === selectedAgentId.value)) return
  const coo = listAgents.value.find((a) => a.role === 'coo' || a.role === 'secretary')
  selectedAgentId.value = coo?.id || listAgents.value[0]?.id || ''
}

function ensureDefaultThread() {
  if (!selectedAgentId.value) {
    if (selectedThreadId.value && threads.value.some((t) => t.id === selectedThreadId.value)) return
    selectedThreadId.value = threads.value[0]?.id || ''
    return
  }
  const current = selectedThreadId.value
    ? threads.value.find((t) => t.id === selectedThreadId.value)
    : null
  if (current && threadMatchesAgent(current, selectedAgentId.value)) return

  const saved = loadThreadMap()[selectedAgentId.value]
  if (saved) {
    const savedThread = threads.value.find(
      (t) => t.id === saved && threadMatchesAgent(t, selectedAgentId.value),
    )
    if (savedThread) {
      selectedThreadId.value = saved
      return
    }
  }
  const forAgent = threads.value.find((t) => threadMatchesAgent(t, selectedAgentId.value))
  selectedThreadId.value = forAgent?.id || ''
}

const agentThreads = computed(() => {
  const list = !selectedAgentId.value
    ? threads.value
    : threads.value.filter((t) => threadMatchesAgent(t, selectedAgentId.value))
  // 用固定的 createdAt 稳定排序（新→旧）；不按 updatedAt，避免 COO working 时列表一直跳。
  return [...list].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
})

function threadAgentLabel(thread: ChatThread) {
  const agent =
    agents.value.find((a) => a.id === thread.agentId || a.role === thread.agentId) ||
    agentForId(thread.agentId)
  return agent?.label || thread.agentId
}

function formatThreadTime(thread: ChatThread) {
  const ts = thread.updatedAt || thread.createdAt
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return time
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const date = `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`
  return `${date} ${time}`
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

function onVoiceInput(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return
  chatText.value = trimmed
  if (voiceWakeMode.value === 'active' || voiceWakeMode.value === 'speaking') {
    void sendBossChat()
  }
}

function onVoiceError(err: string) {
  message.warning(err)
}

function maybeAutoPlayBossReply(msgs: ChatMsg[]) {
  if (!ttsSettings.value.enabled || !ttsSettings.value.autoPlay) return
  const last = msgs[msgs.length - 1]
  if (!last?.text?.trim() || last.from === 'boss') return
  const key = `${last.id}:${last.ts}`
  if (lastSpokenChatId.value === key) return
  lastSpokenChatId.value = key
  void voiceSpeak(last.text).catch(() => {})
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
    if (selectedAgentId.value) {
      snap = await api.get<OfficeSnapshot>(`/api/office/snapshot${snapshotQuery()}`)
      if (snap.threads?.length) threads.value = snap.threads
      chat.value = snap.chat || []
      if (!useOpenClawBossChat.value) {
        const nextChat = chat.value
        if (nextChat.length !== lastChatLen.value) {
          lastChatLen.value = nextChat.length
          maybeAutoPlayBossReply(nextChat)
          await nextTick()
          scrollChatIfNeeded()
        }
      }
    } else if (!useOpenClawBossChat.value) {
      const nextChat = snap.chat || []
      if (nextChat.length !== lastChatLen.value) {
        chat.value = nextChat
        lastChatLen.value = nextChat.length
        maybeAutoPlayBossReply(nextChat)
        await nextTick()
        scrollChatIfNeeded()
      } else {
        chat.value = nextChat
      }
    }
    if (snap.activeThreadId && !selectedThreadId.value) {
      const active = threads.value.find((t) => t.id === snap.activeThreadId)
      if (active && threadMatchesAgent(active, selectedAgentId.value)) {
        selectedThreadId.value = snap.activeThreadId
      }
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
  selectedThreadId.value =
    saved && threads.value.some((t) => t.id === saved && threadMatchesAgent(t, id)) ? saved : ''
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
  const agent = agentForId(thread.agentId)
  if (agent) selectedAgentId.value = agent.id
  selectedThreadId.value = thread.id
  saveThreadForAgent(selectedAgentId.value, thread.id)
  void loadOpenClawSession()
}

function selectThread(id: string) {
  const thread = threads.value.find((t) => t.id === id)
  if (thread) {
    const agent = agentForId(thread.agentId)
    if (agent) selectedAgentId.value = agent.id
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
  const thread = threads.value.find((t) => t.id === selectedThreadId.value)
  if (!thread || !threadMatchesAgent(thread, selectedAgentId.value)) return
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
    const msg = e instanceof Error ? e.message : 'Could not load OpenClaw session'
    // 语音线程没有 OpenClaw 会话 → 404 是正常的，别弹红色错误提示。
    if (!/no OpenClaw runtime|404|not found/i.test(msg)) {
      message.error(msg)
    }
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

function clearVoiceThreads() {
  const voiceThreads = threads.value.filter((t) => typeof t.title === 'string' && t.title.startsWith('语音'))
  if (!voiceThreads.length) { message.info('没有语音对话可清空'); return }
  dialog.warning({
    title: '清空语音对话',
    content: `确定删除全部 ${voiceThreads.length} 条「语音」对话吗？不可撤销。`,
    positiveText: '清空',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const res = await api.send<{ ok: boolean; removed?: number }>('POST', '/api/voice2/clear-threads', {})
        threads.value = threads.value.filter((t) => !(typeof t.title === 'string' && t.title.startsWith('语音')))
        if (selectedThreadId.value && !threads.value.some((t) => t.id === selectedThreadId.value)) {
          selectedThreadId.value = threads.value[0]?.id || ''
          chat.value = []
          lastChatLen.value = 0
        }
        await poll()
        message.success(`已清空 ${res?.removed ?? voiceThreads.length} 条语音对话`)
      } catch (e) {
        message.error(e instanceof Error ? e.message : '清空失败')
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
  const attachments = [...pendingAttachments.value]
  if ((!text && !attachments.length) || sending.value) return
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
      text: text || undefined,
      mode: chatMode.value,
      targetAgentId: selectedAgentId.value || undefined,
      threadId: selectedThreadId.value || undefined,
      attachments: attachments.length ? attachments : undefined,
    })
    if (res.queued && res.queuePosition) {
      queueHint.value = `Queued (position ${res.queuePosition})`
    }
    chatText.value = ''
    pendingAttachments.value = []
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

function triggerAttach() {
  if (sending.value || uploadingAttachment.value || !selectedAgentId.value) return
  fileInputRef.value?.click()
}

function removePendingAttachment(path: string) {
  pendingAttachments.value = pendingAttachments.value.filter((a) => a.path !== path)
}

const resolvingAttachmentId = ref<string | null>(null)

async function resolveAttachmentChoice(pendingId: string, mode: 'archive' | 'reference') {
  if (resolvingAttachmentId.value) return
  resolvingAttachmentId.value = pendingId
  try {
    const res = await api.send<{ ok: boolean; status?: string; error?: string; path?: string; chunks?: number }>(
      'POST',
      '/api/inbound/attachment/resolve',
      {
        pendingId,
        mode,
        threadId: selectedThreadId.value || undefined,
        agentId: selectedAgentId.value || undefined,
      },
    )
    if (!res.ok) {
      message.error(res.error || 'Could not process attachment')
      return
    }
    await poll()
    if (res.status === 'reference') {
      message.success(`Added as reference (${res.chunks || 0} chunks indexed)`)
    } else if (res.status === 'ingested') {
      message.success('Saved to Admin Vault inbox')
    } else if (res.status === 'duplicate') {
      message.info('Already in inbox')
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : 'Could not process attachment')
  } finally {
    resolvingAttachmentId.value = null
  }
}

async function onFilesSelected(e: Event) {
  const input = e.target as HTMLInputElement
  const files = input.files ? Array.from(input.files) : []
  input.value = ''
  if (!files.length) return

  uploadingAttachment.value = true
  const source = useOpenClawBossChat.value ? 'boss_chat_openclaw' : 'boss_chat_native'
  try {
    for (const file of files) {
      const form = new FormData()
      form.append('file', file)
      form.append('source', source)
      if (selectedThreadId.value) form.append('threadId', selectedThreadId.value)
      if (selectedAgentId.value) form.append('agentId', selectedAgentId.value)
      const res = await api.sendForm<{
        ok: boolean
        status?: string
        pendingId?: string
        fileName?: string
        attachment?: PendingAttachment
        path?: string
        error?: string
      }>('POST', '/api/inbound/attachment', form)
      if (res.status === 'duplicate') {
        message.info(`Already in inbox: ${res.attachment?.name || file.name}`)
        continue
      }
      if (res.status === 'pending_choice') {
        continue
      }
      if (!res.ok) {
        message.error(res.error || `Could not save ${file.name}`)
        continue
      }
      if (res.attachment?.path) {
        pendingAttachments.value = [
          ...pendingAttachments.value,
          {
            path: res.attachment.path,
            name: res.attachment.name || file.name,
            sizeLabel: res.attachment.sizeLabel,
          },
        ]
      }
    }
    if (files.length) {
      await poll()
      const staged = pendingAttachmentChoices.value.length > 0
      message.success(
        staged
          ? 'File uploaded — choose Archive or Reference below'
          : files.length === 1
            ? 'File saved to Admin Vault inbox'
            : `${files.length} files saved to inbox`,
      )
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : 'Could not upload file')
  } finally {
    uploadingAttachment.value = false
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

watch(openClawSessionKey, () => {
  lastStreamContentLen.value = 0
  resetStream()
  voiceStop()
})

watch(
  () =>
    [
      chatMode.value,
      openClawSessionKey.value,
      chatStore.sending,
      chatStore.messages.map((m) => `${m.id || ''}:${m.role}:${String(m.content || '').length}`).join('|'),
      selectedOpenClawAgentId.value,
    ].join('::'),
  () => {
    void maybeSavePlanDeliverable()
    void maybeUpdateThreadTitleFromGateway()
    if (!useOpenClawBossChat.value) return
    if (!ttsSettings.value.enabled) return

    const agentId = selectedOpenClawAgentId.value || 'main'
    const phase = chatStore.getOrCreateAgentStatus(agentId).phase
    const last = [...chatStore.messages].reverse().find((m) => m.role === 'assistant' && String(m.content || '').trim())
    const content = String(last?.content || '')

    if (ttsSettings.value.streamingTts && (phase === 'replying' || phase === 'thinking' || chatStore.sending)) {
      if (content.length > lastStreamContentLen.value) {
        pushDelta(content.slice(lastStreamContentLen.value), false)
        lastStreamContentLen.value = content.length
      }
      return
    }

    if (ttsSettings.value.streamingTts && (phase === 'done' || phase === 'idle' || phase === 'error')) {
      if (content.length > lastStreamContentLen.value) {
        pushDelta(content.slice(lastStreamContentLen.value), true)
      } else if (lastStreamContentLen.value > 0) {
        pushDelta('', true)
      }
      lastStreamContentLen.value = 0
      return
    }

    if (!ttsSettings.value.autoPlay) return
    if (!last) return
    const key = `oc:${last.id || ''}:${content.length}`
    if (lastSpokenChatId.value === key || chatStore.sending) return
    lastSpokenChatId.value = key
    void voiceSpeak(content).catch(() => {})
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

// 语音召唤新建对话时，自动打开 Boss Chat 并跳到那条线程，实时看对话冒出来。
const { activeVoiceThreadId } = useVoice2()
const isVoiceThread = computed(() => {
  const t = threads.value.find((x) => x.id === selectedThreadId.value)
  return !!(t && typeof t.title === 'string' && t.title.startsWith('语音'))
})
watch(activeVoiceThreadId, async (id) => {
  // 不主动弹开 Boss Chat；只有窗口已经开着时，才自动跳到这条新语音对话。
  if (!id || !open.value) return
  await poll() // 先刷新线程列表，确保新线程已加载
  selectThread(id)
  void nextTick(() => scrollChatIfNeeded(true))
})
// 语音对话：来新消息就自动滚到底部（免手动下拉）
watch(() => chat.value.length, () => {
  if (isVoiceThread.value) void nextTick(() => scrollChatIfNeeded(true))
})

onMounted(() => {
  scopeKey.value = boss.chatOwnerKey
  reloadScopePrefs()
  void officeShare.refresh()
  void officeProfile.load()
  startPoll()
})
onUnmounted(stopPoll)
</script>

<template>
  <div class="bcm">
    <!-- FAB -->
    <button
      v-show="!open"
      type="button"
      class="bcm-fab"
      aria-label="Open Boss Chat"
      @click="toggleOpen"
    >
      <NIcon :component="ChatbubblesOutline" :size="22" />
    </button>

    <Transition name="bcm-slide">
      <div v-if="open" class="bcm-panel" :class="{ 'bcm-panel--light': !isDark }" role="dialog" aria-label="Boss Chat">

        <!-- ── Header ── -->
        <header class="bcm-header">
          <div class="bcm-header-left">
            <span class="bcm-header-title">Boss Chat</span>
            <span v-if="scopeName" class="bcm-header-scope">{{ scopeName }}</span>
            <span class="bcm-status-dot" :class="{ live: connected }" />
          </div>
          <button type="button" class="bcm-close-btn" title="Close" @click="open = false">
            <NIcon :component="CloseOutline" :size="18" />
          </button>
        </header>

        <!-- ── Body: sidebar + main ── -->
        <div class="bcm-body">

          <!-- Left sidebar -->
          <aside class="bcm-sidebar">

            <!-- Agents section -->
            <div class="bcm-section-head">
              <span>Team</span>
              <button type="button" class="bcm-add-btn" title="Add agent" @click="addAgent">
                <NIcon :component="AddOutline" :size="14" />
              </button>
            </div>
            <ul class="bcm-agent-list">
              <li
                v-for="a in listAgents"
                :key="a.id"
                class="bcm-agent-item"
                :class="{ active: selectedAgentId === a.id }"
              >
                <button type="button" class="bcm-agent-btn" @click="selectAgent(a.id)">
                  <span class="bcm-avatar">{{ a.label.slice(0, 1).toUpperCase() }}</span>
                  <span class="bcm-agent-info">
                    <span class="bcm-agent-name">{{ a.label }}</span>
                    <span class="bcm-agent-role">
                      {{ a.npcState === 'working' ? '⚙ working' : a.role.replace(/_/g, ' ') }}
                      <span v-if="openClawAgentIdFor(a)" class="bcm-oc-badge">AI</span>
                    </span>
                  </span>
                </button>
                <div class="bcm-agent-actions">
                  <button
                    type="button"
                    class="bcm-icon-btn"
                    :class="{ active: isPinned(a.id) }"
                    title="Pin"
                    @click.stop="togglePin(a.id)"
                  >
                    <NIcon :component="PinOutline" :size="13" />
                  </button>
                  <button
                    v-if="a.userAgentId"
                    type="button"
                    class="bcm-icon-btn danger"
                    title="Remove"
                    @click.stop="confirmRemove(a)"
                  >
                    <NIcon :component="TrashOutline" :size="13" />
                  </button>
                </div>
              </li>
            </ul>
            <p v-if="!listAgents.length" class="bcm-empty-hint">No agents yet.</p>

            <!-- Divider -->
            <div class="bcm-divider" />

            <!-- Threads section -->
            <div class="bcm-section-head">
              <span>Chats</span>
              <span style="display:flex; gap:4px;">
                <button
                  type="button"
                  class="bcm-add-btn"
                  title="清空所有语音对话"
                  @click="clearVoiceThreads"
                >
                  <NIcon :component="TrashOutline" :size="14" />
                </button>
                <button
                  type="button"
                  class="bcm-add-btn"
                  title="New chat"
                  :disabled="!selectedAgentId"
                  @click="newChat"
                >
                  <NIcon :component="AddOutline" :size="14" />
                </button>
              </span>
            </div>
            <ul class="bcm-thread-list">
              <li
                v-for="t in agentThreads"
                :key="t.id"
                class="bcm-thread-item"
                :class="{ active: selectedThreadId === t.id }"
              >
                <button type="button" class="bcm-thread-btn" @click="selectThread(t.id)">
                  <span class="bcm-thread-title">{{ t.title }}</span>
                  <span class="bcm-thread-meta">{{ threadMetaLabel(t) }}</span>
                  <span v-if="formatThreadTime(t)" class="bcm-thread-time">{{ formatThreadTime(t) }}</span>
                </button>
                <div class="bcm-thread-actions">
                  <button
                    type="button"
                    class="bcm-icon-btn"
                    :class="{ active: isThreadPinned(t.id) }"
                    title="Pin"
                    @click.stop="toggleThreadPin(t)"
                  >
                    <NIcon :component="PinOutline" :size="13" />
                  </button>
                  <button
                    type="button"
                    class="bcm-icon-btn danger"
                    title="Delete"
                    @click.stop="confirmDeleteThread(t)"
                  >
                    <NIcon :component="TrashOutline" :size="13" />
                  </button>
                </div>
              </li>
            </ul>
            <p v-if="!agentThreads.length" class="bcm-empty-hint">No chats yet. Select an agent and press +.</p>
          </aside>

          <!-- Main chat area -->
          <section class="bcm-main">

            <!-- Thread / target bar -->
            <div class="bcm-thread-bar">
              <span class="bcm-thread-bar-title">
                {{ activeThread?.title || composerTargetLabel }}
              </span>
              <div class="bcm-thread-bar-tags">
                <span v-if="selectedAgent?.role === 'secretary' || selectedAgent?.role === 'coo'" class="bcm-tag green">COO</span>
                <span v-if="useOpenClawBossChat" class="bcm-tag blue">OpenClaw</span>
                <span v-if="chatMode === 'plan'" class="bcm-tag yellow">Plan</span>
                <NSelect
                  v-if="selectedAgent?.role === 'secretary' || selectedAgent?.role === 'coo'"
                  v-model:value="chatMode"
                  class="bcm-mode-select"
                  :options="modeOptions"
                  size="small"
                  :consistent-menu-width="false"
                />
              </div>
            </div>

            <input
              ref="fileInputRef"
              type="file"
              class="bcm-file-input"
              accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt,.md"
              multiple
              @change="onFilesSelected"
            />

            <!-- OpenClaw mode -->
            <div v-if="useOpenClawBossChat" class="bcm-openclaw-wrap">
              <p v-if="!gatewayConnected" class="bcm-gateway-warn">
                OpenClaw Gateway disconnected — reconnect from the header or restart <code>npm run dev:all</code>.
              </p>
              <p v-else-if="openClawSessionLoading" class="bcm-hint-center">Loading session…</p>
              <template v-else-if="openClawSessionKey">
                <div v-if="pendingAttachmentChoices.length" class="bcm-attach-choices">
                  <div v-for="m in pendingAttachmentChoices" :key="m.id" class="bcm-attach-card">
                    <span class="bcm-attach-label">{{ m.attachmentFileName || 'Attachment' }} — archive or reference?</span>
                    <div class="bcm-attach-btns">
                      <button type="button" class="bcm-attach-btn archive" :disabled="!!resolvingAttachmentId" @click="resolveAttachmentChoice(m.pendingAttachmentId!, 'archive')">存档</button>
                      <button type="button" class="bcm-attach-btn reference" :disabled="!!resolvingAttachmentId" @click="resolveAttachmentChoice(m.pendingAttachmentId!, 'reference')">参考</button>
                    </div>
                  </div>
                </div>
                <AgentChatPanel
                  :key="`${openClawSessionKey}:${chatMode}`"
                  compact
                  :plan-mode="chatMode === 'plan'"
                  :external-session-key="openClawSessionKey"
                  :external-thread-id="selectedThreadId || ''"
                  :title="activeThread?.title || composerTargetLabel"
                  :user-display-name="officeProfile.resolvedBossName.value"
                  :assistant-display-name="selectedAgent?.label || composerTargetLabel"
                >
                  <template #composer-actions>
                    <button
                      class="bcm-attach-trigger"
                      type="button"
                      :disabled="uploadingAttachment || !selectedAgentId"
                      :title="uploadingAttachment ? 'Uploading…' : 'Attach file'"
                      @click="triggerAttach"
                    >
                      <NIcon :component="AttachOutline" :size="16" />
                    </button>
                  </template>
                </AgentChatPanel>
              </template>
              <p v-else class="bcm-hint-center">Select or create a chat thread.</p>
            </div>

            <!-- Legacy chat mode -->
            <template v-else>
              <div ref="chatLogRef" class="bcm-log">
                <p v-if="queueHint" class="bcm-queue-notice">{{ queueHint }}</p>
                <div v-if="!chat.length && !agentActivityLabel" class="bcm-log-empty">
                  <NIcon :component="ChatbubblesOutline" :size="32" style="opacity:0.25" />
                  <span>Tell your team what to do.</span>
                </div>
                <div
                  v-for="m in chat"
                  :key="m.id"
                  class="bcm-msg"
                  :class="m.from"
                >
                  <div v-if="m.from === 'system'" class="bcm-msg-bubble">{{ m.text }}</div>
                  <div v-else class="bcm-msg-row">
                    <span class="bcm-msg-avatar" :class="m.from" :title="displayName(m)">{{ displayName(m).slice(0, 1).toUpperCase() }}</span>
                    <div class="bcm-msg-bubble">
                      {{ m.text }}
                      <div v-if="m.pendingAttachmentId && !m.attachmentResolved" class="bcm-attach-btns inline">
                        <button type="button" class="bcm-attach-btn archive" :disabled="!!resolvingAttachmentId" @click="resolveAttachmentChoice(m.pendingAttachmentId!, 'archive')">存档</button>
                        <button type="button" class="bcm-attach-btn reference" :disabled="!!resolvingAttachmentId" @click="resolveAttachmentChoice(m.pendingAttachmentId!, 'reference')">参考</button>
                      </div>
                    </div>
                  </div>
                </div>
                <div v-if="agentActivityLabel" class="bcm-typing">
                  <span class="bcm-typing-text">{{ agentActivityLabel }}</span>
                  <span class="bcm-dots" aria-hidden="true"><span /><span /><span /></span>
                </div>
              </div>

              <form class="bcm-composer" @submit.prevent="sendBossChat">
                <div v-if="pendingAttachments.length" class="bcm-chips">
                  <span v-for="a in pendingAttachments" :key="a.path" class="bcm-chip">
                    {{ a.name }}
                    <button type="button" @click="removePendingAttachment(a.path)">×</button>
                  </span>
                </div>
                <div class="bcm-composer-inner">
                  <textarea
                    v-model="chatText"
                    class="bcm-textarea"
                    rows="2"
                    placeholder="Message your COO… (Enter to send, Shift+Enter for newline)"
                    @keydown="onComposerKeydown"
                  />
                  <div class="bcm-composer-actions">
                    <NSelect
                      v-model:value="chatMode"
                      class="bcm-mode-select"
                      :options="modeOptions"
                      size="small"
                      :consistent-menu-width="false"
                    />
                    <VoiceMicButton size="small" :disabled="sending || !selectedAgentId" @result="onVoiceInput" @error="onVoiceError" />
                    <button type="button" class="bcm-tool-btn" :disabled="sending || uploadingAttachment || !selectedAgentId" title="Attach file" @click="triggerAttach">
                      <NIcon :component="AttachOutline" :size="16" />
                    </button>
                    <button
                      type="submit"
                      class="bcm-send-btn"
                      :disabled="sending || (!chatText.trim() && !pendingAttachments.length) || !selectedAgentId"
                    >
                      <NIcon :component="PaperPlaneOutline" :size="15" />
                      <span>{{ sending ? 'Sending…' : 'Send' }}</span>
                    </button>
                  </div>
                </div>
              </form>
            </template>
          </section>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* ─── Root wrapper ─── */
.bcm {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 1100;
}

.bcm-fab,
.bcm-panel {
  pointer-events: auto;
}

/* ─── FAB ─── */
.bcm-fab {
  position: fixed;
  right: 24px;
  bottom: 24px;
  width: 52px;
  height: 52px;
  border: none;
  border-radius: 50%;
  background: #2563eb;
  color: #fff;
  box-shadow: 0 6px 20px rgba(37, 99, 235, 0.5);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.15s, box-shadow 0.15s;
}
.bcm-fab:hover {
  transform: scale(1.07);
  box-shadow: 0 8px 24px rgba(37, 99, 235, 0.6);
}

/* ─── Panel ─── */
.bcm-panel {
  --bg: #0f1117;
  --bg2: #161921;
  --surface: #1d2130;
  --border: rgba(255,255,255,0.1);
  --text: #e8eaf0;
  --muted: rgba(255,255,255,0.45);
  --accent: #3b82f6;
  --accent-dim: rgba(59,130,246,0.15);
  --green: #22c55e;
  --green-dim: rgba(34,197,94,0.14);

  position: fixed;
  right: 20px;
  bottom: 20px;
  width: min(900px, calc(100vw - 40px));
  height: min(calc(100vh - var(--header-height, 64px) - 40px), 760px);
  max-height: calc(100vh - var(--header-height, 64px) - 40px);
  display: flex;
  flex-direction: column;
  color-scheme: dark;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05);
}

/* ─── Header ─── */
.bcm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg2);
  flex-shrink: 0;
}

.bcm-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.bcm-header-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.01em;
}

.bcm-header-scope {
  font-size: 12px;
  color: var(--muted);
}

.bcm-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(255,255,255,0.2);
  flex-shrink: 0;
}
.bcm-status-dot.live {
  background: var(--green);
  box-shadow: 0 0 6px rgba(34,197,94,0.6);
}

.bcm-close-btn {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s, color 0.12s;
}
.bcm-close-btn:hover {
  background: rgba(255,255,255,0.07);
  color: var(--text);
}

/* ─── Body grid ─── */
.bcm-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 220px 1fr;
}

/* ─── Sidebar ─── */
.bcm-sidebar {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--bg2);
  min-height: 0;
  overflow: hidden;
}

.bcm-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 8px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  flex-shrink: 0;
}

.bcm-add-btn {
  width: 22px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.bcm-add-btn:hover:not(:disabled) {
  background: var(--accent-dim);
  border-color: var(--accent);
  color: var(--accent);
}
.bcm-add-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.bcm-divider {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
  flex-shrink: 0;
}

/* Agent list */
.bcm-agent-list {
  list-style: none;
  margin: 0;
  padding: 0 6px 4px;
  overflow-y: auto;
  flex-shrink: 0;
  max-height: 160px;
}

.bcm-agent-item {
  display: flex;
  align-items: center;
  gap: 2px;
  border-radius: 8px;
  margin-bottom: 1px;
}
.bcm-agent-item.active {
  background: var(--accent-dim);
}
.bcm-agent-item:hover:not(.active) {
  background: rgba(255,255,255,0.04);
}

.bcm-agent-btn {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 8px;
  text-align: left;
}

.bcm-avatar {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: linear-gradient(135deg, #2563eb, #1d4ed8);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}

.bcm-agent-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.bcm-agent-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bcm-agent-role {
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
  gap: 4px;
}

.bcm-oc-badge {
  font-size: 9px;
  font-weight: 700;
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(59,130,246,0.2);
  color: #93c5fd;
  letter-spacing: 0.03em;
}

.bcm-agent-actions,
.bcm-thread-actions {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-right: 4px;
  opacity: 0;
  transition: opacity 0.12s;
}
.bcm-agent-item:hover .bcm-agent-actions,
.bcm-agent-item.active .bcm-agent-actions,
.bcm-thread-item:hover .bcm-thread-actions,
.bcm-thread-item.active .bcm-thread-actions {
  opacity: 1;
}

.bcm-icon-btn {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.1s, color 0.1s;
}
.bcm-icon-btn:hover {
  background: rgba(255,255,255,0.07);
  color: var(--text);
}
.bcm-icon-btn.active {
  color: var(--accent);
}
.bcm-icon-btn.danger:hover {
  color: #f87171;
}

/* Thread list */
.bcm-thread-list {
  list-style: none;
  margin: 0;
  padding: 0 6px 8px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.bcm-thread-item {
  display: flex;
  align-items: center;
  gap: 2px;
  border-radius: 8px;
  margin-bottom: 1px;
}
.bcm-thread-item.active {
  background: var(--accent-dim);
}
.bcm-thread-item:hover:not(.active) {
  background: rgba(255,255,255,0.04);
}

.bcm-thread-btn {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 7px 8px;
  border-radius: 8px;
  text-align: left;
}

.bcm-thread-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bcm-thread-meta {
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bcm-thread-time {
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
}

.bcm-empty-hint {
  padding: 6px 12px 10px;
  font-size: 11px;
  color: var(--muted);
  margin: 0;
  line-height: 1.4;
}

/* ─── Main area ─── */
.bcm-main {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--bg);
}

.bcm-thread-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.bcm-thread-bar-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bcm-thread-bar-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.bcm-tag {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 99px;
  letter-spacing: 0.02em;
}
.bcm-tag.green {
  background: var(--green-dim);
  color: var(--green);
}
.bcm-tag.blue {
  background: var(--accent-dim);
  color: #93c5fd;
}
.bcm-tag.yellow {
  background: rgba(234,179,8,0.15);
  color: #fde047;
}

.bcm-mode-select {
  width: 110px;
}

.bcm-main :deep(.bcm-mode-select .n-base-selection) {
  background: var(--surface) !important;
  border: 1px solid var(--border) !important;
  border-radius: 99px !important;
}
.bcm-main :deep(.bcm-mode-select .n-base-selection-label),
.bcm-main :deep(.bcm-mode-select .n-base-selection-input) {
  color: var(--text) !important;
  font-size: 12px !important;
}
.bcm-main :deep(.bcm-mode-select .n-base-selection:hover),
.bcm-main :deep(.bcm-mode-select .n-base-selection--focus) {
  border-color: var(--accent) !important;
}

.bcm-file-input { display: none; }

/* OpenClaw wrap */
.bcm-openclaw-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 8px 8px;
}
.bcm-openclaw-wrap :deep(.chat-actions) { align-items: center; }
.bcm-openclaw-wrap :deep(.chat-panel-card) {
  border: none;
  box-shadow: none;
  background: transparent;
}

.bcm-gateway-warn {
  margin: 14px;
  padding: 12px 14px;
  font-size: 12px;
  line-height: 1.5;
  color: #fde68a;
  background: rgba(234,179,8,0.1);
  border: 1px solid rgba(234,179,8,0.3);
  border-radius: 8px;
}
.bcm-gateway-warn code { font-size: 11px; }

.bcm-hint-center {
  margin: auto;
  font-size: 13px;
  color: var(--muted);
  text-align: center;
}

/* Attach choices */
.bcm-attach-choices {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 8px 0;
  flex-shrink: 0;
}
.bcm-attach-card {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--green-dim);
  border: 1px solid rgba(34,197,94,0.25);
}
.bcm-attach-label { flex: 1; font-size: 12px; color: var(--text); min-width: 140px; }
.bcm-attach-btns { display: flex; gap: 6px; }
.bcm-attach-btns.inline { margin-top: 8px; }
.bcm-attach-btn {
  border: none;
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
}
.bcm-attach-btn.archive { background: var(--green-dim); color: var(--green); }
.bcm-attach-btn.reference { background: var(--accent-dim); color: #93c5fd; }
.bcm-attach-btn:disabled { opacity: 0.45; cursor: not-allowed; }

/* OpenClaw attach trigger */
.bcm-attach-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.bcm-attach-trigger:hover:not(:disabled) { color: var(--text); border-color: var(--accent); }
.bcm-attach-trigger:disabled { opacity: 0.4; cursor: not-allowed; }

/* ─── Chat log ─── */
.bcm-log {
  flex: 1;
  overflow-y: auto;
  padding: 16px 16px 8px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  background: #ededed; /* 微信聊天背景浅灰 */
}

.bcm-log-empty {
  margin: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  color: var(--muted);
  font-size: 13px;
}

.bcm-queue-notice {
  margin: 0;
  padding: 7px 12px;
  border-radius: 8px;
  background: rgba(234,179,8,0.1);
  border: 1px solid rgba(234,179,8,0.3);
  color: #fde68a;
  font-size: 12px;
  flex-shrink: 0;
}

.bcm-msg {
  display: flex;
  max-width: 100%;
}
.bcm-msg.boss { justify-content: flex-end; }
.bcm-msg.system { justify-content: center; max-width: 100%; }

/* 微信式：头像 + 气泡一行；自己的整行靠右、头像在右 */
.bcm-msg-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 82%;
}
.bcm-msg.boss .bcm-msg-row { flex-direction: row-reverse; }

.bcm-msg-avatar {
  width: 34px;
  height: 34px;
  border-radius: 6px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 700;
  color: #fff;
  background: #8a93a6;
}
.bcm-msg-avatar.boss { background: #4f9cf9; }
.bcm-msg-avatar.coo,
.bcm-msg-avatar.secretary { background: #07c160; }
.bcm-msg-avatar.it { background: #7c3aed; }

.bcm-msg-bubble {
  position: relative;
  padding: 9px 12px;
  border-radius: 6px;
  font-size: 14px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  color: #111;
  background: #fff;
  border: 1px solid #e6e6e6;
}

/* 对方气泡（左）：白底 + 指向左头像的小三角 */
.bcm-msg.coo .bcm-msg-bubble::before,
.bcm-msg.secretary .bcm-msg-bubble::before,
.bcm-msg.it .bcm-msg-bubble::before {
  content: '';
  position: absolute;
  left: -5px;
  top: 12px;
  border: 5px solid transparent;
  border-right-color: #fff;
}

/* 自己气泡（右）：微信绿 + 指向右头像的小三角 */
.bcm-msg.boss .bcm-msg-bubble {
  background: #95ec69;
  color: #111;
  border-color: #86dd5d;
}
.bcm-msg.boss .bcm-msg-bubble::before {
  content: '';
  position: absolute;
  right: -5px;
  top: 12px;
  border: 5px solid transparent;
  border-left-color: #95ec69;
}

.bcm-msg.system .bcm-msg-bubble {
  background: transparent;
  border: 1px dashed var(--border);
  color: var(--muted);
  font-size: 11px;
  text-align: center;
}

/* Typing indicator */
.bcm-typing {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 13px;
  border-radius: 12px 12px 12px 2px;
  background: var(--surface);
  border: 1px solid var(--border);
  font-size: 12px;
  color: var(--muted);
  align-self: flex-start;
  font-style: italic;
}

.bcm-dots {
  dis