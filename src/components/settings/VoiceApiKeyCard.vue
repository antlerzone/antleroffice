<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  NCard,
  NSpace,
  NText,
  NInput,
  NSelect,
  NAlert,
  NButton,
  NCollapse,
  NCollapseItem,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'

withDefaults(defineProps<{ cardClass?: string }>(), { cardClass: '' })

const { t } = useI18n()
const {
  settings,
  updateVoiceApi,
  syncVoiceApiToServer,
  loadVoiceApiFromServer,
  hasUserOpenAiKey,
  userOpenAiKey,
} = useVoiceAssistantSettings()

const draftKey = ref('')
const saving = ref(false)

const sttModelOptions = computed(() => [
  { label: t('pages.settings.voiceAssistant.voiceApi.modelMini'), value: 'gpt-4o-mini-transcribe' },
  { label: t('pages.settings.voiceAssistant.voiceApi.model4o'), value: 'gpt-4o-transcribe' },
  { label: t('pages.settings.voiceAssistant.voiceApi.modelWhisper'), value: 'whisper-1' },
])

const usesOpenClawKey = computed(
  () => settings.value.voiceApi.openclawOpenAiKeyConfigured === true,
)
const hasVoiceOverride = computed(
  () => !!userOpenAiKey() || !!settings.value.voiceApi.hasSttKey,
)

const statusHint = computed(() => {
  if (hasVoiceOverride.value) {
    return t('pages.settings.voiceAssistant.voiceApi.statusOverride')
  }
  if (usesOpenClawKey.value) {
    return t('pages.settings.voiceAssistant.voiceApi.statusOpenClaw')
  }
  return t('pages.settings.voiceAssistant.voiceApi.statusMissing')
})

const alertType = computed(() => (hasUserOpenAiKey() ? 'success' : 'warning'))

onMounted(async () => {
  draftKey.value = settings.value.voiceApi.sttApiKey || ''
  await loadVoiceApiFromServer()
  if (!draftKey.value && settings.value.voiceApi.hasSttKey) {
    draftKey.value = '********'
  }
})

async function saveKey() {
  saving.value = true
  try {
    const key = draftKey.value.trim()
    if (key && key !== '********') {
      updateVoiceApi({ sttApiKey: key })
    } else {
      await syncVoiceApiToServer()
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NCard :title="t('pages.settings.voiceAssistant.voiceApi.title')" :class="cardClass">
    <NSpace vertical :size="14">
      <NText depth="3" style="font-size: 13px; line-height: 1.6">
        {{ t('pages.settings.voiceAssistant.voiceApi.intro') }}
      </NText>

      <NAlert :type="alertType" :show-icon="false">
        {{ statusHint }}
      </NAlert>

      <div>
        <NText style="font-size: 13px; display: block; margin-bottom: 6px">
          {{ t('pages.settings.voiceAssistant.voiceApi.sttModelLabel') }}
        </NText>
        <NSelect
          :value="settings.voiceApi.openaiSttModel"
          :options="sttModelOptions"
          style="max-width: 360px"
          @update:value="(v) => updateVoiceApi({ openaiSttModel: v })"
        />
      </div>

      <NCollapse>
        <NCollapseItem :title="t('pages.settings.voiceAssistant.voiceApi.overrideTitle')" name="override">
          <NSpace vertical :size="10">
            <NText depth="3" style="font-size: 12px; line-height: 1.6">
              {{ t('pages.settings.voiceAssistant.voiceApi.overrideHint') }}
            </NText>
            <NInput
              v-model:value="draftKey"
              type="password"
              show-password-on="click"
              :placeholder="t('pages.settings.voiceAssistant.voiceApi.sttKeyPlaceholder')"
            />
            <NButton type="primary" :loading="saving" @click="saveKey">
              {{ t('pages.settings.voiceAssistant.voiceApi.saveKey') }}
            </NButton>
          </NSpace>
        </NCollapseItem>
      </NCollapse>
    </NSpace>
  </NCard>
</template>
