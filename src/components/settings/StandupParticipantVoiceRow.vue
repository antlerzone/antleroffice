<script setup lang="ts">
import { computed } from 'vue'
import { NSelect, NSpace, NText, NInput } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { StandupParticipant } from '@/composables/useDailyStandupSettings'

const props = defineProps<{
  participant: StandupParticipant
  disabled?: boolean
}>()

const emit = defineEmits<{
  update: [patch: Partial<StandupParticipant['voice']>]
}>()

const { t } = useI18n()

const engineOptions = computed(() => [
  { label: 'Fish Audio', value: 'fishaudio' },
  { label: 'ElevenLabs', value: 'elevenlabs' },
])

const engine = computed(() => props.participant.voice?.engine || 'fishaudio')
const voiceId = computed(() => props.participant.voice?.voiceId || '')

function onEngineChange(value: string) {
  // Keep the same voiceId when switching providers is rarely meaningful, so clear it.
  emit('update', { engine: value, voiceId: '' })
}
</script>

<template>
  <NSpace align="center" :size="8" wrap style="margin-left: auto">
    <NText depth="3" style="font-size: 12px">{{ t('pages.settings.voiceAssistant.standup.voiceLabel') }}</NText>
    <NSelect
      :value="engine"
      :options="engineOptions"
      :disabled="disabled"
      size="small"
      style="width: 130px"
      @update:value="onEngineChange"
    />
    <NInput
      :value="voiceId"
      :placeholder="t('pages.settings.voiceAssistant.standup.voiceIdPlaceholder')"
      :disabled="disabled"
      size="small"
      style="width: 200px"
      @update:value="(v: string) => emit('update', { voiceId: v.trim() })"
    />
  </NSpace>
</template>
