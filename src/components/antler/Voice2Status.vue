<script setup lang="ts">
// Header 上的 v2 语音状态：off / sleep / active / speaking。点一下唤醒/休眠（或手动连/断）。
import { computed } from 'vue'
import { NTag, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useVoice2 } from '@/composables/useVoice2'

const { t } = useI18n()
const { status, settings, tapHeader } = useVoice2()

const tag = computed(() => {
  switch (status.value) {
    case 'connecting': return { label: t('voice2.status.connecting'), type: 'warning' as const }
    case 'sleep': return { label: t('voice2.status.sleep'), type: 'default' as const }
    case 'active': return { label: t('voice2.status.active'), type: 'success' as const }
    case 'speaking': return { label: t('voice2.status.speaking'), type: 'info' as const }
    default: return { label: settings.localWake ? t('voice2.status.offAlways') : t('voice2.status.offManual'), type: 'default' as const }
  }
})

const hint = computed(() => {
  if (status.value === 'off') return settings.localWake ? t('voice2.status.hintOffAlways', { wake: settings.wakePhrases.join(' / ') }) : t('voice2.status.hintOffManual')
  if (status.value === 'sleep') return t('voice2.status.hintSleep', { wake: settings.wakePhrases.join(' / ') })
  if (status.value === 'active') return t('voice2.status.hintActive')
  if (status.value === 'speaking') return t('voice2.status.hintSpeaking')
  return ''
})
</script>

<template>
  <NTooltip>
    <template #trigger>
      <NTag
        :type="tag.type"
        size="small"
        round
        style="cursor: pointer; user-select: none;"
        @click="tapHeader"
      >
        🎙️ {{ tag.label }}
      </NTag>
    </template>
    {{ hint }}
  </NTooltip>
</template>
