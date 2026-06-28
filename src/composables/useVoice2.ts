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
    const blob = await r.blob()
    if (extAudio) { try { extAudio.pause() } catch { /* */ } }
    extAudio = new Audio(URL.createObjectURL(blob))
    void extAudio.play()
  } catch { /* TTS 失败就静默，不影响对话 */ }
}

async function relayToCoo(ev: any) {
  let instruction = ''
  try { instruction = (JSON.parse(ev.arguments || '{}').instruction || '').trim() } catch { /* */ }
  // 你说的话已由语音转写(input_audio_transcription)写进去了，这里不再重复写，避免重复一条。

  let pending = true
  const fillers = ['还在查，再稍等一下哦', '马上好，正在整理', '稍等，快查到了']
  let fi = 0
  let timer: any = setTimeout(function tick() {
    if (!pending) return
    send({ type: 'response.create', response: { instructions: '用一句很短的口语告诉老板你还在查、请稍候，就说“' + fillers[fi % fillers.length] + '”，只说这一句。' } })
    fi += 1
    timer = setTimeout(tick, 12000)
  }, 9000)

  let result: any = { text: '(COO 无回应)' }
  try {
    await ensureThread()
    const r = await fetch('/api/voice2/coo', {
      method: 'POST', headers: bossHeaders(),
      body: JSON.stringify({ instruction, threadId: sessionThreadId }),
    })
    result = await r.json()
  } catch (e: any) {
    result = { text: 'COO 调用失败：' + e.message }
  }
  pending = false
  if (timer) clearTimeout(timer)

  send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: result.text || '' } })
  send({ type: 'response.create' })
}

// 保证「你说的话」先于「助手回复」写进 Boss Chat：
// 你的话靠 Whisper 转写(慢)，助手回复是模型生成(快)，到达顺序常反。
// 用户一说完就建一个「等转写」的承诺，助手回复写之前先等它（最多等 3 秒兜底）。
let userTextReady: Promise<void> | null = null
let resolveUserText: (() => void) | null = null
function armUserTurn() {
  if (resolveUserText) resolveUserText() // 上一轮没用上就放掉
  userTextReady = new Promise<void>((res) => { resolveUserText = res })
  const mine = resolveUserText
  setTimeout(() => { if (resolveUserText === mine) { resolveUserText(); resolveUserText = null } }, 3000)
}
function finishUserTurn() {
  if (resolveUserText) { resolveUserText(); resolveUserText = null }
}

function handleEvent(ev: any) {
  switch (ev.type) {
    case 'input_audio_buffer.committed':
      // 你这一轮说完了，开始等它的转写文本
      armUserTurn()
      break
    case 'conversation.item.input_audio_transcription.completed': {
      const text = (ev.transcript || '').trim()
      if (text && engaged) { armSleepTimer(); postTranscript('user', text) } // 先把你的话入队
      finishUserTurn() // 再放行助手写入，保证你在前
      break
    }
    case 'response.created':
      if (engaged) status.value = 'speaking'
      break
    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
      aiBuf += ev.delta || ''
      break
    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
      if (aiBuf.trim()) {
        const text = aiBuf.trim()
        aiBuf = ''
        // 先等「这一轮你说的话」写进去，助手回复再写，保证顺序
        void (async () => {
          if (userTextReady) { try { await userTextReady } catch { /* */ } }
          postTranscript('assistant', text)
        })()
        if (settings.ttsProvider !== 'openai') void speakExternal(text) // 用 Fish/ElevenLabs 念
      }
      break
    case 'response.function_call_arguments.done':
      if (ev.name === 'forward_to_coo') relayToCoo(ev)
      else if (ev.name === 'end_session') {
        // 老板说「没事了」等结束语：道别语已在播，回个 ack，等它播完就断开（回待命、省 token）
        send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: 'ok' } })
        setTimeout(() => stop(), 3500)
      }
      break
    case 'response.done':
      if (engaged && status.value !== 'off') { status.value = 'active'; armSleepTimer() }
      break
    case 'error':
      lastError.value = JSON.stringify(ev.error || ev)
      break
  }
}

