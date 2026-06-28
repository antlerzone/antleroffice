<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NCard, NSpace, NSwitch, NText, NInput, NButton, NAlert, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import FieldHint from '@/components/settings/FieldHint.vue'
import { DEFAULT_JARVIS_PERSONA_PROMPT, DEFAULT_JARVIS_PERSONA_PROMPT_ZH, resolveReplyLanguage } from '@/constants/voiceAssistant'

const props = withDefaults(
  defineProps<{ cardClass?: string; section?: 'full' | 'core' | 'advanced' }>(),
  { cardClass: '', section: 'full' },
)

const { t, locale } = useI18n()
const message = useMessage()
const api = useAntlerApi()
const { settings, updatePersona } = useVoiceAssistantSettings()

const showCore = computed(() => props.section === 'full' || props.section === 'core')
const showAdvanced = computed(() => props.section === 'full' || props.section === 'advanced')

const loadingTemplate = ref(false)

async function loadDefaultTemplate() {
  loadingTemplate.value = true
  try {
    const lang = resolveReplyLanguage(settings.value.voice.replyLanguage, locale.value)
    const res = await api.get<{ ok: boolean; template?: string }>(
      `/api/voice/persona/template?lang=${lang}`,
    )
    const fallback = lang === 'zh' ? DEFAULT_JARVIS_PERSONA_PROMPT_ZH : DEFAULT_JARVIS_PERSONA_PROMPT
    return (res.template || fallback).trim()
  } catch {
    const lang = resolveReplyLanguage(settings.value.voice.replyLanguage, locale.value)
    return lang === 'zh' ? DEFAULT_JARVIS_PERSONA_PROMPT_ZH : DEFAULT_JARVIS_PERSONA_PROMPT
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

onMounted(() => {
  void ensureSystemPromptVisible()
})
</script>

<template>
  <NCard
    v-if="showCore"
    :title="t('pages.settings.voiceAssistant.persona.title')"
    :class="cardClass"
  >
    <NSpace vertical :size="16">
      <div>
        <NSwitch :value="settings.persona.enabled" @update:value="(v) => updatePersona({ enabled: v })" />
        <NText style="margin-left: 8px">{{ t('pages.settings.voiceAssistant.persona.enableJarvis') }}</NText>
        <FieldHint :text="t('pages.settings.voiceAssistant.persona.hint')" />
      </div>

      <NSpace vertical :size="8" class="persona-honorific-field">
        <NText strong tag="div">
          {{ t('pages.settings.voiceAssistant.persona.honorific') }}
          <FieldHint :text="t('pages.settings.voiceAssistant.persona.honorificHint')" />
        </NText>
        <NInput
          :value="settings.persona.honorific"
          :placeholder="t('pages.settings.voiceAssistant.persona.honorificPlaceholder')"
          style="max-width: 320px"
          @update:value="(v) => updatePersona({ honorific: v })"
        />
      </NSpace>
    </NSpace>
  </NCard>

  <div v-else-if="showAdvanced && props.section === 'advanced'">
    <NSpace vertical :size="8" style="max-width: 720px">
      <NSpace align="center" justify="space-between">
        <NText strong>{{ t('pages.settings.voiceAssistant.persona.systemPrompt') }}</NText>
        <NButton size="small" :loading="loadingTemplate" @click="resetSystemPrompt">
          {{ t('pages.settings.voiceAssistant.persona.resetDefault') }}
        </NButton>
      </NSpace>
      <NText depth="3" style="font-size: 13px">
        {{ t('pages.settings.voiceAssistant.persona.systemPromptHint') }}
      </NText>
      <NInput
        :value="settings.persona.systemPrompt"
        type="textarea"
        :autosize="{ minRows: 10, maxRows: 18 }"
        style="font-family: ui-monospace, monospace; font-size: 13px"
        @update:value="(v) => updatePersona({ systemPrompt: v })"
      />
    </NSpace>
  </div>
</template>

<style scoped>
.persona-honorific-field {
  max-width: 360px;
}
</style>
