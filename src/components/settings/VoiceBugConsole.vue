<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NCollapse, NCollapseItem, NCode, NSpace, NTag, NText, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAntlerApi } from '@/composables/useAntlerApi'

export type VoiceDebugHint = { level: 'error' | 'warn' | 'info' | 'success'; text: string }

export type VoiceDebugReport = {
  ok?: boolean
  collectedAt?: string
  timings?: Record<string, number>
  hints?: VoiceDebugHint[]
  gpu?: Record<string, unknown>
  torch?: Record<string, unknown>
  sidecar?: {
    health?: { up?: boolean; ready?: boolean; data?: Record<string, unknown> }
    debug?: Record<string, unknown>
    setup?: Record<string, unknown>
    processRunning?: boolean
    logs?: { at: number; level: string; line: string }[]
  }
  profile?: Record<string, unknown>
  paths?: Record<string, unknown>
  probe?: {
    ok?: boolean
    error?: string
    audioBytes?: number
    timings?: Record<string, number>
  }
}

const props = defineProps<{
  autoRefresh?: boolean
}>()

const { t } = useI18n()
const message = useMessage()
const api = useAntlerApi()

const expanded = ref<string[]>([])
const loading = ref(false)
const probing = ref(false)
const report = ref<VoiceDebugReport | null>(null)
const lastProbe = ref<VoiceDebugReport['probe'] | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null

const hintTagType = (level: string) => {
  if (level === 'error') return 'error'
  if (level === 'warn') return 'warning'
  if (level === 'success') return 'success'
  return 'info'
}

const summaryLines = computed(() => {
  const r = report.value
  if (!r) return []
  const d = (r.sidecar?.debug || {}) as Record<string, unknown>
  const torch = (r.torch || {}) as Record<string, unknown>
  const healthData = (r.sidecar?.health?.data || {}) as Record<string, unknown>
  const lines = [
    `GPU: ${r.gpu?.meetsRequirements ? 'OK' : 'NO'} (${r.gpu?.vramMb ?? '?'} MB)`,
    `Sidecar: ${r.sidecar?.health?.ready ? 'ready' : r.sidecar?.health?.up ? 'loading' : 'down'}`,
    `Device: ${String(d.device || d.cudaDevice || healthData.device || torch.device || '?')} cuda=${String(d.cudaAvailable ?? healthData.cudaAvailable ?? torch.cuda ?? '?')}`,
    `flash-attn: ${String(d.flashAttn ?? healthData.flashAttn ?? '?')} load=${d.loadMs ?? healthData.loadMs ?? '?'}ms`,
    `last synth: ${d.lastSynthMs ?? healthData.lastSynthMs ?? '?'}ms (count ${d.synthCount ?? healthData.synthCount ?? 0})`,
  ]
  if (lastProbe.value?.timings) {
    const t = lastProbe.value.timings
    lines.push(
      `probe total=${t.totalMs}ms sidecar=${t.sidecarSynthMs ?? t.sidecarReportedMs ?? '?'}ms`,
    )
  }
  return lines
})

const logText = computed(() => {
  const logs = report.value?.sidecar?.logs || []
  if (!logs.length) return t('pages.settings.voiceClone.debugNoLogs')
  return logs
    .map((e) => {
      const ts = new Date(e.at).toLocaleTimeString()
      return `[${ts}] ${e.level}: ${e.line}`
    })
    .join('\n')
})

const jsonText = computed(() => {
  const payload = {
    ...report.value,
    lastProbe: lastProbe.value,
  }
  return JSON.stringify(payload, null, 2)
})

async function refresh(opts: { silent?: boolean } = {}) {
  loading.value = true
  try {
    const data = await api.get<VoiceDebugReport>('/api/voice/debug', { timeoutMs: 30000 })
    if (data.ok === false) throw new Error((data as { error?: string }).error || 'debug failed')
    report.value = data
  } catch (e) {
    if (!opts.silent) {
      message.error(e instanceof Error ? e.message : t('pages.settings.voiceClone.debugFailed'))
    }
  } finally {
    loading.value = false
  }
}