async function start(engageNow = false) {
  if (status.value !== 'off') { dbg('start 被忽略：status=' + status.value); return }
  dbg('start() 开始 engageNow=' + engageNow)
  status.value = 'connecting'
  lastError.value = ''
  pendingEngage = engageNow
  // 不在这里建线程了——改成有第一条消息时再懒建（空唤醒不产生空线程）
  let session: any
  if (warmSession && warmSession.value) {
    // 用待命时预热好的令牌 → 省掉申请那一步
    session = warmSession
    warmSession = null
    dbg('用预热令牌')
    void mintWarmSession() // 立刻再备一个给下次
  } else {
    try {
      const { bossDisplayName } = useOfficeProfile()
      const r = await fetch('/api/voice2/session', {
        method: 'POST', headers: bossHeaders(),
        body: JSON.stringify({ voice: settings.voice, model: settings.model, soul: settings.soul, bossName: bossDisplayName.value || '', sleepPhrases: settings.sleepPhrases.join('、'), sleepReply: settings.sleepReply }),
      })
      session = await r.json()
      if (!session.ok) throw new Error(session.error || 'session failed')
    } catch (e: any) {
      lastError.value = '拿令牌失败：' + e.message; status.value = 'off'; return
    }
  }

  pc = new RTCPeerConnection()
  pc.ontrack = (e) => {
    const el = ensureAudioEl()
    el.removeAttribute('src')
    el.srcObject = e.streams[0]
    // 选了外部 TTS（Fish/ElevenLabs）就把 OpenAI 的声音静音，改用外部音色播放
    el.muted = settings.ttsProvider !== 'openai'
    void el.play().catch(() => { /* 被拦就等用户点一下页面解锁 */ })
  }

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    micStream.getTracks().forEach((t) => pc!.addTrack(t))
    dbg('麦克风 OK')
  } catch (e: any) {
    dbg('麦克风失败：' + e.message)
    lastError.value = '拿不到麦克风：' + e.message; status.value = 'off'; return
  }

  dc = pc.createDataChannel('oai-events')
  dc.onopen = () => {
    dbg('数据通道已开 = Realtime 连上了')
    // 连上 = 进入 realtime = active（不再有“连着却显示待命”的状态）
    engaged = true
    status.value = 'active'
    pendingEngage = false
    armSleepTimer()
    if (greetOnConnect) {
      greetOnConnect = false
      const g = (settings.greeting || '').trim()
      const instructions = g
        ? `用语音照原样说出这句招呼（可自然带上老板名字），不要改写内容：「${g}」`
        : '现在主动用一句话向老板打招呼、问需要什么帮助；用他的名字称呼，符合你的人设，简短自然。'
      send({ type: 'response.create', response: { instructions } })
    }
  }
  dc.onmessage = (e) => handleEvent(JSON.parse(e.data))

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  try {
    const resp = await fetch('https://api.openai.com/v1/realtime/calls?model=' + encodeURIComponent(session.model), {
      method: 'POST', body: offer.sdp || '',
      headers: { Authorization: 'Bearer ' + session.value, 'Content-Type': 'application/sdp' },
    })
    if (!resp.ok) throw new Error('HTTP ' + resp.status)
    await pc.setRemoteDescription({ type: 'answer', sdp: await resp.text() })
    dbg('SDP 握手完成，等数据通道打开…')
  } catch (e: any) {
    dbg('Realtime 连接失败：' + e.message)
    lastError.value = 'Realtime 连接失败：' + e.message; status.value = 'off'
  }
}

function stop() {
  if (sleepTimer) clearTimeout(sleepTimer)
  try { dc?.close() } catch { /* */ }
  try { pc?.close() } catch { /* */ }
  micStream?.getTracks().forEach((t) => t.stop())
  pc = null; dc = null; micStream = null; engaged = false
  sessionThreadId = null; threadReady = null // 这一轮结束，下次召唤再开新线程
  status.value = 'off'
}

// 点 Header：没连就连上直接对话；已连就断开（省 token）
function tapHeader() {
  if (status.value === 'off') start(true)
  else stop()
}

