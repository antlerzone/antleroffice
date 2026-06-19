<script setup lang="ts">
import { computed } from 'vue'
import {
  NCard,
  NSpace,
  NAlert,
  NSwitch,
  NText,
  NSelect,
  NInputNumber,
  NInput,
  NDivider,
  NSlider,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import WakePhraseEditor from '@/components/settings/WakePhraseEditor.vue'
import { isElectronApp } from '@/lib/desktop-shell'

withDefaults(defineProps<{ cardClass?: string }>(), { cardClass: '' })

const { t } = useI18n()
const { settings, updateSummon } = useVoiceAssistantSettings()

const electronOnly = computed(() => isElectronApp())

const wakeEngineOptions = computed(() => [
  { label: t('pages.settings.voiceAssistant.summon.engineOpenWakeWord'), value: 'openwakeword' },
  { label: t('pages.settings.voiceAssistant.summon.enginePorcupine'), value: 'porcupine' },
  { label: t('pages.settings.voiceAssistant.summon.engineWhisper'), value: 'whisper' },
])

const chimeOptions = computed(() => [
  { label: t('pages.settings.voiceAssistant.summon.chimeOff'), value: 'off' },
  { label: t('pages.settings.voiceAssistant.summon.chimeBeep'), value: 'beep' },
  { label: t('pages.settings.voiceAssistant.summon.chimeTts'), value: 'tts' },
])

const idleMinutes = computed({
  get: () => Math.round(settings.value.summon.idleTimeoutSec / 60),
  set: (m: number) => updateSummon({ idleTimeoutSec: Math.max(1, m) * 60 }),
})
</script>

<template>
  <NCard :title="t('pages.settings.voiceAssistant.summon.title')" :class="cardClass">
    <NAlert v-if="!electronOnly" type="info" style="margin-bottom: 12px">
      {{ t('pages.settings.voiceAssistant.summon.webHint') }}
    </NAlert>

    <NSpace vertical :size="16">
      <div>
        <NSwitch
          :value="settings.summon.globalListenEnabled"
          :disabled="!electronOnly"
          @update:value="(v) => updateSummon({ globalListenEnabled: v })"
        />
        <NText style="margin-left: 8px">{{ t('pages.settings.voiceAssistant.summon.globalListen') }}</NText>
        <NText depth="3" style="display: block; font-size: 13px; margin-top: 4px">
          {{ t('pages.settings.voiceAssistant.summon.globalListenHint') }}
        </NText>
      </div>

      <div>
        <NText strong>{{ t('pages.settings.voiceAssistant.summon.wakeEngine') }}</NText>
        <NSelect
          :value="settings.summon.wakeEngine"
          :options="wakeEngineOptions"
          :disabled="!electronOnly"
          style="margin-top: 8px; max-width: 360px"
          @update:value="(v) => updateSummon({ wakeEngine: v })"
        />
        <NAlert
          v-if="settings.summon.wakeEngine === 'openwakeword'"
          type="info"
          :show-icon="false"
          style="margin-top: 8px; max-width: 640px"
        >
          {{ t('pages.settings.voiceAssistant.summon.engineOpenWakeWordHint') }}
        </NAlert>
        <NAlert
          v-else-if="settings.summon.wakeEngine === 'porcupine'"
          type="info"
          :show-icon="false"
          style="margin-top: 8px; max-width: 640px"
        >
          {{ t('pages.settings.voiceAssistant.summon.enginePorcupineHint') }}
        </NAlert>
        <NAlert
          v-else-if="settings.summon.wakeEngine === 'whisper'"
          type="info"
          :show-icon="false"
          style="margin-top: 8px; max-width: 640px"
        >
          {{ t('pages.settings.voiceAssistant.summon.engineWhisperHint') }}
        </NAlert>
      </div>

      <div v-if="settings.summon.wakeEngine === 'porcupine'">
        <NText strong>{{ t('pages.settings.voiceAssistant.summon.porcupineKey') }}</NText>
        <NInput
          :value="settings.summon.porcupineAccessKey"
          type="password"
          show-password-on="click"
          :placeholder="t('pages.settings.voiceAssistant.summon.porcupineKeyPlaceholder')"
          style="margin-top: 8px; max-width: 480px"
          @update:value="(v) => updateSummon({ porcupineAccessKey: v })"
        />
      </div>

      <WakePhraseEditor :disabled="!electronOnly" />

      <div>
        <NText strong>{{ t('pages.settings.voiceAssistant.summon.idleTimeout') }}</NText>
        <NInputNumber
          v-model:value="idleMinutes"
          :min="1"
          :max="60"
          style="margin-top: 8px; width: 160px"
        />
        <NText depth="3" style="margin-left: 8px">{{ t('pages.settings.voiceAssistant.summon.minutes') }}</NText>
      </div>

      <div>
        <NText strong>{{ t('pages.settings.voiceAssistant.summon.sensitivity') }}</NText>
        <NSlider
          :value="settings.summon.sensitivity"
          :min="0.1"
          :max="0.9"
          :step="0.05"
          style="margin-top: 8px; max-width: 320px"
          @update:value="(v) => updateSummon({ sensitivity: v })"
        />
      </div>

      <NDivider />

      <div>
        <NText strong>{{ t('pages.settings.voiceAssistant.summon.wakeChime') }}</NText>
        <NSelect
          :value="settings.summon.wakeChimeMode"
          :options="chimeOptions"
          style="margin-top: 8px; max-width: 280px"
          @update:value="(v) => updateSummon({ wakeChimeMode: v })"
        />
        <NInput
          v-if="settings.summon.wakeChimeMode === 'tts'"
          :value="settings.summon.wakeChimeText"
          :placeholder="t('pages.settings.voiceAssistant.summon.wakeChimePlaceholder')"
          style="margin-top: 8px; max-width: 480px"
          @update:value="(v) => updateSummon({ wakeChimeText: v })"
        />
      </div>
    </NSpace>
  </NCard>
</template>
