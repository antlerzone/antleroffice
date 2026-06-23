<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  NCard,
  NSpace,
  NAlert,
  NSwitch,
  NText,
  NInputNumber,
  NButton,
  NTag,
  NSpin,
  NCollapse,
  NCollapseItem,
  NSelect,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import { useVoiceSettings } from '@/composables/useVoiceSettings'
import { useVoiceWake } from '@/composables/useVoiceWake'
import WakePhraseEditor from '@/components/settings/WakePhraseEditor.vue'
import SummonAdvancedFields from '@/components/settings/SummonAdvancedFields.vue'
import SummonMicMeter from '@/components/settings/SummonMicMeter.vue'
import { isSummonHost, isLocalDevHost } from '@/lib/desktop-shell'
import { unlockAudioPlayback } from '@/lib/audio-unlock'
import {
  type ReplyLanguage,
  DEFAULT_ZH_WAKE_PHRASES,
  DEFAULT_SUMMON_WAKE_PHRASES,
  dedupeWakePhrases,
  resolveReplyLanguage,
} from '@/constants/voiceAssistant'

const props = withDefaults(
  defineProps<{ cardClass?: string; section?: 'full' | 'core' | 'advanced' }>(),
  { cardClass: '', section: 'full' },
)

const { t, locale } = useI18n()
const api = useAntlerApi()
const showCore = computed(() => props.section === 'full' || props.section === 'core')
const showAdvanced = computed(() => props.section === 'full' || props.section === 'advanced')
const { settings, updateSummon, applyReplyLanguageChange } = useVoiceAssistantSettings()
const { status, refreshStatus } = useVoiceSettings()
const {
  syncListenerConfig,
  bootstrap,
  connected,
  mode,
  lastReply,
  testWakeGreeting,
  simulateWake,
} = useVoiceWake()

const summonHost = computed(() => isSummonHost())
const listenerDirectUp = ref<boolean | null>(null)
const listenerDirectReady = ref<boolean | null>(null)
const listenerDirectWakeBackend = ref<string | null>(null)

const listenerReady = computed(
  () => listenerDirectReady.value === true || status.value?.listener?.available === true,
)
const listenerUp = computed(
  () => listenerDirectUp.value === true || status.value?.listener?.sidecarUp === true,
)
const wakeBackend = computed(
  () => listenerDirectWakeBackend.value || status.value?.listener?.wakeBackend || null,
)
const wakeError = computed(() => status.value?.listener?.wakeError ?? null)
const sttReady = computed(
  () =>
    status.value?.stt?.sttKeyAvailable === true ||
    status.value?.stt?.available === true ||
    status.value?.stt?.openclawOpenAiKeyConfigured === true,
)
const listenerChecking = ref(false)
const testingGreeting = ref(false)
const simulatingWake = ref(false)
const micLevelRms = ref(0)

const replyLanguageOptions = computed(() => [
  { label: t('pages.settings.voiceAssistant.voice.replyLangAuto'), value: 'auto' as ReplyLanguage },
  { label: t('pages.settings.voiceAssistant.voice.replyLangZh'), value: 'zh' as ReplyLanguage },
  { label: t('pages.settings.voiceAssistant.voice.replyLangEn'), value: 'en' as ReplyLanguage },
])

const modeLabel = computed(() => {
  const m = mode.value
  if (m === 'active') return t('pages.settings.voiceAssistant.summon.modeActive')
  if (m === 'speaking') return t('pages.settings.voiceAssistant.summon.modeSpeaking')
  return t('pages.settings.voiceAssistant.summon.modeSleep')
})

const effectiveWakePhrasesDisplay = computed(() => {
  const phrases = dedupeWakePhrases(settings.value.summon.wakePhrases)
  const base = phrases.length ? phrases : [...DEFAULT_SUMMON_WAKE_PHRASES]
  const lang = resolveReplyLanguage(settings.value.voice.replyLanguage, locale.value)
  if (lang === 'zh') return dedupeWakePhrases([...base, ...DEFAULT_ZH_WAKE_PHRASES])
  return base
})