// ── 本地唤醒桥：监听本机 openWakeWord 的 SSE，听到“Jarvis”就自动连 v2 ──
// 这条 SSE 只是“喊到没喊到”的信号，麦克风音频不上云，所以平时不烧 token。
let wakeES: EventSource | null = null
function startWakeBridge() {
  if (wakeES) return
  try {
    wakeES = new EventSource('/api/voice/listener/events', { withCredentials: true })
    wakeES.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data)
        if (d && d.type === 'wake' && status.value === 'off') {
          // 喊到唤醒词：① 立刻播缓存好的招呼语（瞬间） ② 同时后台连 Realtime（并行，盖住延迟）
          const played = playGreetingNow()
          greetOnConnect = !played // 缓存没播成功 → 让 Realtime 连上后兜底打招呼
          start(true)
        }
      } catch { /* 心跳等忽略 */ }
    }
    wakeES.onerror = () => { /* EventSource 会自动重连 */ }
  } catch { /* 无 SSE 端点则忽略 */ }
}
function stopWakeBridge() { try { wakeES?.close() } catch { /* */ } wakeES = null }

// ── 预热会话令牌：待命时提前申请好令牌（每 45 秒刷新，因为会过期），喊词时直接用，省掉申请那一步 ──
let warmSession: any = null
let warmTimer: any = null
async function mintWarmSession() {
  try {
    const r = await fetch('/api/voice2/session', {
      method: 'POST', headers: bossHeaders(),
      body: JSON.stringify({ voice: settings.voice, model: settings.model, soul: settings.soul, bossName: useOfficeProfile().bossDisplayName.value || '', sleepPhrases: settings.sleepPhrases.join('、'), sleepReply: settings.sleepReply }),
    })
    const j = await r.json()
    if (j && j.ok) warmSession = j
  } catch { /* 预热失败就退回喊词时现申请 */ }
}
function startSessionWarmer() {
  if (warmTimer) return
  void mintWarmSession()
  warmTimer = setInterval(() => { void mintWarmSession() }, 45000)
}
function stopSessionWarmer() { if (warmTimer) clearInterval(warmTimer); warmTimer = null; warmSession = null }
// 音色/模型变了，预热的令牌作废，重新备
watch(() => `${settings.voice}|${settings.model}`, () => { warmSession = null; if (warmTimer) void mintWarmSession() })

// 本地唤醒开关变化时，实时起/停唤醒桥
watch(() => settings.localWake, (on) => {
  if (on) { startWakeBridge(); startSessionWarmer() }
  else { stopWakeBridge(); stopSessionWarmer() }
})

// 招呼语/音色/供应商变了 → 重新合成缓存（这样唤醒时永远是最新的、且瞬间可播）
watch(
  () => `${settings.greeting}|${settings.voice}|${settings.ttsProvider}|${settings.fishVoiceId}|${settings.elevenVoiceId}`,
  () => { void prepareGreetingAudio() },
)

let inited = false
function init() {
  if (inited) return
  inited = true
  // 首次任意交互时解锁音频（让唤醒后的声音能自动播）
  ;['click', 'keydown', 'touchstart', 'pointerdown'].forEach((ev) =>
    window.addEventListener(ev, unlockAudioOnce))
  void prepareGreetingAudio() // 开机先把招呼语合成好缓存
  try { useOfficeProfile().load() } catch { /* 开机预取老板名字，缓存住，喊词时不再等 */ }
  if (settings.localWake) {
    startWakeBridge() // 开了本地唤醒才挂 SSE；否则纯手动，零成本
    startSessionWarmer() // 待命时预热令牌，喊词更快
    // 把保存的唤醒词推给本地监听器（自定义词重启后也生效）
    if (settings.wakePhrases.length) {
      fetch('/api/voice2/wake-word', {
        method: 'POST', headers: bossHeaders(),
        body: JSON.stringify({ phrases: settings.wakePhrases }),
      }).catch(() => { /* ignore */ })
    }
  }
}

export function useVoice2() {
  return { status, lastError, settings, start, stop, init, tapHeader, activeVoiceThreadId }
}
