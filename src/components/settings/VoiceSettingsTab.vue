<script setup lang="ts">
import { computed, watch } from 'vue'
import {
  NCard,
  NSpace,
  NSwitch,
  NText,
  NSelect,
  NSlider,
  NInputNumber,
  NDivider,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import { TTS_VOICE_PRESETS } from '@/constants/voiceAssistant'
import VoiceCloneSettingsCard from '@/components/settings/VoiceCloneSettingsCard.vue'

withDefaults(defineProps<{ cardClass?: string }>(), { cardClass: '' })

const { t } = useI18n()
const { settings, updateVoice } = useVoiceAssistantSettings()

const engineOptions = computed(() => [
  { label: t('pages.settings.voiceAssistant.voice.engineCosyvoice'), value: 'cosyvoice' },
  { label: t('pages.settings.voiceAssistant.voice.engineKokoro'), value: 'kokoro' },
  { label: t('pages.settings.voiceAssistant.voice.engineEdgetts'), value: 'edgetts' },
  { label: t('pages.settings.voiceAssistant.voice.engineWebspeech'), value: 'webspeech' },
])

const voicePresetOptions = computed(() =>
  TTS_VOICE_PRESETS.filter((p) => p.engine === settings.value.voice.ttsEngine).map((p) => ({
    label: t(p.labelKey),
    value: p.voice,
  })),
)

function onEngineChange(engine: string) {
  const preset = TTS_VOICE_PRESETS.find((p) => p.engine === engine)
  updateVoice({
    ttsEngine: engine as typeof settings.value.voice.ttsEngine,
    ttsVoice: preset?.voice || settings.value.voice.ttsVoice,
    useCloneVoice: engine === 'cosyvoice',
  })
}

watch(
  () => settings.value.voice.ttsEngine,
  (engine) => {
    const wantClone = engine === 'cosyvoice'
    if (settings.value.voice.useCloneVoice !== wantClone) {
      updateVoice({ useCloneVoice: wantClone })
    }
  },
  { immediate: true },
)
</script>

<template>
  <div>
    <NCard :title="t('pages.settings.voiceAssistant.voice.title')" :class="cardClass">
      <NSpace vertical :size="16">
        <div>
          <NSwitch :value="settings.voice.enabled" @update:value="(v) => updateVoice({ enabled: v })" />
          <NText style="margin-left: 8px">{{ t('pages.settings.tts.enable') }}</NText>
        </div>
        <div>
          <NSwitch :value="settings.voice.autoPlay" @update:value="(v) => updateVoice({ autoPlay: v })" />
          <NText style="margin-left: 8px">{{ t('pages.settings.tts.autoPlay') }}</NText>
          <NText depth="3" style="display: block; font-size: 13px; margin-top: 4px">
            {{ t('pages.settings.tts.autoPlayHint') }}
          </NText>
        </div>
        <div>
          <NSwitch :value="settings.voice.streamingTts" @update:value="(v) => updateVoice({ streamingTts: v })" />
          <NText style="margin-left: 8px">{{ t('pages.settings.voiceAssistant.voice.streamingTts') }}</NText>
        </div>

        <NDivider />

        <div>
          <NText strong>{{ t('pages.settings.voiceAssistant.voice.engine') }}</NText>
          <NSelect
            :value="settings.voice.ttsEngine"
            :options="engineOptions"
            style="margin-top: 8px; max-width: 360px"
            @update:value="onEngineChange"
          />
        </div>

        <div v-if="settings.voice.ttsEngine !== 'cosyvoice'">
          <NText strong>{{ t('pages.settings.voiceAssistant.voice.presetVoice') }}</NText>
          <NSelect
            :value="settings.voice.ttsVoice"
            :options="voicePresetOptions"
            style="margin-top: 8px; max-width: 420px"
            @update:value="(v) => updateVoice({ ttsVoice: v })"
          />
        </div>

        <div>
          <NText strong>{{ t('pages.settings.tts.rate') }}</NText>
          <NSlider
            :value="settings.voice.rate"
            :min="0.5"
            :max="2"
            :step="0.1"
            style="margin-top: 8px; max-width: 320px"
            @update:value="(v) => updateVoice({ rate: v })"
          />
        </div>
        <div>
          <NText strong>{{ t('pages.settings.tts.volume') }}</NText>
          <NInputNumber
            :value="settings.voice.volume"
            :min="0"
            :max="1"
            :step="0.1"
            style="margin-top: 8px; width: 120px"
            @update:value="(v) => updateVoice({ volume: v ?? 1 })"
          />
        </div>
      </NSpace>
    </NCard>

    <VoiceCloneSettingsCard
      v-if="settings.voice.ttsEngine === 'cosyvoice'"
      card-class="office-settings-card"
      style="margin-top: 16px"
    />
  </div>
</template>
