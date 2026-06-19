import { ref } from 'vue'
import { useVoiceOutput } from '@/composables/useVoiceOutput'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'

const SENTENCE_END = /[。！？.!?]\s*/g

export function useStreamingVoiceOutput() {
  const { settings } = useVoiceAssistantSettings()
  const { speak, stop } = useVoiceOutput()
  const queue = ref<string[]>([])
  const buffer = ref('')
  let draining = false

  function splitSentences(text: string): string[] {
    const parts: string[] = []
    let rest = text
    let match: RegExpExecArray | null
    const re = new RegExp(SENTENCE_END.source, 'g')
    while ((match = re.exec(rest)) !== null) {
      const chunk = rest.slice(0, match.index + match[0].length).trim()
      if (chunk.length >= 4) parts.push(chunk)
      rest = rest.slice(match.index + match[0].length)
    }
    return parts
  }

  async function drainQueue() {
    if (draining) return
    draining = true
    try {
      while (queue.value.length) {
        const next = queue.value.shift()
        if (next) await speak(next)
      }
    } finally {
      draining = false
    }
  }

  function pushDelta(delta: string, done = false) {
    if (!settings.value.voice.enabled || !settings.value.voice.streamingTts) return
    buffer.value += delta
    const sentences = splitSentences(buffer.value)
    if (sentences.length) {
      const consumed = sentences.join('')
      buffer.value = buffer.value.slice(consumed.length)
      queue.value.push(...sentences)
      void drainQueue()
    }
    if (done && buffer.value.trim()) {
      queue.value.push(buffer.value.trim())
      buffer.value = ''
      void drainQueue()
    }
  }

  function resetStream() {
    buffer.value = ''
    queue.value = []
    stop()
  }

  return {
    pushDelta,
    resetStream,
    stop,
  }
}
