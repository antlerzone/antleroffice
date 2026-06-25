// Voice v2 核心：一直听 + sleep/active 唤醒门控 + COO 本地中转 + 转写写进 Boss Chat。
// 设计：Realtime 一直转写但默认不出声(create_response:false)；客户端听到唤醒词才手动让它开口。
import { ref, watch } from 'vue'
import { useVoice2Settings } from './useVoice2Settings'
import { useOfficeProfile } from './useOfficeProfile'

export type Voice2Status = 'off' | 'connecting' | 'sleep' | 'active' | 'speaking'

const { settings } = useVoice2Settings()

const status = ref<Voice2Status>('off')
const lastError = ref('')
// 当前这轮语音对话的 Boss Chat 线程 id；Boss Chat 监听它，召唤时自动跳过去看实时对话。
const activeVoiceThreadId = ref<string | null>(null)

let pc: RTCPeerConnection | null = null
let dc: RTCDataChannel | null = null
let micStream: MediaStream | null = null
let audioEl: HTMLAudioElement | null = null
let aiBuf = ''
let engaged = false
let sleepTimer: any = null
let pendingEngage = false // 连接建立后是否立刻进入 active（手动点 Header 启动时为 true）
let greetOnConnect = false // 唤醒触发的连接：连上后主动打招呼
// 每次召唤都开一条全新的 Boss Chat 对话；这一轮的转写都写进它。
let sessionThreadId: string | null = null
let threadReady: Promise<void> | null = null

// 召唤瞬间向后端要一条全新的 COO 对话线程（这一轮的所有转写都进它）
// 懒建线程：只有真有消息要写时才建，空唤醒不再产生空线程。
function ensureThread(): Promise<void> {
  if (sessionThreadId) return Promise.resolve()
  if (threadReady) return threadReady
  threadReady = (async () => {
    try {
      const r = await fetch('/api/voice2/new-thread', {
        method: 'POST', headers: bossHeaders(), body: '{}',
      })
      const d = await r.json()
      if (d && d.ok && d.threadId) {
        sessionThreadId = d.threadId
        activeVoiceThreadId.value = d.threadId // 通知 Boss Chat 跳到这条新对话
      }
    } catch { /* 建线程失败就退回默认线程 */ }
  })()
  return threadReady
}

// ── 音频解锁：唤醒触发没有“点击”动作，浏览器会拦自动播放。
// 首次用户点击时，用一段静音把音频元素“激活”，之后唤醒出声就能正常播。
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='
let audioUnlocked = false
function ensureAudioEl(): HTMLAudioElement {
  if (!audioEl) {
    audioEl = document.createElement('audio')
    audioEl.autoplay = true
    audioEl.setAttribute('playsinline', '')
    document.body.appendChild(audioEl)
  }
  return audioEl
}
function unlockAudioOnce() {
  if (audioUnlocked) return
  const el = ensureAudioEl()
  el.muted = true
  el.src = SILENT_WAV
  el.play().then(() => {
    audioUnlocked = true
    el.pause()
    el.removeAttribute('src')
    el.muted = false
  }).catch(() => { el.muted = false })
}

const IDLE_DISCONNECT_MS = 40000 // 静默 40 秒自动断开（回到真·待命，不烧 token）

// ── 招呼语：提前合成好音频并缓存，唤醒时瞬间播放（连接在背后并行，盖住延迟）──
let greetingAudioUrl: string | null = null
let greetingPreparedFor = '' // 记录已合成的「文字|音色|供应商」组合，变了才重合成
let greetingAudioEl: HTMLAudioElement | null = null

