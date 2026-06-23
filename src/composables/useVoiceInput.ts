import { ref, onUnmounted } from 'vue'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import { useBossStore } from '@/stores/boss'

interface BrowserSpeechRecognition extends EventTarget {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  onresult: ((event: { results: { [index: number]: { [index: number]: { transcript: string } } } }) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  start(): void
}

type SpeechRecognitionCtor = new () => BrowserSpeechRecognition

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

export function useVoiceInput() {
  const api = useAntlerApi()
  const boss = useBossStore()
  const { settings } = useVoiceAssistantSettings()
  const isRecording = ref(false)
  const isTranscribing = ref(false)
  const error = ref<string | null>(null)

  let mediaRecorder: MediaRecorder | null = null
  let chunks: Blob[] = []
  let stream: MediaStream | null = null
  let recordStartedAt = 0

  function stopStream() {
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
      stream = null
    }
  }

  async function startRecording() {
    error.value = null
    chunks = []
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm'
    mediaRecorder = new MediaRecorder(stream, { mimeType })
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    recordStartedAt = Date.now()
    mediaRecorder.start(200)
    isRecording.value = true
  }

  async function stopRecording(): Promise<Blob | null> {
    if (!mediaRecorder || !isRecording.value) return null
    return new Promise((resolve) => {
      const recorder = mediaRecorder!
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
        isRecording.value = false
        stopStream()
        mediaRecorder = null
        resolve(blob.size > 0 ? blob : null)
      }
      recorder.stop()
    })
  }

  async function transcribeWithBrowser(lang = 'zh-CN'): Promise<string> {
    const Ctor = getSpeechRecognition()
    if (!Ctor) throw new Error('Browser speech recognition not available')
    return new Promise((resolve, reject) => {
      const recognition = new Ctor()
      recognition.lang = lang
      recognition.interimResults = false
      recognition.maxAlternatives = 1
      recognition.onresult = (event) => {
        const text = event.results[0]?.[0]?.transcript || ''
        resolve(String(text).trim())
      }
      recognition.onerror = (event) => reject(new Error(event.error || 'recognition failed'))
      recognition.start()
    })
  }

  async function transcribeBlob(blob: Blob): Promise<string> {
    isTranscribing.value = true
    error.value = null
    try {
      const form = new FormData()
      form.append('audio', blob, 'recording.webm')
      const sttModel =
        settings.value.voiceApi.openaiSttModel?.trim() ||
        settings.value.realtime.openaiSttModel?.trim()
      if (sttModel) form.append('openaiSttModel', sttModel)
      if (boss.chatOwnerKey) form.append('ownerKey', boss.chatOwnerKey)
      if (boss.session?.username) form.append('ownerName', boss.session.username)
      const sttKey =
        settings.value.voiceApi.sttApiKey?.trim() ||
        settings.value.realtime.openaiApiKey?.trim()
      if (sttKey) form.append('openaiApiKey', sttKey)

      try {
        const res = await api.sendForm<{
          ok: boolean
          text?: string
          fallback?: string
          error?: string
        }>('POST', '/api/voice/transcribe', form, { timeoutMs: 120000 })
        if (res.ok && res.text) return res.text
        if (res.fallback === 'browser') {
          return transcribeWithBrowser()
        }
        throw new Error(res.error || 'Transcription failed')
      } catch (e) {
        try {
          return await transcribeWithBrowser()
        } catch {
          throw e
        }
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Transcription failed'
      throw e
    } finally {
      isTranscribing.value = false
    }
  }

  async function toggleRecording(onText: (text: string) => void) {
    if (isTranscribing.value) return
    if (isRecording.value) {
      const blob = await stopRecording()
      if (!blob) return
      const durationSec = (Date.now() - recordStartedAt) / 1000
      if (durationSec < 0.5) {
        error.value = 'Recording too short'
        return
      }
      const text = await transcribeBlob(blob)
      if (text) onText(text)
      return
    }
    await startRecording()
  }

  onUnmounted(() => {
    if (mediaRecorder?.state === 'recording') mediaRecorder.stop()
    stopStream()
  })

  return {
    isRecording,
    isTranscribing,
    error,
    startRecording,
    stopRecording,
    transcribeBlob,
    toggleRecording,
  }
}
