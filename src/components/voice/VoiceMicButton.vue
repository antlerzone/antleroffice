<script setup lang="ts">
import { NButton, NIcon, NSpin } from 'naive-ui'
import { MicOutline, StopOutline } from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'
import { useVoiceInput } from '@/composables/useVoiceInput'

const props = withDefaults(
  defineProps<{
    disabled?: boolean
    size?: 'small' | 'medium' | 'large'
  }>(),
  {
    disabled: false,
    size: 'medium',
  },
)

const emit = defineEmits<{
  result: [text: string]
  error: [message: string]
}>()

const { t } = useI18n()
const { isRecording, isTranscribing, error, toggleRecording } = useVoiceInput()

async function onClick() {
  if (props.disabled || isTranscribing.value) return
  try {
    await toggleRecording((text) => {
      emit('result', text)
    })
    if (error.value) emit('error', error.value)
  } catch (e) {
    emit('error', e instanceof Error ? e.message : t('pages.settings.voiceClone.micFailed'))
  }
}
</script>

<template>
  <NSpin :show="isTranscribing" size="small">
    <NButton
      :size="size"
      :type="isRecording ? 'error' : 'default'"
      :disabled="disabled || isTranscribing"
      :title="isRecording ? t('pages.settings.voiceClone.stopMic') : t('pages.settings.voiceClone.startMic')"
      @click="onClick"
    >
      <template #icon>
        <NIcon :component="isRecording ? StopOutline : MicOutline" />
      </template>
    </NButton>
  </NSpin>
</template>
