<script setup lang="ts">
import { computed, ref } from 'vue'
import { NTag, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useVoiceWake } from '@/composables/useVoiceWake'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import { isSummonHost } from '@/lib/desktop-shell'

const { t } = useI18n()
const { mode, connected, realtime, toggleSummonSession, isSummonEngaged } = useVoiceWake()
const { settings } = useVoiceAssistantSettings()
const toggling = ref(false)

const visible = computed(() => isSummonHost())

const listenEnabled = computed(() => settings.value.summon.globalListenEnabled)

const engaged = computed(() => listenEnabled.value && isSummonEngaged())

const tag = computed(() => {
  if (!listenEnabled.value) {
    return { label: t('components.summonStatus.off'), type: 'default' as const, bordered: true }
  }
  if (mode.value === 'speaking') {
    return { label: t('components.summonStatus.speaking'), type: 'info' as const, bordered: false }
  }
  if (engaged.value) {
    return { label: t('components.summonStatus.active'), type: 'success' as const, bordered: false }
  }
  return { label: t('components.summonStatus.sleep'), type: 'default' as const, bordered: true }
})

const tooltipLines = computed(() => {
  const lines: string[] = []
  if (!listenEnabled.value) {
    lines.push(t('components.summonStatus.offHint'))
  } else if (engaged.value) {
    lines.push(t('components.summonStatus.clickToSleep'))
  } else {
    lines.push(t('components.summonStatus.clickToActive'))
  }
  lines.push(
    connected.value
      ? t('components.summonStatus.sseConnected')
      : t('components.summonStatus.sseDisconnected'),
  )
  if (realtime.isActive.value) {
    lines.push(t('components.summonStatus.realtime', { status: realtime.status.value }))
  }
  const idleMin = Math.round((settings.value.summon.idleTimeoutSec || 300) / 60)
  lines.push(t('components.summonStatus.idleHint', { minutes: idleMin }))
  return lines.join('\n')
})

async function onToggle() {
  if (!listenEnabled.value || toggling.value) return
  toggling.value = true
  try {
    await toggleSummonSession()
  } finally {
    toggling.value = false
  }
}
</script>

<template>
  <NTooltip v-if="visible" trigger="hover">
    <template #trigger>
      <NTag
        size="small"
        round
        :type="tag.type"
        :bordered="tag.bordered"
        :disabled="!listenEnabled || toggling"
        class="summon-header-status"
        :class="{ 'summon-header-status--disabled': !listenEnabled }"
        @click="onToggle"
      >
        {{ tag.label }}
      </NTag>
    </template>
    <span style="white-space: pre-line">{{ tooltipLines }}</span>
  </NTooltip>
</template>

<style scoped>
.summon-header-status {
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: capitalize;
  cursor: pointer;
  user-select: none;
}

.summon-header-status--disabled {
  cursor: not-allowed;
  opacity: 0.65;
}
</style>
