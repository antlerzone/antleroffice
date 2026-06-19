<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NCard, NSpace, NSwitch, NText, NInput, NButton, NAlert, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import { useVoiceOutput } from '@/composables/useVoiceOutput'
import {
  DEFAULT_JARVIS_PERSONA_PROMPT,
} from '@/constants/voiceAssistant'

withDefaults(defineProps<{ cardClass?: string }>(), { cardClass: '' })

const { t, locale } = useI18n()
const message = useMessage()
const api = useAntlerApi()
const { settings, updatePersona, honorific } = useVoiceAssistantSettings()
const { speak, stop, isPlaying, isSynthesizing } = useVoiceOutput()

const previewText = ref('')
const loadingTemplate = ref(false)

const sampleReply = computed(() => {
  const h = honorific.value
  const zhStyle = locale.value.startsWith('zh') || /[\u4e00-\u9fff]/.test(h)
  if (zhStyle) {
    return `${h}，今日办公室一切正常。需要我为您安排什么吗？`
  }
  return `Good morning, ${h}. The office is running smoothly. What would you like me to handle?`
})

async function loadDefaultTemplate() {
  loadingTemplate.value = true
  try {
    const res = await api.get<{ ok: boolean; template?: string }>('/api/voice/persona/template')
    return (res.template || DEFAULT_JARVIS_PERSONA_PROMPT).trim()
  } catch {
    return DEFAULT_JARVIS_PERSONA_PROMPT
  } finally {
    loadingTemplate.value = false
  }
}

async function ensureSystemPromptVisible() {
  if (String(settings.value.persona.systemPrompt || '').trim()) return
  updatePersona({ systemPrompt: await loadDefaultTemplate() })
}

async function resetSystemPrompt() {
  updatePersona({ systemPrompt: await loadDefaultTemplate() })
  message.success(t('pages.settings.voiceAssistant.persona.resetDone'))
}

async function loadSampleReply() {
  previewText.value = sampleReply.value
}

async function previewPersona() {
  const text = previewText.value.trim() || sampleReply.value
  try {
    await speak(text)
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.settings.tts.previewFailed'))
  }
}

onMounted(() => {
  void ensureSystemPromptVisible()
})
</script>

<template>
  <NCard :title="t('pages.settings.voiceAssistant.persona.title')" :class="cardClass">
    <NSpace vertical :size="16">
      <NAlert type="info">
        {{ t('pages.settings.voiceAssistant.persona.hint') }}
      </NAlert>

      <div>
        <NSwitch :value="settings.persona.enabled" @update:value="(v) => updatePersona({ enabled: v })" />
        <NText style="margin-left: 8px">{{ t('pages.settings.voiceAssistant.persona.enableJarvis') }}</NText>
      </div>

      <NSpace vertical :size="8" class="persona-honorific-field">
        <NText strong tag="div">{{ t('pages.settings.voiceAssistant.persona.honorific') }}</NText>
        <NInput
          :value="settings.persona.honorific"
          :placeholder="t('pages.settings.voiceAssistant.persona.honorificPlaceholder')"
          style="max-width: 320px"
          @update:value="(v) => updatePersona({ honorific: v })"
        />
        <NText depth="3" style="font-size: 13px">
          {{ t('pages.settings.voiceAssistant.persona.honorificHint') }}
        </NText>
      </NSpace>

      <div>
        <NSpace align="center" justify="space-between" style="max-width: 720px">
          <NText strong>{{ t('pages.settings.voiceAssistant.persona.systemPrompt') }}</NText>
          <NButton size="small" :loading="loadingTemplate" @click="resetSystemPrompt">
            {{ t('pages.settings.voiceAssistant.persona.resetDefault') }}
          </NButton>
        </NSpace>
        <NText depth="3" style="display: block; font-size: 13px; margin-top: 4px">
          {{ t('pages.settings.voiceAssistant.persona.systemPromptHint') }}
        </NText>
        <NInput
          :value="settings.persona.systemPrompt"
          type="textarea"
          :autosize="{ minRows: 10, maxRows: 18 }"
          style="margin-top: 8px; max-width: 720px; font-family: ui-monospace, monospace; font-size: 13px"
          @update:value="(v) => updatePersona({ systemPrompt: v })"
        />
      </div>

      <div class="persona-test-mode">
        <NText strong>{{ t('pages.settings.voiceAssistant.persona.testModeTitle') }}</NText>
        <NText depth="3" style="display: block; font-size: 13px; margin-top: 4px">
          {{ t('pages.settings.voiceAssistant.persona.testModeHint') }}
        </NText>
        <NInput
          v-model:value="previewText"
          type="textarea"
          :placeholder="sampleReply"
          :autosize="{ minRows: 2, maxRows: 4 }"
          style="margin-top: 8px; max-width: 720px"
        />
        <NSpace style="margin-top: 8px">
          <NButton :loading="isSynthesizing" :disabled="isPlaying" @click="previewPersona">
            {{ t('pages.settings.tts.play') }}
          </NButton>
          <NButton v-if="isPlaying" @click="stop">{{ t('pages.settings.tts.stop') }}</NButton>
          <NButton @click="loadSampleReply">
            {{ t('pages.settings.voiceAssistant.persona.loadSample') }}
          </NButton>
        </NSpace>
      </div>
    </NSpace>
  </NCard>
</template>

<style scoped>
.persona-honorific-field {
  max-width: 360px;
}

.persona-honorific-field :deep(.n-text) {
  line-height: 1.4;
}
</style>
