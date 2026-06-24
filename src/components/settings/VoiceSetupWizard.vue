<script setup lang="ts">
/**
 * VoiceSetupWizard v3 — Summon-first, platform STT default, BYOK optional.
 */
import { computed, onMounted, ref } from 'vue'
import {
  NModal, NCard, NSpace, NButton, NText, NIcon,
  NTag, NAlert, NSteps, NStep,
} from 'naive-ui'
import {
  FlashOutline,
  MicOutline,
  CheckmarkCircleOutline,
} from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import { isElectronApp } from '@/lib/desktop-shell'

const WIZARD_KEY = 'antler:voice-setup-wizard-v3-dismissed'

const { t } = useI18n()
const { settings } = useVoiceAssistantSettings()

const show = ref(false)
const step = ref(0)

const hasWakePhrase = computed(() => settings.value.summon.wakePhrases.length > 0)
const summonReady = computed(() => hasWakePhrase.value)

function dismiss() {
  show.value = false
  try { localStorage.setItem(WIZARD_KEY, '1') } catch { /* ignore */ }
}

function next() {
  step.value++
}

function back() {
  if (step.value > 0) step.value--
}

onMounted(() => {
  try {
    if (localStorage.getItem(WIZARD_KEY)) return
    if (localStorage.getItem('antler:voice-setup-wizard-v2-dismissed')) return
  } catch { /* ignore */ }
  if (!isElectronApp()) return
  if (summonReady.value) return
  show.value = true
})
</script>

<template>
  <NModal
    v-model:show="show"
    :mask-closable="false"
    style="max-width: 580px; width: 90vw"
  >
    <NCard
      :title="t('pages.settings.voiceAssistant.wizard.title')"
      :bordered="false"
      size="large"
      role="dialog"
      aria-modal="true"
    >
      <template #header-extra>
        <NButton text size="small" @click="dismiss">{{ t('pages.settings.voiceAssistant.wizard.skip') }}</NButton>
      </template>

      <NSteps :current="step + 1" style="margin-bottom: 24px" size="small">
        <NStep :title="t('pages.settings.voiceAssistant.wizard.stepWelcome')" />
        <NStep :title="t('pages.settings.voiceAssistant.wizard.stepWake')" />
        <NStep :title="t('pages.settings.voiceAssistant.wizard.stepDone')" />
      </NSteps>

      <div v-if="step === 0">
        <NSpace vertical :size="16">
          <NText style="font-size: 15px; line-height: 1.7">
            {{ t('pages.settings.voiceAssistant.wizard.welcomeBody') }}
          </NText>
          <NSpace>
            <NTag type="success" round>
              <template #icon><NIcon :component="FlashOutline" /></template>
              {{ t('pages.settings.voiceAssistant.wizard.welcomeTagSummon') }}
            </NTag>
            <NTag type="info" round>
              <template #icon><NIcon :component="MicOutline" /></template>
              {{ t('pages.settings.voiceAssistant.wizard.welcomeTagEdge') }}
            </NTag>
          </NSpace>
          <NAlert type="info" :show-icon="false" style="font-size: 13px">
            {{ t('pages.settings.voiceAssistant.wizard.welcomeHint') }}
          </NAlert>
        </NSpace>
      </div>

      <div v-else-if="step === 1">
        <NSpace vertical :size="16">
          <NText strong style="font-size: 15px">{{ t('pages.settings.voiceAssistant.wizard.wakeTitle') }}</NText>
          <NText style="line-height: 1.6">{{ t('pages.settings.voiceAssistant.wizard.wakeBody') }}</NText>
          <NAlert v-if="hasWakePhrase" type="success" :show-icon="false">
            {{ t('pages.settings.voiceAssistant.wizard.wakeDone') }}
          </NAlert>
          <NAlert v-else type="info" :show-icon="false">
            {{ t('pages.settings.voiceAssistant.wizard.wakePending') }}
          </NAlert>
          <NText depth="3" style="font-size: 13px">
            {{ t('pages.settings.voiceAssistant.wizard.wakeOpenEditor') }} →
            {{ t('pages.settings.voiceAssistant.tabs.summon') }}
          </NText>
        </NSpace>
      </div>

      <div v-else>
        <NSpace vertical :size="16" align="center" style="text-align: center; padding: 16px 0">
          <NIcon :component="CheckmarkCircleOutline" size="48" color="#18a058" />
          <NText strong style="font-size: 16px">{{ t('pages.settings.voiceAssistant.wizard.doneTitle') }}</NText>
          <NText style="line-height: 1.7; font-size: 14px">
            {{ t('pages.settings.voiceAssistant.wizard.doneBody') }}
          </NText>
          <NAlert type="success" :show-icon="false" style="width: 100%; font-size: 13px">
            {{ t('pages.settings.voiceAssistant.wizard.doneHint') }}
          </NAlert>
        </NSpace>
      </div>

      <template #footer>
        <NSpace justify="end">
          <NButton v-if="step > 0 && step < 2" @click="back">
            {{ t('pages.settings.voiceAssistant.wizard.back') }}
          </NButton>
          <NButton v-if="step < 2" type="primary" @click="next">
            {{ t('pages.settings.voiceAssistant.wizard.next') }}
          </NButton>
          <NButton v-else type="primary" @click="dismiss">
            {{ t('pages.settings.voiceAssistant.wizard.finish') }}
          </NButton>
        </NSpace>
      </template>
    </NCard>
  </NModal>
</template>
