<script setup lang="ts">
import { computed } from 'vue'
import { NSelect, NSpace, NText } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { TTS_VOICE_PRESETS, type TtsEngine } from '@/constants/voiceAssistant'
import type { StandupParticipant } from '@/composables/useDailyStandupSettings'
import type { VoiceProfile } from '@/composables/useVoiceSettings'

const props = defineProps<{
  participant: StandupParticipant
  disabled?: boolean
  profiles: VoiceProfile[]
}>()

const emit = defineEmits<{
  update: [patch: Partial<StandupParticipant['voice']>]
}>()

const { t } = useI18n()

const engineOptions = computed(() => [
  { label: t('pages.settings.voiceAssistant.voice.engineEdgetts'), value: 'edgetts' },
  { label: t('pages.settings.voiceAssistant.voice.engineKokoro'), value: 'kokoro' },
  { label: t('pages.settings.voiceAssistant.voice.engineCosyvoice'), value: 'cosyvoice' },
  { label: t('pages.settings.voiceAssistant.voice.engineWebspeech'), value: 'webspeech' },
])

const voiceOptions = computed(() => {
  const engine = (props.participant.voice?.engine || 'edgetts') as TtsEngine
  return TTS_VOICE_PRESETS.filter((p) => p.engine === engine).map((p) => ({
    label: t(p.labelKey),
    value: p.voice,
  }))
})

const profileOptions = computed(() =>
  props.profiles.map((p) => ({ label: p.name, value: p.id })),
)

function onEngineChange(engine: string) {
  const preset = TTS_VOICE_PRESETS.find((p) => p.engine === engine)
  emit('update', {
    engine,
    ttsVoice: preset?.voice || '',
    profileId: engine === 'cosyvoice' ? props.participant.voice?.profileId || '' : '',
  })
}
</script>

<template>
  <NSpace align="center" :size="8" wrap style="margin-left: auto">
    <NText depth="3" style="font-size: 12px">{{ t('pages.settings.voiceAssistant.standup.voiceLabel') }}</NText>
    <NSelect
      :value="participant.voice?.engine || 'edgetts'"
      :options="engineOptions"
      :disabled="disabled"
      size="small"
      style="width: 130px"
      @update:value="onEngineChange"
    />
    <NSelect
      v-if="participant.voice?.engine !== 'cosyvoice'"
      :value="participant.voice?.ttsVoice || voiceOptions[0]?.value"
      :options="voiceOptions"
      :disabled="disabled || !voiceOptions.length"
      size="small"
      style="width: 180px"
      @update:value="(v) => emit('update', { ttsVoice: v })"
    />
    <NSelect
      v-else
      :value="participant.voice?.profileId || null"
      :options="profileOptions"
      :placeholder="t('pages.settings.voiceAssistant.standup.clonePlaceholder')"
      :disabled="disabled || !profileOptions.length"
      clearable
      size="small"
      style="width: 180px"
      @update:value="(v) => emit('update', { profileId: v || '' })"
    />
  </NSpace>
</template>
