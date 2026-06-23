<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NCard, NSpace, NSwitch, NText, NInput, NButton, NAlert, NSelect, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import { usePersonaVoice } from '@/composables/usePersonaVoice'
import { useVoiceOutput } from '@/composables/useVoiceOutput'
import { DEFAULT_JARVIS_PERSONA_PROMPT, DEFAULT_JARVIS_PERSONA_PROMPT_ZH, resolveReplyLanguage, type PersonaReplyVoice } from '@/constants/voiceAssistant'
import { savePersonaGreetingCache } from '@/lib/persona-greeting-cache'
import { isValidFishAudioReferenceId } from '@/utils/fish-audio'

const props = withDefaults(
  defineProps<{ cardClass?: string; section?: 'full' | 'core' | 'advanced' }>(),
  { cardClass: '', section: 'full' },
)

const { t, locale } = useI18n()
const message = useMessage()
const api = useAntlerApi()
const { settings, updatePersona } = useVoiceAssistantSettings()
const { resolvedSampleReply, personaSpeakOptions, cloudTtsReady } = usePersonaVoice()
const { speak, stop, isPlaying, isSynthesizing, synthesizePersonaLine, playBlob } = useVoiceOutput()

const showCore = computed(() => props.section === 'full' || props.section === 'core')
const showAdvanced = computed(() => props.section === 'full' || props.section === 'advanced')

const previewText = ref('')
const loadingTemplate = ref(false)

const replyVoiceOptions = computed(() => [
  { label: t('pages.settings.voiceAssistant.persona.replyVoiceDefault'), value: 'default' as PersonaReplyVoice },
  { label: t('pages.settings.voiceAssistant.persona.replyVoiceElevenLabs'), value: 'elevenlabs' as PersonaReplyVoice },
  { label: t('pages.settings.voiceAssistant.persona.replyVoiceFish'), value: 'fishaudio' as PersonaReplyVoice },
])

const fishVoiceInvalid = computed(() => {
  if (settings.value.persona.replyVoice !== 'fishaudio') return false
  const id = settings.value.voice.fishAudioVoiceId?.trim() || settings.value.realtime.fishAudioVoiceId?.trim()
  return !id || !isValidFishAudioReferenceId(id)
})

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

function loadSampleReply() {
  previewText.value = resolvedSampleReply.value
}

const savingSample = ref(false)

async function cacheGreetingForSave(text: string) {
  const opts = personaSpeakOptions()
  const blob = await synthesizePersonaLine(text, opts)
  if (!blob) return false
  await savePersonaGreetingCache(text, opts, blob)
  return true
}

function saveSampleReply() {
  const text = previewText.value.trim()
  if (!text) {
    message.warning(t('pages.settings.voiceAssistant.persona.sampleEmpty'))
    return
  }
  updatePersona({ sampleReply: text })
  savingSample.value = true
  void cacheGreetingForSave(text)
    .then((cached) => {
      message.success(
        cached
          ? t('pages.settings.voiceAssistant.persona.sampleSavedCached')
          : t('pages.settings.voiceAssistant.persona.sampleSaved'),
      )
    })
    .catch(() => {
      message.success(t('pages.settings.voiceAssistant.persona.sampleSaved'))
    })
    .finally(() => {
      savingSample.value = false
    })
}

async function previewPersona() {
  const text = previewText.value.trim() || resolvedSampleReply.value
  const opts = personaSpeakOptions()
  if (opts?.engine === 'elevenlabs' && !cloudTtsReady('elevenlabs')) {
    message.error(t('pages.settings.voiceAssistant.persona.missingElevenLabs'))
    return
  }
  if (opts?.engine === 'fishaudio' && !cloudTtsReady('fishaudio')) {
    message.error(t('pages.settings.voiceAssistant.persona.missingFishAudio'))
    return
  }
  try {
    const blob = await synthesizePersonaLine(text, opts)
    if (blob) {
      await savePersonaGreetingCache(text, opts, blob)
      await playBlob(blob)
    } else {
      await speak(text, opts)
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.settings.tts.previewFailed'))
  }
}

onMounted(() => {
  void ensureSystemPromptVisible()
  previewText.value = settings.value.persona.sampleReply?.trim() || resolvedSampleReply.value
})
</script>

<template>
  <NCard
    v-if="showCore"
    :title="t('pages.settings.voiceAssistant.persona.title')"
    :class="cardClass"
  >
    <NSpace vertical :size="16">
      <NAlert type="info" :show-icon="false">
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

      <div class="persona-test-mode">
        <NText strong>{{ t('pages.settings.voiceAssistant.persona.testModeTitle') }}</NText>
        <NText depth="3" style="display: block; font-size: 13px; margin-top: 4px">
          {{ t('pages.settings.voiceAssistant.persona.testModeHint') }}
        </NText>
        <NInput
          v-model:value="previewText"
          type="textarea"
          :placeholder="resolvedSampleReply"
          :autosize="{ minRows: 2, maxRows: 4 }"
          style="margin-top: 8px; max-width: 720px"
        />
        <NSpace vertical :size="8" style="margin-top: 10px; max-width: 360px">
          <NText strong>{{ t('pages.settings.voiceAssistant.persona.replyVoice') }}</NText>
          <NSelect
            :value="settings.persona.replyVoice"
            :options="replyVoiceOptions"
            @update:value="(v) => updatePersona({ replyVoice: v })"
          />
          <NText depth="3" style="font-size: 12px">
            {{ t('pages.settings.voiceAssistant.persona.replyVoiceHint') }}
          </NText>
          <NAlert v-if="fishVoiceInvalid" type="warning" :show-icon="false" style="margin-top: 4px">
            {{ t('pages.settings.voiceAssistant.persona.fishVoiceInvalid') }}
          </NAlert>
        </NSpace>
        <NSpace style="margin-top: 8px">
          <NButton type="primary" :loading="savingSample" @click="saveSampleReply">
            {{ t('pages.settings.voiceAssistant.persona.saveSample') }}
          </NButton>
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
