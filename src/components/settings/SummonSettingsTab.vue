<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  NCard,
  NSpace,
  NAlert,
  NSwitch,
  NText,
  NButton,
  NTag,
  NSpin,
  NCollapse,
  NCollapseItem,
  NSelect,
  NInput,
  useMessage,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import { useVoiceSettings } from '@/composables/useVoiceSettings'
import { useVoiceWake } from '@/composables/useVoiceWake'
import { usePersonaVoice } from '@/composables/usePersonaVoice'
import { useVoiceOutput } from '@/composables/useVoiceOutput'
import WakePhraseEditor from '@/components/settings/WakePhraseEditor.vue'
import SummonAdvancedFields from '@/components/settings/SummonAdvancedFields.vue'
import SummonMicMeter from '@/components/settings/SummonMicMeter.vue'
import CloudCloneTtsFields from '@/components/settings/CloudCloneTtsFields.vue'
import { isSummonHost, isLocalDevHost } from '@/lib/desktop-shell'
import { savePersonaGreetingCache } from '@/lib/persona-greeting-cache'
import {
  type ReplyLanguage,
  type PersonaReplyVoice,
  dedupeWakePhrases,
} from '@/constants/voiceAssistant'

const props = withDefaults(
  defineProps<{ cardClass?: string; section?: 'full' | 'core' | 'advanced' }>(),
  { cardClass: '', section: 'full' },
)

const { t } = useI18n()
const message = useMessage()
const api = useAntlerApi()
const showCore = computed(() => props.section === 'full' || props.section === 'core')
const showAdvanced = computed(() => props.section === 'full' || props.section === 'advanced')
const { settings, updateSummon, applyReplyLanguageChange } = useVoiceAssistantSettings()
const { resolvedSampleReply, personaSpeakOptions, cloudTtsReady } = usePersonaVoice()
const { speak, stop, isPlaying, isSynthesizing, synthesizePersonaLine, playBlob } = useVoiceOutput()
const { status, refreshStatus } = useVoiceSettings()
const { syncListenerConfig, bootstrap, connected, mode, lastReply } = useVoiceWake()

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
const listenerChecking = ref(false)
const micLevelRms = ref(0)
const previewText = ref('')
const savingSample = ref(false)

const replyVoiceOptions = computed(() => [
  { label: t('pages.settings.voiceAssistant.persona.replyVoiceDefault'), value: 'default' as PersonaReplyVoice },
  { label: t('pages.settings.voiceAssistant.persona.replyVoiceElevenLabs'), value: 'elevenlabs' as PersonaReplyVoice },
  { label: t('pages.settings.voiceAssistant.persona.replyVoiceFish'), value: 'fishaudio' as PersonaReplyVoice },
])

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

const recordedWakePhrases = computed(() => dedupeWakePhrases(settings.value.summon.wakePhrases))

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

function onMicLevel(level: number) {
  micLevelRms.value = level
}

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
  updateSummon({ sampleReply: text })
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

async function previewGreeting() {
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
  previewText.value = settings.value.summon.sampleReply?.trim() || resolvedSampleReply.value
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
        v-if="summonHost"
        type="info"
        :show-icon="false"
      >
        {{ t('pages.settings.voiceAssistant.summon.engineOpenWakeWordHint') }}
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

      <div class="summon-greeting-field">
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
            :value="settings.summon.replyVoice"
            :options="replyVoiceOptions"
            @update:value="(v) => updateSummon({ replyVoice: v })"
          />
          <CloudCloneTtsFields
            v-if="settings.summon.replyVoice === 'elevenlabs'"
            engine="elevenlabs"
          />
          <CloudCloneTtsFields
            v-if="settings.summon.replyVoice === 'fishaudio'"
            engine="fishaudio"
          />
          <NText depth="3" style="font-size: 12px">
            {{ t('pages.settings.voiceAssistant.persona.replyVoiceHint') }}
          </NText>
        </NSpace>
        <NSpace style="margin-top: 8px">
          <NButton type="primary" :loading="savingSample" @click="saveSampleReply">
            {{ t('pages.settings.voiceAssistant.persona.saveSample') }}
          </NButton>
          <NButton :loading="isSynthesizing" :disabled="isPlaying" @click="previewGreeting">
            {{ t('pages.settings.tts.play') }}
          </NButton>
          <NButton v-if="isPlaying" @click="stop">{{ t('pages.settings.tts.stop') }}</NButton>
        </NSpace>
      </div>

      <WakePhraseEditor :disabled="!summonHost" />

      <NAlert v-if="summonHost && recordedWakePhrases.length" type="info" :show-icon="false">
        {{ t('pages.settings.voiceAssistant.summon.wakePhrasesListenHint') }}
        {{ recordedWakePhrases.join(' · ') }}
      </NAlert>

      <NAlert
        v-else-if="summonHost"
        type="warning"
        :show-icon="false"
      >
        {{ t('pages.settings.voiceAssistant.wizard.wakePending') }}
      </NAlert>

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

      <NCollapse v-if="props.section === 'full'">
        <NCollapseItem :title="t('pages.settings.voiceAssistant.summon.advanced')" name="advanced">
          <SummonAdvancedFields />
        </NCollapseItem>
      </NCollapse>
    </NSpace>
  </NCard>

  <SummonAdvancedFields v-else-if="showAdvanced && props.section === 'advanced'" />
</template>
