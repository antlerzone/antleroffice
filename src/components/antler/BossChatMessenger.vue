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
import { useOfficeShareStore } from '@/stores/officeShare'

interface OfficeAgent {
  id: string
  label: string
  role: string
  npcState?: string
  userAgentId?: string | null
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
  messageCount: number
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
const officeShare = useOfficeShareStore()
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

const modeOptions = [
  { label: '⚡ Agent', value: 'agent' },
  { label: '📋 Plan', value: 'plan' },
]

let pollTimer: ReturnType<typeof setInterval> | null = null
let chatEvents: EventSource | null = null

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
  if (!selectedAgentId.value) return
  if (selectedThreadId.value && threads.value.some((t) => t.id === selectedThreadId.value)) return
  const saved = loadThreadMap()[selectedAgentId.value]
  if (saved && threads.value.some((t) => t.id === saved)) {
    selectedThreadId.value = saved
    return
  }
  selectedThreadId.value = threads.value[0]?.id || ''
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
    const snap = await api.get<OfficeSnapshot>(`/api/office/snapshot${snapshotQuery()}`)
    if (snap.ownerKey) scopeKey.value = snap.ownerKey
    if (snap.ownerName) scopeName.value = snap.ownerName
    else if (boss.session?.username) scopeName.value = boss.session.username

    agents.value = snap.agents || []
    threads.value = snap.threads || []
    const nextChat = snap.chat || []
    if (nextChat.length !== lastChatLen.value) {
      chat.value = nextChat
      lastChatLen.value = nextChat.length
      await nextTick()
      scrollChatIfNeeded()
    } else {
      chat.value = nextChat
    }
    ensureDefaultAgent()
    if (snap.activeThreadId && !selectedThreadId.value) {
      selectedThreadId.value = snap.activeThreadId
    }
    ensureDefaultThread()
    if (selectedThreadId.value) {
      saveThreadForAgent(selectedAgentId.value, selectedThreadId.value)
    }
    connected.value = true
  } catch {
    connected.value = false
  }
}

function startPoll() {
  stopPoll()
  void poll()
  connectEvents()
  pollTimer = setInterval(() => void poll(), open.value ? 8000 : 5000)
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
}

function selectThread(id: string) {
  selectedThreadId.value = id
  saveThreadForAgent(selectedAgentId.value, id)
  lastChatLen.value = 0
  connectEvents()
  void poll()
}

