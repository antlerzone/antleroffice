<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NSpace, NText, NSelect, NInputNumber, NSlider } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { isSummonHost } from '@/lib/desktop-shell'

const { t } = useI18n()
const api = useAntlerApi()
const { settings, updateSummon } = useVoiceAssistantSettings()
const summonHost = computed(() => isSummonHost())

const micDeviceOptions = ref<Array<{ label: string; value: number | null }>>([
  { label: t('pages.settings.voiceAssistant.summon.micDeviceAuto'), value: null },
])

async function loadMicDevices() {
  if (!summonHost.value) return
  try {
    const res = await api.get<{ ok?: boolean; devices?: Array<{ index: number; name: string; active?: boolean }> }>(
      '/api/voice/listener/devices',
      { timeoutMs: 4000 },
    )
    const devices = Array.isArray(res.devices) ? res.devices : []
    micDeviceOptions.value = [
      { label: t('pages.settings.voiceAssistant.summon.micDeviceAuto'), value: null },
      ...devices.map((d) => ({
        label: `${d.index}: ${d.name}${d.active ? ' ✓' : ''}`,
        value: d.index,
      })),
    ]
  } catch {
    /* ignore */
  }
}

onMounted(() => {
  void loadMicDevices()
})

const idleMinutes = computed({
  get: () => Math.round(settings.value.summon.idleTimeoutSec / 60),
  set: (m: number) => updateSummon({ idleTimeoutSec: Math.max(1, m) * 60 }),
})
</script>

<template>
  <NSpace vertical :size="16">
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
        :max="1.0"
        :step="0.05"
        style="margin-top: 8px; max-width: 320px"
        @update:value="(v) => updateSummon({ sensitivity: v })"
      />
    </div>

    <div v-if="summonHost">
      <NText strong>{{ t('pages.settings.voiceAssistant.summon.micDevice') }}</NText>
      <NSelect
        :value="settings.summon.inputDeviceIndex"
        :options="(micDeviceOptions as unknown as { label: string; value: string | number }[])"
        clearable
        style="margin-top: 8px; max-width: 480px"
        @update:value="(v) => updateSummon({ inputDeviceIndex: v ?? null })"
      />
      <NText depth="3" style="display: block; font-size: 12px; margin-top: 6px">
        {{ t('pages.settings.voiceAssistant.summon.micDeviceHint') }}
      </NText>
    </div>
  </NSpace>
</template>