const replyLangZh = computed(
  () => resolveReplyLanguage(settings.value.voice.replyLanguage, locale.value) === 'zh',
)

function onReplyLanguageChange(lang: ReplyLanguage) {
  applyReplyLanguageChange(lang)
}

async function refreshListenerDirect() {
  try {
    const res = await api.get<{
      health?: { up?: boolean; ready?: boolean; data?: { state?: { wake_backend?: string } } }
    }>('/api/voice/listener/status', { timeoutMs: 5000 })
    listenerDirectUp.value = res.health?.up === true
    listenerDirectReady.value = res.health?.ready === true
    listenerDirectWakeBackend.value = res.health?.data?.state?.wake_backend ?? null
  } catch {
    listenerDirectUp.value = false
    listenerDirectReady.value = false
  }
}

async function checkListener() {
  listenerChecking.value = true
  try {
    await syncListenerConfig()
    await refreshListenerDirect()
    await refreshStatus()
  } finally {
    listenerChecking.value = false
  }
}

async function runTestGreeting() {
  testingGreeting.value = true
  try {
    await unlockAudioPlayback()
    await testWakeGreeting()
  } finally {
    testingGreeting.value = false
  }
}

async function runSimulateWake() {
  simulatingWake.value = true
  try {
    await unlockAudioPlayback()
    await simulateWake()
  } finally {
    simulatingWake.value = false
  }
}

function onMicLevel(level: number) {
  micLevelRms.value = level
}

