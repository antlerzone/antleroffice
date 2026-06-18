<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  NCard,
  NSpace,
  NAlert,
  NSwitch,
  NDivider,
  NText,
  NSelect,
  NSlider,
  NInputNumber,
  NInput,
  NButton,
  NSpin,
  NIcon,
  useMessage,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { VolumeHighOutline, StopOutline } from '@vicons/ionicons5'
import { useTTSSettings } from '@/composables/useTTSSettings'
import { useEdgeTTS } from '@/composables/useEdgeTTS'

withDefaults(
  defineProps<{
    cardClass?: string
  }>(),
  { cardClass: '' },
)

const { t } = useI18n()
const message = useMessage()
const { settings: ttsSettings, resetSettings: resetTTSSettings } = useTTSSettings()
const ttsVoices = ref<{ label: string; value: string; lang?: string }[]>([])
const ttsLoading = ref(false)
const ttsSaving = ref(false)
const ttsPreviewText = ref('你好，这是一个语音测试。')
const { speak: ttsSpeak, stop: ttsStop, isPlaying: ttsIsPlaying, isLoading: ttsIsLoading } = useEdgeTTS()

async function loadTTSSettings() {
  ttsLoading.value = true
  try {
    let voices = window.speechSynthesis.getVoices()
    if (voices.length === 0) {
      await new Promise<void>((resolve) => {
        const handleVoicesChanged = () => {
          window.speechSynthesis.removeEventListener('voiceschanged', handleVoicesChanged)
          resolve()
        }
        window.speechSynthesis.addEventListener('voiceschanged', handleVoicesChanged)
        setTimeout(() => {
          window.speechSynthesis.removeEventListener('voiceschanged', handleVoicesChanged)
          resolve()
        }, 2000)
      })
      voices = window.speechSynthesis.getVoices()
    }

    const voiceOptions: { label: string; value: string; lang?: string }[] = []
    const langGroups = new Map<string, SpeechSynthesisVoice[]>()
    for (const voice of voices) {
      const lang = voice.lang.split('-')[0] || 'other'
      if (!langGroups.has(lang)) langGroups.set(lang, [])
      langGroups.get(lang)!.push(voice)
    }

    for (const v of langGroups.get('zh') || []) {
      voiceOptions.push({ label: `${v.name} (${v.lang})`, value: v.name, lang: v.lang })
    }
    for (const v of langGroups.get('en') || []) {
      voiceOptions.push({ label: `${v.name} (${v.lang})`, value: v.name, lang: v.lang })
    }
    for (const [lang, voiceList] of langGroups) {
      if (lang === 'zh' || lang === 'en') continue
      for (const v of voiceList) {
        voiceOptions.push({ label: `${v.name} (${v.lang})`, value: v.name, lang: v.lang })
      }
    }
    ttsVoices.value = voiceOptions
  } catch (err) {
    console.error('[TtsSettingsCard] Failed to load voices:', err)
  } finally {
    ttsLoading.value = false
  }
}

async function handlePreviewTTS() {
  if (ttsIsPlaying.value || ttsIsLoading.value) {
    ttsStop()
    return
  }
  try {
    await ttsSpeak(ttsPreviewText.value, {
      voice: ttsSettings.value.voice,
      rate: ttsSettings.value.rate,
      volume: ttsSettings.value.volume,
      pitch: ttsSettings.value.pitch,
    })
  } catch (err) {
    console.error('[TtsSettingsCard] TTS preview error:', err)
    message.error(t('pages.settings.tts.previewFailed'))
  }
}

async function handleSaveTTS() {
  ttsSaving.value = true
  try {
    await new Promise((resolve) => setTimeout(resolve, 300))
    message.success(t('pages.settings.tts.saveSuccess'))
  } finally {
    ttsSaving.value = false
  }
}

function handleResetTTS() {
  resetTTSSettings()
  message.success(t('pages.settings.tts.resetSuccess'))
}

onMounted(() => {
  void loadTTSSettings()
})
</script>

