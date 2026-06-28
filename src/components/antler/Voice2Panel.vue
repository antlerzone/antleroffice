<script setup lang="ts">
// Voice v2 — 自包含语音面板。OpenAI Realtime 负责听+说，要用 COO 时本地中转到 /api/voice2/coo。
// 语音每一轮的文字通过 /api/voice2/transcript 写进 Boss Chat。无需隧道、无需 v1。
import { onUnmounted, ref } from 'vue'
import { NButton } from 'naive-ui'

type LogLine = { who: string; text: string; cls: string }

const status = ref('未连接')
const statusCls = ref('')
const connected = ref(false)
const starting = ref(false)
const lines = ref<LogLine[]>([])

let pc: RTCPeerConnection | null = null
let dc: RTCDataChannel | null = null
let micStream: MediaStream | null = null
let aiBuf = ''

function log(who: string, text: string, cls = '') {
  lines.value.push({ who, text, cls })
  if (lines.value.length > 100) lines.value.shift()
}
function setStatus(text: string, cls = '') { status.value = text; statusCls.value = cls }

async function postTranscript(role: 'user' | 'assistant', text: string) {
  const t = (text || '').trim()
  if (!t) return
  try {
    await fetch('/api/voice2/transcript', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, text: t }),
    })
  } catch { /* 写 Boss Chat 失败不影响语音 */ }
}

async function start() {
  if (connected.value || starting.value) return
  starting.value = true
  setStatus('正在申请令牌…')
  let session: any
  try {
    const r = await fetch('/api/voice2/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    session = await r.json()
    if (!session.ok) throw new Error(session.error || 'session failed')
  } catch (e: any) {
    setStatus('拿令牌失败：' + e.message, 'err'); starting.value = false; return
  }

  pc = new RTCPeerConnection()
  pc.ontrack = (e) => {
    const el = document.getElementById('voice2-audio') as HTMLAudioElement | null
    if (el) el.srcObject = e.streams[0]
  }

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    micStream.getTracks().forEach((t) => pc!.addTrack(t))
  } catch (e: any) {
    setStatus('拿不到麦克风：' + e.message, 'err'); starting.value = false; return
  }

  dc = pc.createDataChannel('oai-events')
  dc.onopen = () => { connected.value = true; starting.value = false; setStatus('已连接 · 说 “Hello Jarvis” 唤醒', 'on') }
  dc.onmessage = (e) => handleEvent(JSON.parse(e.data))

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  setStatus('正在连接 Realtime…')
  const resp = await fetch('https://api.openai.com/v1/realtime/calls?model=' + encodeURIComponent(session.model), {
    method: 'POST', body: offer.sdp || '',
    headers: { Authorization: 'Bearer ' + session.value, 'Content-Type': 'application/sdp' },
  })
  if (!resp.ok) { setStatus('Realtime 连接失败 HTTP ' + resp.status, 'err'); starting.value = false; return }
  await pc.setRemoteDescription({ type: 'answer', sdp: await resp.text() })
}

async function handleEvent(ev: any) {
  switch (ev.type) {
    case 'conversation.item.input_audio_transcription.completed':
      if (ev.transcript) { log('你', ev.transcript.trim(), 'you'); postTranscript('user', ev.transcript) }
      break
    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
      aiBuf += ev.delta || ''
      break
    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
      if (aiBuf.trim()) { log('Jarvis', aiBuf.trim(), 'ai'); postTranscript('assistant', aiBuf) }
      aiBuf = ''
      break
    case 'response.function_call_arguments.done':
      if (ev.name === 'forward_to_coo') await relayToCoo(ev)
      break
    case 'error':
      log('错误', JSON.stringify(ev.error || ev), 'err')
      break
  }
}

async function relayToCoo(ev: any) {
  let instruction = ''
  try { instruction = (JSON.parse(ev.arguments || '{}').instruction || '').trim() } catch { /* */ }
  log('调用 COO', instruction, 'tool')

  // 等太久的垫场话：超过 9 秒还没回，让 Jarvis 说一句“还在查”，之后每 12 秒再来一句
  let pending = true
  const fillers = ['还在查，再稍等一下哦', '马上好，正在整理', '稍等，快查到了']
  let fi = 0
  let timer: any = null
  const tick = () => {
    if (!pending || !dc || dc.readyState !== 'open') return
    dc.send(JSON.stringify({
      type: 'response.create',
      response: { instructions: '用一句很短的口语告诉老板你还在查、请稍候，就说“' + fillers[fi % fillers.length] + '”，只说这一句。' },
    }))
    fi += 1
    timer = setTimeout(tick, 12000)
  }
  timer = setTimeout(tick, 9000)

  let result: any = { text: '(COO 无回应)' }
  try {
    const r = await fetch('/api/voice2/coo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction }),
    })
    result = await r.json()
  } catch (e: any) {
    result = { text: 'COO 调用失败：' + e.message }
  }
  pending = false
  if (timer) clearTimeout(timer)
  log('COO', (result.text || '').slice(0, 800), 'tool')

  if (dc && dc.readyState === 'open') {
    dc.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: ev.call_id, output: result.text || '' },
    }))
    dc.send(JSON.stringify({ type: 'response.create' }))
  }
}

function stop() {
  try { dc?.close() } catch { /* */ }
  try { pc?.close() } catch { /* */ }
  micStream?.getTracks().forEach((t) => t.stop())
  pc = null; dc = null; micStream = null
  connected.value = false; starting.value = false
  setStatus('已停止')
}

onUnmounted(stop)
</script>

<template>
  <div class="voice2">
    <div class="voice2-bar">
      <NButton v-if="!connected" type="primary" :loading="starting" @click="start">🎙️ Summon</NButton>
      <NButton v-else @click="stop">停止</NButton>
      <span class="voice2-status" :class="statusCls">{{ status }}</span>
    </div>
    <div v-if="lines.length" class="voice2-log">
      <div v-for="(l, i) in lines" :key="i" :class="l.cls">{{ l.who }}：{{ l.text }}</div>
    </div>
    <audio id="voice2-audio" autoplay />
  </div>
</template>

<style scoped>
.voice2 { display: flex; flex-direction: column; gap: 8px; }
.voice2-bar { display: flex; align-items: center; gap: 10px; }
.voice2-status { font-size: 13px; color: #666; padding: 3px 8px; border-radius: 6px; background: #f0f0f0; }
.voice2-status.on { background: #d6f5d6; color: #137333; }
.voice2-status.err { background: #f8d7da; color: #c00; }
.voice2-log { max-height: 220px; overflow-y: auto; font-size: 13px; line-height: 1.5; border: 1px solid #eee; border-radius: 8px; padding: 8px; }
.voice2-log .you { color: #1a73e8; }
.voice2-log .ai { color: #137333; }
.voice2-log .tool { color: #b06000; }
.voice2-log .err { color: #c00; }
</style>
