/**
 * useVoiceRealtime — AntlerOffice Voice OS (realtime path only; summon is separate).
 *
 *   Mic → local VAD → Whisper REST (STT)
 *     → POST /api/voice/realtime/turn (SSE)
 *         intent router → parallel dept data → stream summary
 *     → OpenAI TTS (sentence queue, stream as text arrives)
 *
 * ElevenLabs / Fish Audio are intentionally not used here (separate project).
 */

import { ref } from 'vue'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import { useBossStore } from '@/stores/boss'
import { getApiAuthHeaders, ensureApiSession } from '@/lib/api-auth'
import { resolveReplyLanguage } from '@/constants/voiceAssistant'
import { pickThinkingAck, pickThinkingFollowUp } from '@/lib/thinking-acks'
import { summonError, summonMark, summonWarn, resetSummonTimer } from '@/lib/summon-debug'
import { touchSummonActivity } from '@/lib/summon-session'

export type RealtimeStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'error'

export interface ConversationLogEntry {
  role: 'user' | 'ai'
  text: string
  time: string
}

const isActive = ref(false)
const status = ref<RealtimeStatus>('idle')
const errorMessage = ref('')
const userTranscript = ref('')
const aiTranscript = ref('')
const conversationLog = ref<ConversationLogEntry[]>([])

let micCtx: AudioContext | null = null
let playCtx: AudioContext | null = null
let micStream: MediaStream | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let scriptProcessor: any = null
let activeSources: AudioBufferSourceNode[] = []
let nextPlayTime = 0

let ocSpeakAbort: AbortController | null = null
let turnAbort: AbortController | null = null
let thinkingAckGeneration = 0
let thinkingFollowUpTimer: ReturnType<typeof setTimeout> | null = null
let ttsQueueChain: Promise<void> = Promise.resolve()
let deltaSpeakBuffer = ''

// Local RMS VAD (replaces OpenAI Realtime server VAD)
let localVadInSpeech = false
let localVadSilenceFrames = 0
let localVadSpeechFrames = 0
const VAD_END_SILENCE_FRAMES = 6   // ~1 s @ 4096/24 kHz
const VAD_MIN_SPEECH_FRAMES = 3
const VAD_MIN_AUDIO_SEC = 0.4
const VAD_PRE_BUFFER_MAX = 8

let speechRecordBuffer: Float32Array[] = []
let speechRecording = false
let speechGeneration = 0
let speechPreBuffer: Float32Array[] = []
/** Ignore mic input until this timestamp (greeting playback after summon wake). */
let listenGraceUntil = 0

