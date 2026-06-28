<script setup lang="ts">
import { computed } from 'vue'
import { NAlert, NInput, NText } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import FieldHint from '@/components/settings/FieldHint.vue'
import { isValidFishAudioReferenceId } from '@/utils/fish-audio'

const props = defineProps<{ engine: 'elevenlabs' | 'fishaudio' }>()

const { t } = useI18n()
const { settings, updateVoice } = useVoiceAssistantSettings()

const fishVoiceIdInvalid = computed(() => {
  if (props.engine !== 'fishaudio') return false
  const id = settings.value.voice.fishAudioVoiceId?.trim()
  return !!id && !isValidFishAudioReferenceId(id)
})
</script>

<template>
  <div class="cloud-clone-tts-fields">
    <template v-if="engine === 'elevenlabs'">
      <div>
        <NText strong>{{ t('pages.settings.voiceAssistant.realtime.elApiKeyLabel') }}</NText>
        <NInput
          :value="settings.voice.elevenLabsApiKey"
          type="password"
          show-password-on="click"
          placeholder="xi-api-key..."
          style="margin-top: 8px"
          @update:value="(v) => updateVoice({ elevenLabsApiKey: v })"
        />
      </div>
      <div>
        <NText strong>Voice ID<FieldHint :text="t('pages.settings.voiceAssistant.persona.elVoiceIdHint')" /></NText>
        <NInput
          :value="settings.voice.elevenLabsVoiceId"
          placeholder="ElevenLabs Voice ID"
          style="margin-top: 8px"
          @update:value="(v) => updateVoice({ elevenLabsVoiceId: v })"
        />
      </div>
    </template>

    <template v-else>
      <div>
        <NText strong>{{ t('pages.settings.voiceAssistant.persona.fishApiKeyLabel') }}</NText>
        <NInput
          :value="settings.voice.fishAudioApiKey"
          type="password"
          show-password-on="click"
          placeholder="fish_sk_..."
          style="margin-top: 8px"
          @update:value="(v) => updateVoice({ fishAudioApiKey: v })"
        />
      </div>
      <div>
        <NText strong>Voice ID<FieldHint :text="t('pages.settings.voiceAssistant.persona.fishVoiceIdHint')" /></NText>
        <NInput
          :value="settings.voice.fishAudioVoiceId"
          placeholder="Fish Audio reference_id"
          style="margin-top: 8px"
          @update:value="(v) => updateVoice({ fishAudioVoiceId: v })"
        />
        <NAlert v-if="fishVoiceIdInvalid" type="warning" :show-icon="false" style="margin-top: 8px">
          {{ t('pages.settings.voiceAssistant.persona.fishVoiceInvalid') }}
        </NAlert>
      </div>
    </template>
  </div>
</template>

<style scoped>
.cloud-clone-tts-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 4px;
}
</style>
