<script setup lang="ts">
import { computed } from 'vue'
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
import { TTS_VOICE_PRESETS, type TtsEngine, type ReplyLanguage } from '@/constants/voiceAssistant'
import VoiceApiKeyCard from '@/components/settings/VoiceApiKeyCard.vue'
import VoiceSetupWizard from '@/components/settings/VoiceSetupWizard.vue'

const props = withDefaults(
  defineProps<{ cardClass?: string; section?: 'full' | 'core' | 'advanced' }>(),
  { cardClass: '', section: 'full' },
)

const { t, locale } = useI18n()
const showCore = computed(() => props.section === 'full' || props.section === 'core')
const showAdvanced = computed(() => props.section === 'full' || props.section === 'advanced')
const { settings, updateVoice, applyReplyLanguageChange } = useVoiceAssistantSettings()

const CORE_ENGINES: TtsEngine[] = ['edgetts', 'kokoro', 'webspeech']

const engineOptions = computed(() =>
  CORE_ENGINES.map((value) => ({
    value,
    label:
      value === 'edgetts'
        ? t('pages.settings.voiceAssistant.voice.engineEdgetts')
        : value === 'kokoro'
          ? t('pages.settings.voiceAssistant.voice.engineKokoro')
          : t('pages.settings.voiceAssistant.voice.engineWebspeech'),
  })),
)

const voicePresetOptions = computed(() =>
  TTS_VOICE_PRESETS.filter((p) => p.engine === settings.value.voice.ttsEngine).map((p) => ({
    label: t(p.labelKey),
    value: p.voice,
  })),
)

const replyLanguageOptions = computed(() => [
  { label: t('pages.settings.voiceAssistant.voice.replyLangAuto'), value: 'auto' as ReplyLanguage },
  { label: t('pages.settings.voiceAssistant.voice.replyLangZh'), value: 'zh' as ReplyLanguage },
  { label: t('pages.settings.voiceAssistant.voice.replyLangEn'), value: 'en' as ReplyLanguage },
])

function onReplyLanguageChange(lang: ReplyLanguage) {
  applyReplyLanguageChange(lang)
}

function onEngineChange(engine: string) {
  const eng = engine as TtsEngine
  if (!CORE_ENGINES.includes(eng)) return
  const preset = TTS_VOICE_PRESETS.find((p) => p.engine === eng)
  updateVoice({
    ttsEngine: eng,
    ttsVoice: preset?.voice || settings.value.voice.ttsVoice,
    useCloneVoice: false,
  })
}
</script>

<template>
  <div v-if="showCore">
    <VoiceSetupWizard v-if="props.section === 'core'" />

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

        <NDivider />

        <div>
          <NText strong>{{ t('pages.settings.voiceAssistant.voice.replyLanguage') }}</NText>
          <NSelect
            :value="settings.voice.replyLanguage"
            :options="replyLanguageOptions"
            style="margin-top: 8px; max-width: 360px"
            @update:value="onReplyLanguageChange"
          />
          <NText depth="3" style="display: block; font-size: 12px; margin-top: 6px">
            {{ t('pages.settings.voiceAssistant.voice.replyLanguageHint') }}
          </NText>
        </div>

        <div>
          <NText strong>{{ t('pages.settings.voiceAssistant.voice.engine') }}</NText>
          <NSelect
            :value="settings.voice.ttsEngine"
            :options="engineOptions"
            style="margin-top: 8px; max-width: 360px"
            @update:value="onEngineChange"
          />
          <NText depth="3" style="display: block; font-size: 12px; margin-top: 6px">
            {{ t('pages.settings.voiceAssistant.voice.engineHint') }}
          </NText>
        </div>

        <div>
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
  </div>

  <div v-else-if="showAdvanced && props.section === 'advanced'">
    <VoiceApiKeyCard :card-class="cardClass" />

    <NCard :class="cardClass" style="margin-top: 16px">
      <NSpace vertical :size="12">
        <div>
          <NSwitch
            :value="settings.voice.streamingTts"
            @update:value="(v) => updateVoice({ streamingTts: v })"
          />
          <NText style="margin-left: 8px">{{ t('pages.settings.voiceAssistant.voice.streamingTts') }}</NText>
        </div>
      </NSpace>
      <NText depth="3" style="display: block; font-size: 12px; margin-top: 12px; line-height: 1.6">
        {{ t('pages.settings.voiceAssistant.voice.cloneCloudHint') }}
      </NText>
    </NCard>
  </div>
</template>
