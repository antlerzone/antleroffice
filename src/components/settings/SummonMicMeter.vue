<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { NIcon, NText, NTooltip } from 'naive-ui'
import { MicOutline } from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { isSummonHost } from '@/lib/desktop-shell'
import { summonMic } from '@/lib/summon-debug'

const props = withDefaults(
  defineProps<{
    large?: boolean
    showLabel?: boolean
  }>(),
  { large: false, showLabel: false },
)

const emit = defineEmits<{
  level: [rms: number]
}>()

const { t } = useI18n()
const api = useAntlerApi()

const levelRms = ref(0)
const vadThreshold = ref(0)
const micAvailable = ref(false)
const sidecarUp = ref(false)
const wakePhrases = ref<string[]>([])
const isSpeaking = ref(false)

let timer: ReturnType<typeof setInterval> | null = null
const POLL_OK_MS = 800
const POLL_ERR_MS = 3000
let pollDelayMs = POLL_OK_MS

const SEGMENTS = 12
const SPEECH_RMS_MAX = 250
/** Green bar when above this — tuned for boosted quiet USB mics. */
const VOICE_ACTIVE_RMS = 50

const levelPct = computed(() => Math.min(100, Math.round((levelRms.value / SPEECH_RMS_MAX) * 100)))
const activeSegments = computed(() =>
  Math.min(SEGMENTS, Math.ceil((levelPct.value / 100) * SEGMENTS)),
)
const isActive = computed(() => levelRms.value >= VOICE_ACTIVE_RMS)
const aboveVad = computed(() => vadThreshold.value > 0 && levelRms.value >= vadThreshold.value)

const statusHint = computed(() => {
  if (!sidecarUp.value) return t('pages.settings.voiceAssistant.summon.micMeterDown')
  if (!micAvailable.value) return t('pages.settings.voiceAssistant.summon.micMeterNoMic')
  if (!wakePhrases.value.length) return t('pages.settings.voiceAssistant.summon.micMeterNoPhrases')
  if (isSpeaking.value) return t('pages.settings.voiceAssistant.summon.micMeterSpeaking')
  if (isActive.value && aboveVad.value) return t('pages.settings.voiceAssistant.summon.micMeterReady')
  if (isActive.value) return t('pages.settings.voiceAssistant.summon.micMeterActive')
  if (vadThreshold.value > 0 && levelRms.value > 0 && levelRms.value < vadThreshold.value) {
    return t('pages.settings.voiceAssistant.summon.micMeterTooQuiet', {
      level: levelRms.value,
      threshold: vadThreshold.value,
    })
  }
  return t('pages.settings.voiceAssistant.summon.micMeterIdle')
})

let pollInFlight = false
let wasAboveVad = false
let lastMicLogAt = 0

async function poll() {
  if (!isSummonHost() || pollInFlight) return
  pollInFlight = true
  try {
    const res = await api.get<{
      health?: {
        up?: boolean
        data?: {
          currentRms?: number
          peakRms?: number
          vadThreshold?: number
          state?: { mic_available?: boolean; speaking?: boolean; mode?: string }
        }
      }
      config?: { wakePhrases?: string[] }
    }>('/api/voice/listener/status', { timeoutMs: 4000 })
    const data = res.health?.data
    const mode = data?.state?.mode ?? 'sleep'
    const prev = levelRms.value
    levelRms.value = Math.round(data?.currentRms ?? data?.peakRms ?? 0)
    emit('level', levelRms.value)
    vadThreshold.value = Math.round(data?.vadThreshold ?? 0)
    micAvailable.value = data?.state?.mic_available === true
    isSpeaking.value = data?.state?.speaking === true || data?.state?.mode === 'speaking'
    sidecarUp.value = res.health?.up === true
    wakePhrases.value = Array.isArray(res.config?.wakePhrases) ? res.config!.wakePhrases! : []
    pollDelayMs = POLL_OK_MS

    const above = vadThreshold.value > 0 && levelRms.value >= vadThreshold.value
    const now = Date.now()
    if (above && !wasAboveVad) {
      summonMic('mic receive (VAD only — say Hey Jarvis)', {
        rms: levelRms.value,
        vad: vadThreshold.value,
        mode,
        wakePhrases: wakePhrases.value,
      })
      lastMicLogAt = now
    } else if (above && now - lastMicLogAt >= 1500) {
      summonMic('mic receive', { rms: levelRms.value, vad: vadThreshold.value, mode })
      lastMicLogAt = now
    } else if (!above && wasAboveVad) {
      summonMic('mic quiet', { rms: levelRms.value, vad: vadThreshold.value, mode })
    } else if (levelRms.value > 0 && Math.abs(levelRms.value - prev) >= 40) {
      summonMic('mic level', { rms: levelRms.value, delta: levelRms.value - prev, mode })
    }
    wasAboveVad = above
  } catch {
    sidecarUp.value = false
    pollDelayMs = POLL_ERR_MS
  } finally {
    pollInFlight = false
  }
}

function schedulePoll() {
  timer = setTimeout(() => {
    void poll().finally(() => {
      if (timer !== null) schedulePoll()
    })
  }, pollDelayMs)
}

onMounted(() => {
  void poll().finally(() => schedulePoll())
})

onUnmounted(() => {
  if (timer) clearTimeout(timer)
  timer = null
})
</script>

<template>
  <NTooltip v-if="isSummonHost()" trigger="hover">
    <template #trigger>
      <div
        class="summon-mic-meter"
        :class="{ large, compact: !large && !showLabel }"
        role="meter"
        :aria-valuenow="levelRms"
        aria-valuemin="0"
        :aria-valuemax="SPEECH_RMS_MAX"
      >
        <NText v-if="showLabel" strong class="meter-label">
          {{ t('pages.settings.tts.volume') }}
        </NText>
        <NIcon
          :component="MicOutline"
          :size="large ? 20 : 18"
          :color="isActive ? '#18a058' : 'var(--n-text-color-3)'"
        />
        <NText depth="2" class="rms">{{ levelRms }}</NText>
        <div class="segments" :class="{ large }">
          <div
            v-for="i in SEGMENTS"
            :key="i"
            class="seg"
            :class="{ on: i <= activeSegments, voice: isActive && i <= activeSegments }"
          />
        </div>
      </div>
    </template>
    {{ statusHint }}
  </NTooltip>
</template>

<style scoped>
.summon-mic-meter {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 160px;
}

.summon-mic-meter.compact {
  min-width: 140px;
  padding: 4px 2px;
}

.summon-mic-meter.large {
  width: 100%;
  min-width: 0;
  padding: 8px 0 4px;
  gap: 10px;
}

.meter-label {
  font-size: 13px;
  min-width: 48px;
}

.rms {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  min-width: 32px;
  text-align: right;
}

.large .rms {
  font-size: 13px;
  font-weight: 600;
}

.segments {
  flex: 1;
  display: flex;
  gap: 3px;
  align-items: center;
  min-width: 96px;
}

.segments.large {
  min-width: 0;
  gap: 4px;
}

.seg {
  flex: 1;
  height: 8px;
  border-radius: 2px;
  background: var(--n-border-color);
  transition: background 0.1s ease, transform 0.1s ease;
}

.segments.large .seg {
  height: 12px;
  border-radius: 3px;
}

.seg.on {
  background: var(--n-text-color-3);
}

.seg.on.voice {
  background: #18a058;
}
</style>