async function runProbe() {
  probing.value = true
  message.info(t('pages.settings.voiceClone.debugProbeSlow'))
  try {
    const data = await api.send<{
      ok?: boolean
      probe?: VoiceDebugReport['probe']
      report?: VoiceDebugReport
      error?: string
    }>('POST', '/api/voice/debug/probe', { text: '测试' }, { timeoutMs: 300000 })
    if (data.report) report.value = data.report
    lastProbe.value = data.probe || null
    if (!data.ok || !data.probe?.ok) {
      message.error(data.probe?.error || data.error || t('pages.settings.voiceClone.debugProbeFailed'))
    } else {
      const ms = data.probe.timings?.totalMs
      message.success(
        ms
          ? t('pages.settings.voiceClone.debugProbeOk', { ms })
          : t('pages.settings.voiceClone.debugProbeOkShort'),
      )
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.settings.voiceClone.debugProbeFailed'))
  } finally {
    probing.value = false
  }
}

async function copyJson() {
  try {
    await navigator.clipboard.writeText(jsonText.value)
    message.success(t('pages.settings.voiceClone.debugCopied'))
  } catch {
    message.error(t('common.copyFailed'))
  }
}

function syncPoll() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  // Only poll while synthesizing / CosyVoice setup — not whenever the panel is open.
  if (props.autoRefresh) {
    pollTimer = setInterval(() => {
      void refresh({ silent: true })
    }, 5000)
  }
}

watch(() => props.autoRefresh, () => syncPoll())

onMounted(() => {
  void refresh()
  syncPoll()
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

defineExpose({ refresh, runProbe })
</script>

<template>
  <NCollapse v-model:expanded-names="expanded">
    <NCollapseItem :title="t('pages.settings.voiceClone.debugTitle')" name="console">
      <NSpace vertical :size="12">
        <NText depth="3" style="font-size: 13px">
          {{ t('pages.settings.voiceClone.debugHint') }}
        </NText>

        <NSpace :size="8" wrap>
          <NButton size="small" :loading="loading" @click="refresh">
            {{ t('pages.settings.voiceClone.debugRefresh') }}
          </NButton>
          <NButton size="small" type="primary" :loading="probing" @click="runProbe">
            {{ t('pages.settings.voiceClone.debugProbe') }}
          </NButton>
          <NButton size="small" quaternary @click="copyJson">
            {{ t('pages.settings.voiceClone.debugCopy') }}
          </NButton>
        </NSpace>

        <NSpace v-if="report?.hints?.length" vertical :size="6">
          <NTag
            v-for="(h, i) in report.hints"
            :key="i"
            :type="hintTagType(h.level)"
            size="small"
            style="white-space: normal; height: auto; padding: 6px 10px"
          >
            {{ h.text }}
          </NTag>
        </NSpace>

        <div v-if="summaryLines.length" class="voice-debug-summary">
          <div v-for="(line, i) in summaryLines" :key="i">{{ line }}</div>
        </div>

        <div>
          <NText strong style="font-size: 12px; display: block; margin-bottom: 6px">
            {{ t('pages.settings.voiceClone.debugLogs') }}
          </NText>
          <pre class="voice-debug-logs">{{ logText }}</pre>
        </div>

        <NCode :code="jsonText" language="json" word-wrap style="max-height: 280px; overflow: auto" />
      </NSpace>
    </NCollapseItem>
  </NCollapse>
</template>

<style scoped>
.voice-debug-summary {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-color-2);
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(127, 127, 127, 0.08);
}

.voice-debug-logs {
  margin: 0;
  max-height: 160px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.45;
  padding: 8px 10px;
  border-radius: 8px;
  background: #0d1117;
  color: #c9d1d9;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