async function newChat() {
  if (!selectedAgentId.value) return
  try {
    const res = await api.send<{ ok: boolean; thread?: ChatThread }>('POST', '/api/boss-chats', {
      agentId: selectedAgentId.value,
    })
    if (res.thread) {
      threads.value = [res.thread, ...threads.value]
      selectThread(res.thread.id)
      chat.value = []
      lastChatLen.value = 0
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
    message.error(e instanceof Error ? e.message : 'Could not send')
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

watch(open, (v) => {
  startPoll()
  if (v) void nextTick(() => scrollChatIfNeeded(true))
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
                  <span class="boss-chat-thread-meta">{{ t.messageCount }} messages</span>
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
            <p v-if="selectedAgentId && !threads.length" class="boss-chat-agents-empty">
              No chats yet. Start one with +.
            </p>
          </aside>

          <section class="boss-chat-main">
            <div class="boss-chat-target-bar">
              <span v-if="activeThread">{{ activeThread.title }}</span>
              <span v-else>
                Chatting with <strong>{{ composerTargetLabel }}</strong>
              </span>
              <span v-if="selectedAgent?.role === 'coo'" class="boss-chat-default-tag">default</span>
            </div>
            <div ref="chatLogRef" class="chat-log">
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
              <p v-if="!chat.length" class="boss-chat-empty">Tell your team what to do — plain language.</p>
            </div>
            <form class="composer" @submit.prevent="sendBossChat">
              <textarea
                v-model="chatText"
                class="composer-input"
                rows="3"
                placeholder="e.g. Draft a welcome email for new customers…  (Enter to send · Shift+Enter for new line)"
                @keydown="onComposerKeydown"
              />
              <div class="composer-bar">
                <NSelect
                  v-model:value="chatMode"
                  class="composer-mode-select"
                  :options="modeOptions"
                  size="small"
                  :consistent-menu-width="false"
                />
                <button
                  class="composer-send"
                  type="submit"
                  :disabled="sending || !chatText.trim() || !selectedAgentId"
                  title="Send message"
                >
                  <NIcon :component="PaperPlaneOutline" :size="16" />
                  <span>{{ sending ? 'Sending…' : 'Send' }}</span>
                </button>
              </div>
            </form>
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
  z-index: 900;
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
  position: fixed;
  right: 20px;
  bottom: 20px;
  left: auto;
  width: min(1040px, calc(100vw - 40px));
  height: min(calc(100vh - var(--header-height, 64px) - 40px), 820px);
  max-height: calc(100vh - var(--header-height, 64px) - 40px);
  display: flex;
  flex-direction: column;
  background: var(--panel, #1e222d);
  border: 1px solid var(--line, rgba(255, 255, 255, 0.12));
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
}

.boss-chat-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line, rgba(255, 255, 255, 0.12));
  background: var(--panel-2, #252a36);
}

.boss-chat-panel-head strong {
  font-size: 15px;
}

.boss-chat-user-tag {
  margin-left: 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--boss-chat-muted, #888);
}

.boss-chat-conn {
  margin-left: 10px;
  font-size: 11px;
  color: var(--muted, rgba(255, 255, 255, 0.55));
}

.boss-chat-conn.ok {
  color: var(--accent-2, #46d160);
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
  color: var(--text, #e8eaed);
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
  color: var(--accent-2, #46d160);
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
  border-right: 1px solid var(--line, rgba(255, 255, 255, 0.12));
  background: var(--panel-2, #252a36);
}

.boss-chat-side-btn {
  width: 32px;
  min-height: 52px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--muted, rgba(255, 255, 255, 0.55));
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
  color: var(--text, #e8eaed);
}

.boss-chat-side-btn.active {
  background: rgba(70, 209, 96, 0.14);
  border-color: rgba(70, 209, 96, 0.35);
  color: var(--accent-2, #46d160);
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
  border-right: 1px solid var(--line, rgba(255, 255, 255, 0.12));
  background: var(--panel, #1e222d);
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
  color: var(--muted, rgba(255, 255, 255, 0.55));
  border-bottom: 1px solid var(--line, rgba(255, 255, 255, 0.12));
}

.boss-chat-add-btn {
  width: 28px;
  height: 28px;
  border: 1px solid var(--line, rgba(255, 255, 255, 0.12));
  border-radius: 8px;
  background: transparent;
  color: var(--text, #e8eaed);
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
  color: var(--muted, rgba(255, 255, 255, 0.55));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  color: var(--muted, rgba(255, 255, 255, 0.55));
}

.boss-chat-main {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.boss-chat-target-bar {
  padding: 8px 14px;
  font-size: 12px;
  color: var(--muted, rgba(255, 255, 255, 0.55));
  border-bottom: 1px solid var(--line, rgba(255, 255, 255, 0.12));
}

.boss-chat-target-bar strong {
  color: var(--text, #e8eaed);
}

.boss-chat-default-tag {
  margin-left: 6px;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(70, 209, 96, 0.15);
  color: var(--accent-2, #46d160);
}

.boss-chat-empty {
  margin: 0;
  font-size: 13px;
  color: var(--muted, rgba(255, 255, 255, 0.55));
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

.boss-chat-main .composer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.2);
  background: #1a1f28;
}

.boss-chat-main .composer-input {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  min-height: 72px;
  max-height: 220px;
  background: #11151c;
  border: 1px solid rgba(255, 255, 255, 0.34);
  border-radius: 10px;
  color: #eef1f5;
  padding: 11px 12px;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.45;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.35);
}

.boss-chat-main .composer-input::placeholder {
  color: rgba(255, 255, 255, 0.42);
}

.boss-chat-main .composer-input:focus {
  outline: none;
  border-color: #46d160;
  box-shadow:
    inset 0 1px 3px rgba(0, 0, 0, 0.35),
    0 0 0 2px rgba(70, 209, 96, 0.22);
}

.boss-chat-main .composer-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.composer-mode-select {
  width: 130px;
  flex-shrink: 0;
}

.boss-chat-main :deep(.composer-mode-select .n-base-selection) {
  background: #11151c !important;
  border: 1px solid rgba(255, 255, 255, 0.34) !important;
  border-radius: 999px !important;
}

.boss-chat-main :deep(.composer-mode-select .n-base-selection:hover),
.boss-chat-main :deep(.composer-mode-select .n-base-selection--focus) {
  border-color: #46d160 !important;
  box-shadow: 0 0 0 2px rgba(70, 209, 96, 0.18) !important;
}

.composer-send {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  border-radius: 999px;
  border: none;
  background: var(--accent-2, #46d160);
  color: #0d1a12;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
  flex-shrink: 0;
}

.composer-send:hover:not(:disabled) {
  filter: brightness(1.05);
}

.composer-send:disabled {
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
    border-bottom: 1px solid var(--line, rgba(255, 255, 255, 0.12));
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