async function prepareGreetingAudio() {
  const text = (settings.greeting || '').trim()
  const key = `${text}|${settings.voice}|${settings.ttsProvider}|${settings.fishVoiceId}|${settings.elevenVoiceId}`
  if (!text) { greetingAudioUrl = null; greetingPreparedFor = ''; return }
  if (key === greetingPreparedFor && greetingAudioUrl) return // 没变就不用重合成
  try {
    let url: string
    let body: Record<string, unknown>
    if (settings.ttsProvider === 'fish') {
      url = '/api/voice/tts/fishaudio'
      body = { text, apiKey: settings.fishKey, referenceId: settings.fishVoiceId }
    } else if (settings.ttsProvider === 'elevenlabs') {
      url = '/api/voice2/tts/elevenlabs'
      body = { text, apiKey: settings.elevenLabsKey, voiceId: settings.elevenVoiceId }
    } else {
      url = '/api/voice/tts/openai'
      body = { text, voice: settings.voice }
    }
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!r.ok) return
    const blob = await r.blob()
    if (greetingAudioUrl) URL.revokeObjectURL(greetingAudioUrl)
    greetingAudioUrl = URL.createObjectURL(blob)
    greetingPreparedFor = key
  } catch { /* 合成失败就退回让 Realtime 打招呼 */ }
}

// 立刻播放缓存好的招呼语，返回是否播成功（用于决定要不要让 Realtime 兜底打招呼）
function playGreetingNow(): boolean {
  if (!greetingAudioUrl) return false
  try {
    if (!greetingAudioEl) { greetingAudioEl = new Audio(); (greetingAudioEl as any).playsInline = true }
    greetingAudioEl.src = greetingAudioUrl
    void greetingAudioEl.play().catch(() => {})
    return true
  } catch { return false }
}

function send(obj: any) { if (dc && dc.readyState === 'open') dc.send(JSON.stringify(obj)) }

function armSleepTimer() {
  if (sleepTimer) clearTimeout(sleepTimer)
  // 静默到点 → 直接断开（不再停在“待命但还连着”的烧钱状态）
  sleepTimer = setTimeout(() => { if (status.value !== 'off') stop() }, IDLE_DISCONNECT_MS)
}

// 调试日志已关闭（排查完毕）。需要再排查时把下面这行改回 fetch 即可。
function dbg(_msg: string) { /* no-op */ }

// 带上登录身份：boss token（决定写进哪个 owner 的 Boss Chat）。不带的话会写进看不见的 local:boss。
function bossHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  try {
    const boss = localStorage.getItem('antleroffice2.bossToken')
    if (boss) h['X-Boss-Token'] = boss
    const auth = localStorage.getItem('auth_token')
    if (auth) h['Authorization'] = 'Bearer ' + auth
  } catch { /* 无 localStorage 就算了 */ }
  return h
}

// 串行写入队列：保证消息按「说话顺序」依次进 Boss Chat（并发写会乱序）。
let writeChain: Promise<unknown> = Promise.resolve()
async function postTranscript(role: 'user' | 'assistant', text: string) {
  const t = (text || '').trim()
  if (!t) return
  writeChain = writeChain.then(async () => {
    if (role === 'user') {
      await ensureThread() // 只有你开口才建线程，避免空唤醒/招呼语留下空壳
    } else if (!sessionThreadId) {
      return // 你还没开口前，助手的招呼语不单独建线程
    }
    await fetch('/api/voice2/transcript', {
      method: 'POST', headers: bossHeaders(),
      body: JSON.stringify({ role, text: t, threadId: sessionThreadId }),
    })
  }).catch(() => { /* 写 Boss Chat 失败不影响语音 */ })
  return writeChain
}

// 外部 TTS：把一段文字交给 Fish / ElevenLabs 合成并播放
let extAudio: HTMLAudioElement | null = null
async function speakExternal(text: string) {
  try {
    let url: string
    let body: Record<string, unknown>
    if (settings.ttsProvider === 'fish') {
      url = '/api/voice/tts/fishaudio'
      body = { text, apiKey: settings.fishKey, referenceId: settings.fishVoiceId }
    } else {
      url = '/api/voice2/tts/elevenlabs'
      body = { text, apiKey: settings.elevenLabsKey, voiceId: settings.elevenVoiceId }
    }
    const r = await fetch(url, {
      method: 'POST', headers: bossHeaders(), body: JSON.stringify(body),
    })
    if (!r.ok) return
    const blob = awai