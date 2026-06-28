<script setup lang="ts">
import { computed } from 'vue'
import { NCard, NSpace, NSwitch, NText, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import { isSummonHost } from '@/lib/desktop-shell'
import WakePhraseEditor from '@/components/settings/WakePhraseEditor.vue'
import SummonAdvancedFields from '@/components/settings/SummonAdvancedFields.vue'
import FieldHint from '@/components/settings/FieldHint.vue'

withDefaults(defineProps<{ cardClass?: string }>(), { cardClass: '' })

const { t } = useI18n()
const { settings, updateVoiceApi } = useVoiceAssistantSettings()
const summonHost = computed(() => isSummonHost())

// Voice input (speech-to-text) options — turns what you say after waking into text.
const sttModelOptions = [
  { label: 'OpenAI · gpt-4o-mini-transcribe (recommended)', value: 'gpt-4o-mini-transcribe' },
  { label: 'OpenAI · whisper-1', value: 'whisper-1' },
]
</script>

<template>
  <NCard title="Voice Input" :class="cardClass">
    <NSpace vertical :size="16">
      <WakePhraseEditor :disabled="!summonHost" />

      <div>
        <NText strong>Voice input (speech-to-text)</NText>
        <FieldHint text="Turns what you say (after waking) into text for the assistant. Pick which engine recognises your speech." />
        <NSelect
          :value="settings.voiceApi.openaiSttModel"
          :options="sttModelOptions"
          style="margin-top: 8px; max-width: 360px"
          @update:value="(v) => updateVoiceApi({ openaiSttModel: v })"
        />
      </div>

      <SummonAdvancedFields />
    </NSpace>
  </NCard>
</template>