let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  if (summonHost.value) {
    if (!connected.value) {
      await bootstrap()
    } else {
      await syncListenerConfig()
    }
  }
  await refreshListenerDirect()
  refreshStatus()
  pollTimer = setInterval(() => {
    void refreshListenerDirect()
    void refreshStatus()
  }, 5000)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <NCard
    v-if="showCore"
    :title="t('pages.settings.voiceAssistant.summon.title')"
    :class="cardClass"
  >
    <template v-if="summonHost" #header-extra>
      <SummonMicMeter />
    </template>
    <NAlert v-if="!summonHost" type="info" style="margin-bottom: 12px">
      {{ t('pages.settings.voiceAssistant.summon.webHint') }}
    </NAlert>

    <div
      v-if="summonHost"
      style="margin-bottom: 16px; padding: 10px 12px; background: var(--n-color-embedded); border-radius: 6px;"
    >
      <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
        <NSpin v-if="listenerChecking" :size="14" />
        <template v-else-if="listenerReady">
          <NTag type="success" size="small" round>● {{ wakeBackend || 'ok' }}</NTag>
        </template>
        <NTag v-else-if="listenerUp" type="warning" size="small" round>● starting</NTag>
        <NTag v-else type="error" size="small" round>● down</NTag>
        <NTag :type="connected ? 'success' : 'warning'" size="small">
          {{ connected ? 'SSE ✓' : 'SSE …' }}
        </NTag>
        <NTag size="small">{{ modeLabel }}</NTag>
        <NText depth="3" style="font-size: 12px; flex: 1; min-width: 120px">
          {{ listenerReady ? t('pages.settings.voiceAssistant.summon.hintReady') : t('pages.settings.voiceAssistant.summon.hintDown') }}
        </NText>
        <NButton size="tiny" :loading="listenerChecking" @click="checkListener">
          {{ t('pages.settings.voiceAssistant.summon.refresh') }}
        </NButton>
      </div>
      <NText v-if="wakeError" depth="3" style="font-size: 11px; margin-top: 4px; color: var(--n-color-error); display: block">
        {{ t('pages.settings.voiceAssistant.summon.errorLabel') }}: {{ wakeError }}
      </NText>
      <SummonMicMeter large show-label style="margin-top: 10px" @level="onMicLevel" />
      <NAlert
        v-if="micLevelRms > 0 && micLevelRms < 15"
        type="warning"
        :show-icon="true"
        style="margin-top: 10px"
      >
        {{ t('pages.settings.voiceAssistant.summon.micSilentHint') }}
      </NAlert>
      <NText v-if="lastReply" depth="3" style="font-size: 11px; margin-top: 6px; display: block">
        {{ t('pages.settings.voiceAssistant.summon.lastReply') }}: {{ lastReply }}
      </NText>
    </div>

    <NSpace vertical :size="16">
      <NAlert
        v-if="summonHost && settings.summon.wakeEngine === 'whisper' && !sttReady"
        type="warning"
        :title="t('pages.settings.voiceAssistant.summon.sttMissingTitle')"
      >
        {{ t('pages.settings.voiceAssistant.summon.sttMissingHint') }}
      </NAlert>

      <NAlert
        v-if="summonHost && isLocalDevHost() && !settings.voice.enabled"
        type="warning"
        style="margin-bottom: 12px"
      >
        {{ t('pages.settings.voiceAssistant.summon.voiceDisabledHint') }}
      </NAlert>

      <NAlert
        v-if="summonHost && isLocalDevHost()"
        type="info"
        :show-icon="false"
        style="margin-bottom: 12px"
      >
        {{ t('pages.settings.voiceAssistant.summon.chromeAudioHint') }}
      </NAlert>

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
        <NSwitch
          :value="settings.summon.globalListenEnabled"
          :disabled="!summonHost"
          @update:value="(v) => updateSummon({ globalListenEnabled: v })"
        />
        <NText style="margin-left: 8px">{{ t('pages.settings.voiceAssistant.summon.globalListen') }}</NText>
        <NText depth="3" style="display: block; font-size: 13px; margin-top: 4px">
          {{ t('pages.settings.voiceAssistant.summon.globalListenHint') }}
        </NText>
      </div>

      <div v-if="summonHost">
        <NSpace>
          <NButton :loading="testingGreeting" @click="runTestGreeting">
            {{ t('pages.settings.voiceAssistant.summon.testGreeting') }}
          </NButton>
          <NButton :loading="simulatingWake" @click="runSimulateWake">
            {{ t('pages.settings.voiceAssistant.summon.simulateWake') }}
          </NButton>
        </NSpace>
        <NText depth="3" style="display: block; font-size: 12px; margin-top: 6px">
          {{ t('pages.settings.voiceAssistant.summon.testGreetingHint') }}
        </NText>
      </div>

      <WakePhraseEditor :disabled="!summonHost" />

      <NAlert v-if="summonHost && replyLangZh" type="info" :show-icon="false">
        {{ t('pages.settings.voiceAssistant.summon.zhWakeActiveHint') }}
        {{ effectiveWakePhrasesDisplay.join(' · ') }}
      </NAlert>

      <div>
        <NSwitch
          :value="settings.summon.clapWake"
          :disabled="!summonHost"
          @update:value="(v) => updateSummon({ clapWake: v })"
        />
        <NText style="margin-left: 8px">{{ t('pages.settings.voiceAssistant.summon.clapWake') }}</NText>
        <NText depth="3" style="display: block; font-size: 13px; margin-top: 4px">
          {{ t('pages.settings.voiceAssistant.summon.clapWakeHint') }}
        </NText>
        <div v-if="settings.summon.clapWake" style="margin-top: 10px">
          <NInputNumber
            :value="settings.summon.clapWakeCount"
            :min="1"
            :max="5"
            style="width: 120px"
            @update:value="(v) => updateSummon({ clapWakeCount: v ?? 2 })"
          />
        </div>
      </div>

      <NCollapse v-if="props.section === 'full'">
        <NCollapseItem :title="t('pages.settings.voiceAssistant.summon.advanced')" name="advanced">
          <SummonAdvancedFields />
        </NCollapseItem>
      </NCollapse>
    </NSpace>
  </NCard>

  <SummonAdvancedFields v-else-if="showAdvanced && props.section === 'advanced'" />
</template>
