<script setup lang="ts">
// Voice v2 设置：唤醒词、一直听开关、音色、模型、TTS 供应商。本地保存。
import { computed, ref } from 'vue'
import { NCard, NForm, NFormItem, NInput, NSwitch, NSelect, NText, NSpace, NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useVoice2Settings, type Voice2TtsProvider } from '@/composables/useVoice2Settings'
import { useOfficeProfile } from '@/composables/useOfficeProfile'

defineProps<{ cardClass?: string }>()

const { t } = useI18n()
const { settings } = useVoice2Settings()

function addRow(arr: string[]) { arr.push('') }
function removeRow(arr: string[], i: number) { arr.splice(i, 1) }

const wakeBusy = ref(false)
async function applyWakeWord() {
  wakeBusy.value = true
  try {
    await fetch('/api/voice2/wake-word', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phrases: settings.wakePhrases }),
    })
  } catch { /* 推送失败忽略 */ } finally {
    wakeBusy.value = false
  }
}

const genBusy = ref(false)
async function generateGreeting() {
  genBusy.value = true
  try {
    const { bossDisplayName, load } = useOfficeProfile()
    if (!bossDisplayName.value) await load().catch(() => {})
    const r = await fetch('/api/voice2/generate-greeting', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ soul: settings.soul, bossName: bossDisplayName.value || '' }),
    })
    const d = await r.json()
    if (d.ok && d.greeting) settings.greeting = d.greeting
  } catch { /* 生成失败就不动 */ } finally {
    genBusy.value = false
  }
}

const voiceOptions = ['cedar', 'marin', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse']
  .map((v) => ({ label: v, value: v }))

const ttsOptions = computed<{ label: string; value: Voice2TtsProvider }[]>(() => [
  { label: t('voice2.settings.providerOpenai'), value: 'openai' },
  { label: t('voice2.settings.providerEleven'), value: 'elevenlabs' },
  { label: t('voice2.settings.providerFish'), value: 'fish' },
])

const isExternal = computed(() => settings.ttsProvider !== 'openai')
</script>

<template>
  <NSpace vertical :size="16">
    <NCard :title="t('voice2.settings.assistantTitle')" :class="cardClass" size="small">
      <NForm label-placement="left" :label-width="120">
        <NFormItem :label="t('voice2.settings.soul')">
          <NSpace vertical :size="4" style="width:100%">
            <NInput
              v-model:value="settings.soul"
              type="textarea"
              :autosize="{ minRows: 3, maxRows: 8 }"
              :placeholder="t('voice2.settings.soulPlaceholder')"
            />
            <NText depth="3" style="font-size:12px">{{ t('voice2.settings.soulHint') }}</NText>
          </NSpace>
        </NFormItem>

        <NFormItem :label="t('voice2.settings.greeting')">
          <NSpace vertical :size="4" style="width:100%">
            <NSpace :size="8" :wrap="false" align="center" style="width:100%">
              <NInput v-model:value="settings.greeting" :placeholder="t('voice2.settings.greetingPlaceholder')" />
              <NButton :loading="genBusy" @click="generateGreeting">{{ t('voice2.settings.generate') }}</NButton>
            </NSpace>
            <NText depth="3" style="font-size:12px">{{ t('voice2.settings.greetingHint') }}</NText>
    