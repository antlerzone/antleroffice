<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import {
  NCard, NSwitch, NText, NSelect, NInput, NDivider,
  NAlert, NTag, NButton, NRadioGroup, NRadioButton, NSpace,
  NCollapse, NCollapseItem,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import { useVoiceWake } from '@/composables/useVoiceWake'
import { isSummonHost } from '@/lib/desktop-shell'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { isValidFishAudioReferenceId } from '@/utils/fish-audio'

const props = withDefaults(defineProps<{ cardClass?: string; bare?: boolean }>(), { cardClass: '', bare: false })

const { t } = useI18n()
const { settings, updateRealtime, updateVoiceApi, loadVoiceApiFromServer, hasUserOpenAiKey } = useVoiceAssistantSettings()
const { realtime } = useVoiceWake()

const voiceHost = computed(() => isSummonHost())

const realtimeModelOptions = computed(() => [
  { label: `gpt-realtime-2 (${t('pages.settings.voiceAssistant.realtime.modelRecommended')})`, value: 'gpt-realtime-2' },
  { label: 'gpt-realtime (GA alias)', value: 'gpt-realtime' },
  { label: 'gpt-4o-realtime-preview-2024-12-17 (legacy)', value: 'gpt-4o-realtime-preview-2024-12-17' },
  { label: 'gpt-4o-mini-realtime-preview-2024-12-17 (legacy, faster)', value: 'gpt-4o-mini-realtime-preview-2024-12-17' },
])

const openaiVoiceOptions = [
  { label: 'Alloy', value: 'alloy' },
  { label: 'Echo', value: 'echo' },
  { label: 'Fable', value: 'fable' },
  { label: 'Onyx', value: 'onyx' },
  { label: 'Nova', value: 'nova' },
  { label: 'Shimmer', value: 'shimmer' },
  { label: 'Verse', value: 'verse' },
  { label: 'Ballad', value: 'ballad' },
]

const openaiTtsModelOptions = [
  { label: 'gpt-4o-mini-tts (Recommended, best value)', value: 'gpt-4o-mini-tts' },
  { label: 'tts-1 (Standard, cheapest)', value: 'tts-1' },
  { label: 'tts-1-hd (High quality)', value: 'tts-1-hd' },
]

const openaiSttModelOptions = [
  { label: 'gpt-4o-mini-transcribe (Recommended, best value)', value: 'gpt-4o-mini-transcribe' },
  { label: 'gpt-4o-transcribe (High accuracy)', value: 'gpt-4o-transcribe' },
  { label: 'whisper-1 (Stable, best compatibility)', value: 'whisper-1' },
]

const statusType = computed(() => {
  switch (realtime.status.value) {
    case 'connecting':  return 'warning'
    case 'listening':   return 'success'
    case 'processing':  return 'warning'
    case 'speaking':    return 'info'
    case 'error':       return 'error'
    default:            return 'default'
  }
})

const statusLabel = computed(() => {
  const k = 'pages.settings.voiceAssistant.realtime'
  switch (realtime.status.value) {
    case 'connecting':  return t(`${k}.statusConnecting`)
    case 'listening':   return t(`${k}.statusListening`)
    case 'processing':  return t(`${k}.statusProcessing`)
    case 'speaking':    return t(`${k}.statusSpeaking`)
    case 'error':       return t(`${k}.statusError`)
    default:            return t(`${k}.statusIdle`)
  }
})

const canStart = computed(() => {
  const rt = settings.value.realtime
  if (!hasUserOpenAiKey()) return false
  if (rt.voiceOutput === 'elevenlabs' && (!rt.elevenLabsApiKey?.trim() || !rt.elevenLabsVoiceId?.trim())) return false
  if (rt.voiceOutput === 'fishaudio' && (!rt.fishAudioApiKey?.trim() || !isValidFishAudioReferenceId(rt.fishAudioVoiceId || ''))) return false
  return true
})

onMounted(() => {
  void loadVoiceApiFromServer()
})

const fishVoiceIdInvalid = computed(() => {
  const rt = settings.value.realtime
  if (rt.voiceOutput !== 'fishaudio') return false
  const id = rt.fishAudioVoiceId?.trim()
  return !!id && !isValidFishAudioReferenceId(id)
})

// ── Model diagnostics ──────────────────────────────────────────────────────
const api = useAntlerApi()
const checkingModels = ref(false)
const availableRealtimeModels = ref<string[]>([])
const modelCheckError = ref('')

async function checkAvailableModels() {
  const apiKey = settings.value.realtime.openaiApiKey?.trim()
  if (!apiKey) return
  checkingModels.value = true
  modelCheckError.value = ''
  availableRealtimeModels.value = []
  try {
    const res = await api.send<{ ok: boolean; realtime: string[]; error?: string }>(
      'GET', `/api/voice/realtime/models?apiKey=${encodeURIComponent(apiKey)}`
    )
    if (res.ok) {
      availableRealtimeModels.value = res.realtime
      console.log('[RealtimeSettings] available realtime models:', res.realtime)
    } else {
      modelCheckError.value = res.error || 'Unknown error'
    }
  } catch (e: unknown) {
    modelCheckError.value = e instanceof Error ? e.message : String(e)
  } finally {
    checkingModels.value = false
  }
}
</script>

<template>
  <component :is="bare ? 'div' : NCard" :title="bare ? undefined : t('pages.settings.voiceAssistant.realtime.title')" :class="bare ? undefined : cardClass">
    <NAlert type="info" :show-icon="false" style="margin-bottom: 16px">
      {{ t('pages.settings.voiceAssistant.realtime.intro') }}
    </NAlert>

    <template v-if="!voiceHost">
      <NAlert type="warning">{{ t('pages.settings.voiceAssistant.realtime.desktopOnly') }}</NAlert>
    </template>

    <template v-else>
      <!-- ── Enable toggle ───────────────────────────────────────────────── -->
      <div style="margin-bottom: 20px">
        <NSwitch
          :value="settings.realtime.enabled"
          @update:value="(v) => updateRealtime({ enabled: v })"
        />
        <NText style="margin-left: 8px; font-weight: 500">{{ t('pages.settings.voiceAssistant.realtime.enabledLabel') }}</NText>
        <NText depth="3" style="display: block; font-size: 13px; margin-top: 4px">
          {{ t('pages.settings.voiceAssistant.realtime.enabledHint') }}
        </NText>
      </div>

      <template v-if="settings.realtime.enabled">
        <NAlert type="info" :show-icon="false" style="margin-bottom: 16px">
          {{ t('pages.settings.voiceAssistant.realtime.sttUserKeyHint') }}
        </NAlert>

        <NCollapse>
          <NCollapseItem :title="t('pages.settings.voiceAssistant.realtime.advanced')" name="advanced">
        <!-- ── OpenAI TTS key (optional when using OpenAI voice output) ─── -->
        <div style="margin-bottom: 16px">
          <NText strong>{{ t('pages.settings.voiceAssistant.realtime.ttsKeyLabel') }}</NText>
          <NInput
            :value="settings.realtime.openaiApiKey"
            type="password"
            show-password-on="click"
            placeholder="sk-..."
            style="margin-top: 8px; max-width: 480px"
            @update:value="(v) => updateRealtime({ openaiApiKey: v })"
          />
          <NText depth="3" style="display: block; font-size: 12px; margin-top: 4px">
            {{ t('pages.settings.voiceAssistant.realtime.ttsKeyHint') }}
          </NText>
        </div>

        <div style="margin-bottom: 20px">
          <NText strong>{{ t('pages.settings.voiceAssistant.realtime.modelLabel') }}</NText>
          <div style="display: flex; align-items: center; gap: 10px; margin-top: 8px">
            <NSelect
              :value="settings.realtime.model"
              :options="realtimeModelOptions"
              style="max-width: 420px; flex: 1"
              @update:value="(v) => updateRealtime({ model: v })"
            />
            <NButton
              size="small"
              :loading="checkingModels"
              :disabled="!settings.realtime.openaiApiKey?.trim()"
              @click="checkAvailableModels"
            >
              {{ t('pages.settings.voiceAssistant.realtime.checkModels') }}
            </NButton>
          </div>
          <template v-if="availableRealtimeModels.length > 0">
            <NText depth="3" style="display: block; font-size: 12px; margin-top: 6px">
              {{ t('pages.settings.voiceAssistant.realtime.modelsAvailable') }}
              <strong>{{ availableRealtimeModels.join(', ') }}</strong>
            </NText>
          </template>
          <template v-else-if="modelCheckError">
            <NText type="error" style="display: block; font-size: 12px; margin-top: 6px">
              {{ t('pages.settings.voiceAssistant.realtime.modelsCheckFailed') }} {{ modelCheckError }}
            </NText>
          </template>
        </div>

        <NDivider style="margin: 0 0 20px" />

        <!-- ── STT model ─────────────────────────────────────────────── -->
        <div style="margin-bottom: 20px">
          <NText strong style="display: block; margin-bottom: 4px">{{ t('pages.settings.voiceAssistant.voiceApi.sttModelLabel') }}</NText>
          <NText depth="3" style="display: block; font-size: 12px; margin-bottom: 8px">
            {{ t('pages.settings.voiceAssistant.realtime.sttModelHint') }}
          </NText>
          <NSelect
            :value="settings.voiceApi.openaiSttModel || settings.realtime.openaiSttModel || 'gpt-4o-mini-transcribe'"
            :options="openaiSttModelOptions"
            style="max-width: 360px"
            @update:value="(v) => { updateRealtime({ openaiSttModel: v }); updateVoiceApi({ openaiSttModel: v }) }"
          />
        </div>

        <NDivider style="margin: 0 0 20px" />

        <!-- ── Voice output selector ──────────────────────────────────── -->
        <div style="margin-bottom: 20px">
          <NText strong style="display: block; margin-bottom: 10px">{{ t('pages.settings.voiceAssistant.realtime.voiceOutputLabel') }}</NText>
          <NRadioGroup
            :value="settings.realtime.voiceOutput"
            @update:value="(v) => updateRealtime({ voiceOutput: v as 'openai' | 'elevenlabs' | 'fishaudio' })"
          >
            <NSpace>
              <NRadioButton value="openai">
                {{ t('pages.settings.voiceAssistant.realtime.voiceOutputOpenAI') }}
              </NRadioButton>
              <NRadioButton value="elevenlabs">
                {{ t('pages.settings.voiceAssistant.realtime.voiceOutputElevenLabs') }}
              </NRadioButton>
              <NRadioButton value="fishaudio">
                Fish Audio (Clone)
              </NRadioButton>
            </NSpace>
          </NRadioGroup>
        </div>

        <!-- ── OpenAI voice picker + TTS model ───────────────────────── -->
        <template v-if="settings.realtime.voiceOutput === 'openai'">
          <div style="margin-bottom: 16px">
            <NText strong>{{ t('pages.settings.voiceAssistant.realtime.voiceLabel') }}</NText>
            <NSelect
              :value="settings.realtime.voice"
              :options="openaiVoiceOptions"
              style="margin-top: 8px; max-width: 320px"
              @update:value="(v) => updateRealtime({ voice: v as any })"
            />
          </div>

          <div style="margin-bottom: 20px">
            <NText strong style="display: block; margin-bottom: 4px">TTS Model (Speech Synthesis)</NText>
            <NText depth="3" style="display: block; font-size: 12px; margin-bottom: 8px">
              Which OpenAI model to use for voice synthesis
            </NText>
            <div style="flex: 1; min-width: 240px">
              <NSelect
                :value="settings.realtime.openaiTtsModel || 'gpt-4o-mini-tts'"
                :options="openaiTtsModelOptions"
                style="max-width: 360px"
                @update:value="(v) => updateRealtime({ openaiTtsModel: v })"
              />
            </div>
          </div>
            </template>

        <!-- ── ElevenLabs fields ─────────────────────────────────────────── -->
        <template v-else-if="settings.realtime.voiceOutput === 'elevenlabs'">
          <NAlert type="info" :show-icon="false" style="margin-bottom: 16px; max-width: 640px">
            {{ t('pages.settings.voiceAssistant.realtime.elIntro') }}
          </NAlert>

          <div style="margin-bottom: 16px">
            <NText strong>{{ t('pages.settings.voiceAssistant.realtime.elApiKeyLabel') }}</NText>
            <NInput
              :value="settings.realtime.elevenLabsApiKey"
              type="password"
              show-password-on="click"
              placeholder="xi-api-key..."
              style="margin-top: 8px; max-width: 480px"
              @update:value="(v) => updateRealtime({ elevenLabsApiKey: v })"
            />
          </div>

          <div style="margin-bottom: 20px">
            <NText strong>Voice ID</NText>
            <NInput
              :value="settings.realtime.elevenLabsVoiceId"
              placeholder="ElevenLabs Voice ID"
              style="margin-top: 8px; max-width: 480px"
              @update:value="(v) => updateRealtime({ elevenLabsVoiceId: v })"
            />
            <NText depth="3" style="display: block; font-size: 12px; margin-top: 4px">
              Copy Voice ID from ElevenLabs dashboard.
            </NText>
          </div>
        </template>

        <!-- ── Fish Audio fields ──────────────────────────────────────────── -->
        <template v-else-if="settings.realtime.voiceOutput === 'fishaudio'">
          <NAlert type="info" :show-icon="false" style="margin-bottom: 16px; max-width: 640px">
            Fish Audio — Voice-clone TTS, ~$15/million chars (11x cheaper than ElevenLabs).<br>
            Upload a 10-second recording at <strong>fish.audio</strong> to clone your voice, then copy the Voice ID below.
          </NAlert>

          <div style="margin-bottom: 16px">
            <NText strong>Fish Audio API Key</NText>
            <NInput
              :value="settings.realtime.fishAudioApiKey"
              type="password"
              show-password-on="click"
              placeholder="fish_sk_..."
              style="margin-top: 8px; max-width: 480px"
              @update:value="(v) => updateRealtime({ fishAudioApiKey: v })"
            />
          </div>

          <div style="margin-bottom: 20px">
            <NText strong>Voice ID</NText>
            <NInput
              :value="settings.realtime.fishAudioVoiceId"
              placeholder="Fish Audio Voice ID (reference_id)"
              style="margin-top: 8px; max-width: 480px"
              @update:value="(v) => updateRealtime({ fishAudioVoiceId: v })"
            />
            <NText depth="3" style="display: block; font-size: 12px; margin-top: 4px">
              Copy Voice ID (reference_id) from fish.audio → My Voices. Use the ID only — not the page URL.
            </NText>
            <NAlert v-if="fishVoiceIdInvalid" type="warning" :show-icon="false" style="margin-top: 8px; max-width: 640px">
              Invalid Voice ID format. Expected 1–128 characters: letters, numbers, underscore, hyphen (e.g. <code>abc123_xyz</code>).
            </NAlert>
          </div>
        </template>

          </NCollapseItem>
        </NCollapse>

        <NDivider style="margin: 16px 0" />

        <!-- ── Status + controls ──────────────────────────────────────── -->
        <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
          <NTag :type="statusType" size="medium">{{ statusLabel }}</NTag>

          <NButton
            v-if="!realtime.isActive.value"
            type="primary"
            :disabled="!canStart"
            @click="realtime.start()"
          >
            {{ t('pages.settings.voiceAssistant.realtime.startBtn') }}
          </NButton>
          <NButton
            v-else
            type="error"
            @click="realtime.stop()"
          >
            {{ t('pages.settings.voiceAssistant.realtime.stopBtn') }}
          </NButton>
        </div>

        <!-- ── Live transcripts ───────────────────────────────────────── -->
        <template v-if="realtime.isActive.value">
          <NDivider style="margin: 16px 0" />
          <div v-if="realtime.userTranscript.value" style="margin-bottom: 8px">
            <NText depth="3" style="font-size: 12px">{{ t('pages.settings.voiceAssistant.realtime.youLabel') }}</NText>
            <NText style="display: block; margin-top: 2px">{{ realtime.userTranscript.value }}</NText>
          </div>
          <div v-if="realtime.aiTranscript.value">
            <NText depth="3" style="font-size: 12px">AI</NText>
            <NText style="display: block; margin-top: 2px">{{ realtime.aiTranscript.value }}</NText>
          </div>

          <!-- Conversation log -->
          <template v-if="realtime.conversationLog.value.length > 0">
            <NDivider style="margin: 12px 0" />
            <div style="max-height: 200px; overflow-y: auto; font-size: 13px">
              <div
                v-for="(entry, idx) in realtime.conversationLog.value"
                :key="idx"
                style="margin-bottom: 6px"
              >
                <NText depth="3" style="font-size: 11px">
                  {{ entry.role === 'user' ? t('pages.settings.voiceAssistant.realtime.youLabel') : 'AI' }}
                  · {{ entry.time }}
                </NText>
                <NText style="display: block; margin-top: 1px">{{ entry.text }}</NText>
              </div>
            </div>
          </template>
        </template>

      </template>
    </template>
  </component>
</template>