<template>
  <NCard :title="t('pages.settings.tts.title')" :class="cardClass">
    <NSpin :show="ttsLoading">
      <NSpace vertical :size="16">
        <NAlert type="info" :bordered="false">
          {{ t('pages.settings.tts.hint') }}
        </NAlert>

        <div>
          <NSpace align="center" :size="12">
            <NSwitch v-model:value="ttsSettings.enabled" />
            <NText>{{ t('pages.settings.tts.enable') }}</NText>
          </NSpace>
        </div>

        <NDivider style="margin: 0" />

        <div>
          <NText strong style="display: block; margin-bottom: 4px">{{ t('pages.settings.tts.autoPlay') }}</NText>
          <NText depth="3" style="font-size: 13px; display: block; margin-bottom: 8px">
            {{ t('pages.settings.tts.autoPlayHint') }}
          </NText>
          <NSpace align="center" :size="12">
            <NSwitch v-model:value="ttsSettings.autoPlay" />
          </NSpace>
        </div>

        <NDivider style="margin: 0" />

        <div>
          <NText strong style="display: block; margin-bottom: 4px">{{ t('pages.settings.tts.voice') }}</NText>
          <NText depth="3" style="font-size: 13px; display: block; margin-bottom: 8px">
            {{ t('pages.settings.tts.voiceHint') }}
          </NText>
          <NSelect
            v-model:value="ttsSettings.voice"
            :options="ttsVoices"
            :placeholder="t('pages.settings.tts.voicePlaceholder')"
            filterable
            clearable
            style="max-width: 400px"
          />
        </div>

        <NDivider style="margin: 0" />

        <div>
          <NText strong style="display: block; margin-bottom: 4px">{{ t('pages.settings.tts.rate') }}</NText>
          <NText depth="3" style="font-size: 13px; display: block; margin-bottom: 8px">
            {{ t('pages.settings.tts.rateHint') }}
          </NText>
          <div style="max-width: 400px; display: flex; align-items: center; gap: 16px">
            <NSlider
              v-model:value="ttsSettings.rate"
              :min="0.1"
              :max="2.0"
              :step="0.1"
              :tooltip="true"
              :format-tooltip="(value: number) => `${value.toFixed(1)}x`"
              style="flex: 1"
            />
            <NInputNumber
              v-model:value="ttsSettings.rate"
              :min="0.1"
              :max="2.0"
              :step="0.1"
              size="small"
              style="width: 80px"
            >
              <template #suffix>x</template>
            </NInputNumber>
          </div>
        </div>

        <NDivider style="margin: 0" />

        <div>
          <NText strong style="display: block; margin-bottom: 4px">{{ t('pages.settings.tts.volume') }}</NText>
          <NText depth="3" style="font-size: 13px; display: block; margin-bottom: 8px">
            {{ t('pages.settings.tts.volumeHint') }}
          </NText>
          <div style="max-width: 400px; display: flex; align-items: center; gap: 16px">
            <NSlider
              v-model:value="ttsSettings.volume"
              :min="0"
              :max="1"
              :step="0.1"
              :tooltip="true"
              :format-tooltip="(value: number) => `${Math.round(value * 100)}%`"
              style="flex: 1"
            />
            <NInputNumber
              v-model:value="ttsSettings.volume"
              :min="0"
              :max="1"
              :step="0.1"
              size="small"
              style="width: 80px"
            />
          </div>
        </div>

        <NDivider style="margin: 0" />

        <div>
          <NText strong style="display: block; margin-bottom: 4px">{{ t('pages.settings.tts.pitch') }}</NText>
          <NText depth="3" style="font-size: 13px; display: block; margin-bottom: 8px">
            {{ t('pages.settings.tts.pitchHint') }}
          </NText>
          <div style="max-width: 400px; display: flex; align-items: center; gap: 16px">
            <NSlider
              v-model:value="ttsSettings.pitch"
              :min="0.1"
              :max="2.0"
              :step="0.1"
              :tooltip="true"
              :format-tooltip="(value: number) => value.toFixed(1)"
              style="flex: 1"
            />
            <NInputNumber
              v-model:value="ttsSettings.pitch"
              :min="0.1"
              :max="2.0"
              :step="0.1"
              size="small"
              style="width: 80px"
            />
          </div>
        </div>

        <NDivider style="margin: 0" />

        <div>
          <NText strong style="display: block; margin-bottom: 4px">{{ t('pages.settings.tts.preview') }}</NText>
          <NText depth="3" style="font-size: 13px; display: block; margin-bottom: 8px">
            {{ t('pages.settings.tts.previewHint') }}
          </NText>
          <NSpace :size="12" align="center" style="max-width: 400px">
            <NInput
              v-model:value="ttsPreviewText"
              :placeholder="t('pages.settings.tts.previewPlaceholder')"
              style="flex: 1"
            />
            <NButton
              :type="ttsIsPlaying || ttsIsLoading ? 'error' : 'primary'"
              :loading="ttsIsLoading && !ttsIsPlaying"
              @click="handlePreviewTTS"
            >
              <template #icon>
                <NIcon :component="ttsIsPlaying || ttsIsLoading ? StopOutline : VolumeHighOutline" />
              </template>
              {{ ttsIsPlaying ? t('pages.settings.tts.stop') : t('pages.settings.tts.play') }}
            </NButton>
          </NSpace>
        </div>

        <NDivider style="margin: 0" />

        <NSpace :size="8">
          <NButton type="primary" :loading="ttsSaving" @click="handleSaveTTS">
            {{ t('common.save') }}
          </NButton>
          <NButton @click="handleResetTTS">
            {{ t('common.reset') }}
          </NButton>
        </NSpace>
      </NSpace>
    </NSpin>
  </NCard>
</template>
