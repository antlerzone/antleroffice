import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useAiSetupStore = defineStore('aiSetup', () => {
  const showModal = ref(false)
  const reason = ref('')

  function open(message = '') {
    reason.value = message
    showModal.value = true
  }

  function close() {
    showModal.value = false
    reason.value = ''
  }

  function maybePromptFromError(error: unknown) {
    const text = error instanceof Error ? error.message : String(error || '')
    if (!/api key|missing key|unauthorized|401|configure.*model|no auth/i.test(text)) return false
    open('Connect an AI provider to use this feature.')
    return true
  }

  return { showModal, reason, open, close, maybePromptFromError }
})