function normalizeWakePhrase(text: string): string {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isWakePhraseOnly(text: string, phrases: string[]): boolean {
  const norm = normalizeWakePhrase(text)
  if (!norm) return false
  for (const phrase of phrases) {
    const p = normalizeWakePhrase(phrase)
    if (!p) continue
    if (norm === p) return true
    if (norm.startsWith(`${p} `)) {
      const rest = norm.slice(p.length).trim()
      if (!rest) return true
    }
  }
  return false
}

export function useVoiceRealtime() {
  const api = useAntlerApi()
  const { settings, honorific, hasUserOpenAiKey, userOpenAiKey } = useVoiceAssistantSettings()

  function float32ToPcm16(float32: Float32Array): Int16Array {
    const out = new Int16Array(float32.length)
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]))
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    return out
  }

  function pcm16ToFloat32(pcm16: Int16Array): Float32Array {
    const out = new Float32Array(pcm16.length)
    for (let i = 0; i < pcm16.length; i++) {
      out[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7fff)
    }
    return out
  }

  function int16ToBase64(pcm16: Int16Array): string {
    const bytes = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength)
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin)
  }

  function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  }

  function ensurePlayCtx(sampleRate = 24000) {
    if (!playCtx || playCtx.state === 'closed') {
      playCtx = new AudioContext({ sampleRate })
      nextPlayTime = 0
    }
    if (playCtx.state === 'suspended') {
      playCtx.resume().catch(() => {})
    }
  }

  function queuePcm16Bytes(bytes: Uint8Array, sampleRate = 24000) {
    ensurePlayCtx(sampleRate)
    if (bytes.length < 2) return
    const pcm16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1)
    const float32 = pcm16ToFloat32(pcm16)
    const buffer = playCtx!.createBuffer(1, float32.length, sampleRate)
    buffer.copyToChannel(float32, 0)
    const src = playCtx!.createBufferSource()
    src.buffer = buffer
    src.connect(playCtx!.destination)
    const now = playCtx!.currentTime
    const startAt = Math.max(now, nextPlayTime)
    src.start(startAt)
    nextPlayTime = startAt + buffer.duration
    src.onended = () => { activeSources = activeSources.filter(s => s !== src) }
    activeSources.push(src)
  }

  function queueOpenAIDelta(b64: string) {
    queuePcm16Bytes(base64ToBytes(b64), 24000)
  }

  function stopPlayback() {
    activeSources.forEach(src => { try { src.stop() } catch { /* ignore */ } })
    activeSources = []
    nextPlayTime = 0
  }

  function chunkRms(samples: Float32Array): number {
    let sum = 0
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
    return Math.sqrt(sum / samples.length)
  }

  function vadStartThreshold(): number {
    const sens = settings.value.summon?.sensitivity ?? 0.5
    return 0.004 + (1 - sens) * 0.016
  }

  function vadEndThreshold(): number {
    return vadStartThreshold() * 0.65
  }

  function cancelThinkingFollowUp() {
    thinkingAckGeneration += 1
    if (thinkingFollowUpTimer) {
      clearTimeout(thinkingFollowUpTimer)
      thinkingFollowUpTimer = null
    }
  }

  function playThinkingChime(langHint?: 'zh' | 'en') {
    const rt = settings.value.realtime
    if (rt.thinkingChimeEnabled === false) return
    cancelThinkingFollowUp()
    const lang =
      langHint ||
      (rt.thinkingChimeText && detectLang(rt.thinkingChimeText) === 'en' ? 'en' : 'zh')
    const custom = rt.thinkingChimeText?.trim()
    const first =
      custom && custom !== '嗯…' && custom !== 'Hmm…' ? custom : pickThinkingAck(lang)
    const followUp = pickThinkingFollowUp(lang)
    const gen = thinkingAckGeneration
    summonMark(`thinking ack → ${first}`)
    void playQuickAck(first)
    thinkingFollowUpTimer = setTimeout(() => {
      thinkingFollowUpTimer = null
      if (gen !== thinkingAckGeneration) return
      if (!isActive.value || status.value !== 'processing') return
      summonMark(`thinking follow-up → ${followUp}`)
      void playQuickAck(followUp)
    }, 2800)
  }

  async function playQuickAck(text: string) {
    if (typeof speechSynthesis === 'undefined') return
    try {
      speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(text)
      u.lang = detectLang(text) === 'zh' ? 'zh-CN' : 'en-US'
      u.rate = 1.12
      u.volume = 0.88
      speechSynthesis.speak(u)
    } catch {
      /* ignore */
    }
  }

  function onLocalSpeechStarted() {
    stepLog(1, '🎤', 'Local VAD speech started')
    if (status.value === 'speaking' || status.value === 'processing') {
      ocInterrupt()
      try { speechSynthesis?.cancel() } catch { /* ignore */ }
    }
    status.value = 'listening'
    aiTranscript.value = ''
    speechGeneration++
    speechRecordBuffer = [...speechPreBuffer]
    speechPreBuffer = []
    speechRecording = true
    localVadInSpeech = true
    localVadSilenceFrames = 0
    localVadSpeechFrames = VAD_MIN_SPEECH_FRAMES
  }

  function onLocalSpeechEnded() {
    if (!speechRecording) return
    speechRecording = false
    localVadInSpeech = false
    localVadSilenceFrames = 0
    localVadSpeechFrames = 0
    const chunks = [...speechRecordBuffer]
    speechRecordBuffer = []
    resetSummonTimer('user utterance')
    touchSummonActivity()
    stepLog(1, '🎤', 'Local VAD speech ended → Whisper', `${chunks.length} chunks`)
    void transcribeWithWhisper(chunks, speechGeneration)
  }

  function processLocalVad(samples: Float32Array) {
    if (!isActive.value) return
    if (Date.now() < listenGraceUntil) return
    const rms = chunkRms(samples)
    const startTh = vadStartThreshold()
    const endTh = vadEndThreshold()

    speechPreBuffer.push(new Float32Array(samples))
    if (speechPreBuffer.length > VAD_PRE_BUFFER_MAX) speechPreBuffer.shift()

    if (speechRecording) {
      speechRecordBuffer.push(new Float32Array(samples))
    }

    if (!localVadInSpeech) {
      if (rms >= startTh) {
        localVadSpeechFrames++
        if (localVadSpeechFrames >= VAD_MIN_SPEECH_FRAMES) {
          onLocalSpeechStarted()
        }
      } else {
        localVadSpeechFrames = 0
      }
      return
    }

    if (rms < endTh) {
      localVadSilenceFrames++
      if (localVadSilenceFrames >= VAD_END_SILENCE_FRAMES) {
        onLocalSpeechEnded()
      }
    } else {
      localVadSilenceFrames = 0
    }
  }

  async function startMic() {
    try {
      micCtx = new AudioContext({ sampleRate: 24000 })
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: { ideal: 24000 }, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
      const src = micCtx.createMediaStreamSource(micStream)
      scriptProcessor = micCtx.createScriptProcessor(4096, 1, 1)
      scriptProcessor.onaudioprocess = (e: AudioProcessingEvent) => {
        if (!isActive.value) return
        const samples = e.inputBuffer.getChannelData(0)
        processLocalVad(samples)
      }
      src.connect(scriptProcessor)
      scriptProcessor.connect(micCtx.destination)
    } catch (err) {
      status.value = 'error'
      errorMessage.value = `mic denied: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  function stopMic() {
    try { scriptProcessor?.disconnect() } catch { /* ignore */ }
    micStream?.getTracks().forEach(t => t.stop())
    try { micCtx?.close() } catch { /* ignore */ }
    scriptProcessor = null; micStream = null; micCtx = null
  }

  function detectLang(text: string): 'zh' | 'en' {
    if (!text) return 'en'
    const cjk = (text.match(/[一-鿿㐀-䶿豈-﫿　-〿]/g) || []).length
    return cjk / text.length > 0.15 ? 'zh' : 'en'
  }



  function stepLog(step: number, emoji: string, msg: string, detail = '') {
    const line = `[STEP ${step}] ${emoji} ${msg}${detail ? `: ${detail}` : ''}`
    summonMark(line)
  }

  function float32ChunksToWav(chunks: Float32Array[], sampleRate: number): Blob {
    const totalLen = chunks.reduce((s, c) => s + c.length, 0)
    const pcm16 = new Int16Array(totalLen)
    let off = 0
    for (const chunk of chunks) { pcm16.set(float32ToPcm16(chunk), off); off += chunk.length }
    const dataLen = pcm16.byteLength
    const wavBuf = new ArrayBuffer(44 + dataLen)
    const v = new DataView(wavBuf)
    const ws = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
    ws(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); ws(8, 'WAVE')
    ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true)
    v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true)
    v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
    ws(36, 'data'); v.setUint32(40, dataLen, true)
    new Uint8Array(wavBuf).set(new Uint8Array(pcm16.buffer), 44)
    return new Blob([wavBuf], { type: 'audio/wav' })
  }

  async function transcribeWithWhisper(chunks: Float32Array[], gen: number): Promise<void> {
    if (!isActive.value || !chunks.length) return
    const totalSamples = chunks.reduce((s, c) => s + c.length, 0)
    const durationSec = totalSamples / 24000
    if (durationSec < VAD_MIN_AUDIO_SEC) {
      console.warn('[STT] audio too short — speak a bit longer', `${durationSec.toFixed(2)}s`)
      return
    }
    const rt = settings.value.realtime
    const sttModel =
      settings.value.voiceApi.openaiSttModel?.trim() ||
      rt.openaiSttModel?.trim() ||
      'gpt-4o-mini-transcribe'
    const sttLang = resolveReplyLanguage(
      settings.value.voice.replyLanguage,
      typeof navigator !== 'undefined' ? navigator.language : 'en',
    )
    stepLog(2, '🎙️', 'Whisper STT', `chunks=${chunks.length} dur=${durationSec.toFixed(2)}s lang=${sttLang}`)
    const sttStart = performance.now()
    try {
      const wavBlob = float32ChunksToWav(chunks, 24000)
      const form = new FormData()
      form.append('audio', wavBlob, 'audio.wav')
      form.append('openaiSttModel', sttModel)
      form.append('language', sttLang)
      const boss = useBossStore()
      if (boss.chatOwnerKey) form.append('ownerKey', boss.chatOwnerKey)
      if (boss.session?.username) form.append('ownerName', boss.session.username)
      const sttKey = userOpenAiKey()
      if (sttKey) form.append('openaiApiKey', sttKey)
      const res = await api.sendForm<{
        ok: boolean
        text?: string
        fallback?: string
        error?: string
      }>('POST', '/api/voice/transcribe', form, { timeoutMs: 120000 })
      if (!res.ok || !res.text) {
        console.warn('[STT] empty or failed — retry with whisper-1', res.error)
        if (sttModel !== 'whisper-1') {
          const retryForm = new FormData()
          retryForm.append('audio', wavBlob, 'audio.wav')
          retryForm.append('openaiSttModel', 'whisper-1')
          retryForm.append('language', sttLang)
          if (boss.chatOwnerKey) retryForm.append('ownerKey', boss.chatOwnerKey)
          if (boss.session?.username) retryForm.append('ownerName', boss.session.username)
          if (sttKey) retryForm.append('openaiApiKey', sttKey)
          const retry = await api.sendForm<{
            ok: boolean
            text?: string
            error?: string
          }>('POST', '/api/voice/transcribe', retryForm, { timeoutMs: 120000 })
          if (retry.ok && retry.text?.trim()) {
            const transcript = retry.text.trim()
            if (gen !== speechGeneration) return
            if (isWakePhraseOnly(transcript, settings.value.summon.wakePhrases || [])) {
              console.log('[summon] realtime ignored wake phrase (use Persona sample reply only):', transcript)
              return
            }
            userTranscript.value = transcript
            playThinkingChime(detectLang(transcript))
            void runRealtimeVoiceTurn(transcript)
            return
          }
        }
        console.error('[STT] server transcribe error:', res.error || 'Empty transcription')
        return
      }
      const transcript = res.text.trim()
      summonMark(`Whisper STT done in ${Math.round(performance.now() - sttStart)}ms`)
      stepLog(2, '📝', 'STT transcript (Whisper)', transcript)
      if (gen !== speechGeneration) { console.log('[STT] discarding stale transcript'); return }
      const wakePhrases = settings.value.summon.wakePhrases || []
      if (isWakePhraseOnly(transcript, wakePhrases)) {
        console.log('[summon] realtime ignored wake phrase (use Persona sample reply only):', transcript)
        return
      }
      if (transcript && isActive.value) {
        userTranscript.value = transcript
        touchSummonActivity()
        const ackLang = detectLang(transcript)
        playThinkingChime(ackLang)
        void runRealtimeVoiceTurn(transcript)
      }
    } catch (e) {
      console.error('[STT] Whisper fetch error:', e)
    }
  }

  function ocInterrupt() {
    cancelThinkingFollowUp()
    turnAbort?.abort()
    turnAbort = null
    ocSpeakAbort?.abort()
    ocSpeakAbort = null
    ttsQueueChain = Promise.resolve()
    deltaSpeakBuffer = ''
    stopPlayback()
    try { speechSynthesis?.cancel() } catch { /* ignore */ }
  }

  function extractCompleteSentences(buffer: string): { sentences: string[]; rest: string } {
    const sentences: string[] = []
    let rest = buffer
    const re = /[^.!?。！？\n]+[.!?。！？]+(?:\s+|$)|\n+/g
    let match: RegExpExecArray | null
    let lastIndex = 0
    while ((match = re.exec(buffer)) !== null) {
      const s = match[0].trim()
      if (s) sentences.push(s)
      lastIndex = re.lastIndex
    }
    rest = buffer.slice(lastIndex)
    return { sentences, rest }
  }

  function enqueueSpeak(text: string) {
    const line = text.trim()
    if (!line || !isActive.value) return
    ttsQueueChain = ttsQueueChain.then(async () => {
      if (!isActive.value) return
      await ocSpeak(line)
    }).catch(() => {})
  }

  function enqueueSpeakDelta(delta: string) {
    deltaSpeakBuffer += delta
    const { sentences, rest } = extractCompleteSentences(deltaSpeakBuffer)
    deltaSpeakBuffer = rest
    for (const s of sentences) enqueueSpeak(s)
  }

  function flushSpeakDeltaBuffer() {
    const tail = deltaSpeakBuffer.trim()
    deltaSpeakBuffer = ''
    if (tail) enqueueSpeak(tail)
  }

  type RealtimeSseEvent = {
    type: string
    text?: string
    delta?: string
    intent?: string
    error?: string
    label?: string
  }

  async function runRealtimeVoiceTurn(userText: string): Promise<void> {
    if (!userText.trim() || !isActive.value) return
    stepLog(3, '🧠', 'Voice OS turn', userText.slice(0, 80))
    status.value = 'processing'
    conversationLog.value.push({ role: 'user', text: userText.trim(), time: nowTime() })
    turnAbort?.abort()
    turnAbort = new AbortController()
    const signal = turnAbort.signal
    ttsQueueChain = Promise.resolve()
    deltaSpeakBuffer = ''
    let fullReply = ''

    try {
      await ensureApiSession()
      const boss = useBossStore()
      const uiLocale = typeof navigator !== 'undefined' ? navigator.language : 'en'
      const replySetting = settings.value.voice.replyLanguage
      const fixedLang = resolveReplyLanguage(replySetting, uiLocale)
      const effectiveLang = replySetting === 'auto' ? detectLang(userText) : fixedLang
      const rt = settings.value.realtime
      const persona = settings.value.persona

      const res = await fetch('/api/voice/realtime/turn', {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...getApiAuthHeaders(),
          ...boss.authHeaders(),
        },
        body: JSON.stringify({
          text: userText,
          ownerKey: boss.chatOwnerKey || 'local:boss',
          ownerName: boss.session?.username || 'Boss',
          replyLanguage: effectiveLang,
          personaEnabled: persona.enabled,
          honorific: honorific.value || 'boss',
          personaPrompt: String(rt.systemPrompt || persona.systemPrompt || ''),
          openaiApiKey: userOpenAiKey() || undefined,
        }),
      })

      if (!res.ok || !res.body) {
        throw new Error(`Voice OS HTTP ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let sseBuffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done || signal.aborted) break
        sseBuffer += decoder.decode(value, { stream: true })
        const chunks = sseBuffer.split('\n\n')
        sseBuffer = chunks.pop() || ''
        for (const chunk of chunks) {
          const line = chunk.split('\n').find((l) => l.startsWith('data:'))
          if (!line) continue
          let evt: RealtimeSseEvent
          try {
            evt = JSON.parse(line.slice(5).trim()) as RealtimeSseEvent
          } catch {
            continue
          }
          if (evt.type === 'intent') {
            summonMark('Voice OS intent', evt)
          } else if (evt.type === 'speak' && evt.text) {
            cancelThinkingFollowUp()
            fullReply += (fullReply ? '\n\n' : '') + evt.text
            enqueueSpeak(evt.text)
          } else if (evt.type === 'speak_delta' && evt.delta) {
            cancelThinkingFollowUp()
            fullReply += evt.delta
            enqueueSpeakDelta(evt.delta)
          } else if (evt.type === 'error') {
            summonWarn('Voice OS error', evt.error)
          } else if (evt.type === 'done') {
            flushSpeakDeltaBuffer()
            if (evt.text) fullReply = evt.text
          }
        }
      }

      flushSpeakDeltaBuffer()
      await ttsQueueChain
      cancelThinkingFollowUp()
      if (fullReply.trim()) {
        aiTranscript.value = fullReply.trim()
        conversationLog.value.push({ role: 'ai', text: fullReply.trim(), time: nowTime() })
        stepLog(4, '💬', 'Voice OS reply', fullReply.slice(0, 120))
      }
      if (isActive.value && !signal.aborted) status.value = 'listening'
    } catch (e: unknown) {
      if ((e as Error)?.name !== 'AbortError') summonError('Voice OS pipeline error', e)
      if (isActive.value) status.value = 'listening'
    } finally {
      turnAbort = null
    }
  }

  function nowTime(): string {
    return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  async function setListenerSpeaking(speaking: boolean) {
    try {
      await api.send('POST', '/api/voice/listener/speaking', { speaking })
    } catch {
      /* ignore */
    }
  }

  async function ocSpeak(text: string): Promise<void> {
    if (!text.trim() || !isActive.value) return
    status.value = 'speaking'
    try { speechSynthesis?.cancel() } catch { /* ignore */ }
    ocSpeakAbort = new AbortController()
    const signal = ocSpeakAbort.signal
    const rt = settings.value.realtime
    await setListenerSpeaking(true)
    try {
      stepLog(5, '🔊', 'TTS → OpenAI', `model=${rt.openaiTtsModel || 'gpt-4o-mini-tts'} chars=${text.length}`)
      await ocSpeakOpenAI(text, signal)
    } catch (e: unknown) {
      if ((e as Error)?.name !== 'AbortError') console.error('[TTS] error:', e)
    } finally {
      await setListenerSpeaking(false)
      touchSummonActivity()
      ocSpeakAbort = null
    }
  }

  async function ocSpeakOpenAI(text: string, signal: AbortSignal): Promise<void> {
    const rt = settings.value.realtime
    if (!hasUserOpenAiKey()) return
    const localKey = userOpenAiKey()
    const voice = rt.voice || 'alloy'
    const ttsModel = rt.openaiTtsModel?.trim() || 'gpt-4o-mini-tts'
    try {
      const boss = useBossStore()
      const body: Record<string, string> = { text, voice, model: ttsModel }
      if (localKey) body.openaiApiKey = localKey
      if (boss.chatOwnerKey) body.ownerKey = boss.chatOwnerKey
      const res = await fetch('/api/voice/tts/openai', {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...boss.authHeaders(),
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) { console.error('[TTS] OpenAI TTS error:', res.status); return }
      const buf = await res.arrayBuffer()
      if (signal.aborted) return
      ensurePlayCtx(24000)
      if (!playCtx) return
      const decoded = await playCtx.decodeAudioData(buf)
      const src = playCtx.createBufferSource()
      src.buffer = decoded; src.connect(playCtx.destination)
      const startAt = Math.max(playCtx.currentTime, nextPlayTime)
      src.start(startAt); nextPlayTime = startAt + decoded.duration
      activeSources.push(src)
      src.onended = () => { activeSources = activeSources.filter(s => s !== src) }
      stepLog(6, '▶️', 'Playing OpenAI TTS', `${decoded.duration.toFixed(1)}s`)
      const endAt = nextPlayTime
      await new Promise<void>((resolve) => {
        const check = () => { if (signal.aborted || !playCtx || playCtx.currentTime >= endAt - 0.05) resolve(); else setTimeout(check, 80) }
        setTimeout(check, 80)
      })
    } catch (e: unknown) {
      if ((e as Error)?.name !== 'AbortError') console.error('[TTS] OpenAI error:', e)
    }
  }

  function sttKeyAvailable(): boolean {
    return hasUserOpenAiKey()
  }

  async function start(opts?: { afterWake?: boolean }) {
    if (isActive.value) return
    const rt = settings.value.realtime
    if (!rt.enabled) return
    if (rt.provider === 'openai' && !sttKeyAvailable()) {
      status.value = 'error'
      errorMessage.value = 'STT unavailable — add an OpenAI key in onboarding or Models settings'
      return
    }
    if (rt.provider === 'doubao' && !rt.doubaoApiKey?.trim()) {
      status.value = 'error'
      errorMessage.value = 'Please set Doubao API Key in settings'
      return
    }

    status.value = 'connecting'
    errorMessage.value = ''
    userTranscript.value = ''
    aiTranscript.value = ''
    speechRecording = false
    speechRecordBuffer = []
    speechPreBuffer = []
    speechGeneration++
    localVadInSpeech = false
    localVadSilenceFrames = 0
    localVadSpeechFrames = 0
    listenGraceUntil = opts?.afterWake ? Date.now() + 4500 : 0

    try { await api.send('POST', '/api/voice/listener/mode', { mode: 'sleep' }) } catch { /* ignore */ }
    try {
      isActive.value = true
      await startMic()
      if (status.value !== 'error') {
        status.value = 'listening'
        resetSummonTimer('realtime session')
        stepLog(0, '✅', 'Voice OS realtime ready', 'VAD + Whisper + intent router + OpenAI TTS')
      }
    } catch (e: unknown) {
      console.error('[useVoiceRealtime] start error:', e)
      status.value = 'error'
      errorMessage.value = e instanceof Error ? e.message : String(e)
      isActive.value = false
    }
  }

  async function stop(): Promise<void> {
    isActive.value = false
    status.value = 'idle'
    turnAbort?.abort()
    turnAbort = null
    ocSpeakAbort?.abort()
    ocSpeakAbort = null
    ttsQueueChain = Promise.resolve()
    deltaSpeakBuffer = ''
    speechRecording = false
    speechRecordBuffer = []
    speechPreBuffer = []
    speechGeneration++
    localVadInSpeech = false
    localVadSilenceFrames = 0
    localVadSpeechFrames = 0
    try { speechSynthesis?.cancel() } catch { /* ignore */ }
    stopMic()
    stopPlayback()
    try { await api.send('POST', '/api/voice/listener/mode', { mode: 'sleep' }) } catch { /* ignore */ }
  }

  return {
    status,
    errorMessage,
    isActive,
    userTranscript,
    aiTranscript,
    conversationLog,
    start,
    stop,
  }
}
