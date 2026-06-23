<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { isSummonHost } from '@/lib/desktop-shell'

const message = useMessage()
const { t } = useI18n()

function onSummonWake(ev: Event) {
  const detail = (ev as CustomEvent<{ phrase?: string; source?: string }>).detail || {}
  const phrase = String(detail.phrase || '').trim()
  const line = phrase
    ? t('components.summonStatus.wakeToastWithPhrase', { phrase })
    : t('components.summonStatus.wakeToast')
  message.success(line, { duration: 4000 })
}

onMounted(() => {
  if (!isSummonHost()) return
  window.addEventListener('antler:summon-wake', onSummonWake)
})

onUnmounted(() => {
  window.removeEventListener('antler:summon-wake', onSummonWake)
})
</script>

<template><span class="sr-only" aria-hidden="true" /></template>
