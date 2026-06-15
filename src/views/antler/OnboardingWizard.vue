<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import {
  NModal,
  NCard,
  NButton,
  NSpace,
  NInput,
  NTag,
  NCheckbox,
  useMessage,
} from 'naive-ui'
import { useAntlerApi } from '@/composables/useAntlerApi'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'done'): void }>()

const api = useAntlerApi()
const message = useMessage()
const ocInstalled = ref(false)
const hmInstalled = ref(false)
const ocVersion = ref('')
const hmVersion = ref('')
const logLines = ref<string[]>([])
const installing = ref(false)
const apiKey = ref('')
const model = ref('gpt-4o-mini')

const enableMcpPack = ref(true)
const enableCoo = ref(true)
const enableAdmin = ref(true)
const enableIt = ref(true)
const perplexityKey = ref('')
const firecrawlKey = ref('')
const mcpPackApplied = ref(false)
const mcpApplying = ref(false)

let pollTimer: ReturnType<typeof setInterval> | null = null

async function refreshStatus() {
  const st = await api.get<{
    openclaw: { installed: boolean; version?: string }
    hermes: { installed: boolean; version?: string }
  }>('/api/onboard/status')
  ocInstalled.value = st.openclaw?.installed ?? false
  hmInstalled.value = st.hermes?.installed ?? false
  ocVersion.value = st.openclaw?.version || ''
  hmVersion.value = st.hermes?.version || ''
}

async function refreshMcpStatus() {
  const st = await api.get<{ pack?: { enabled?: boolean } }>('/api/onboard/mcp-pack/status')
  mcpPackApplied.value = !!st.pack?.enabled
}

async function pollLog() {
  const log = await api.get<{ lines: string[]; installing: string | null }>('/api/onboard/log')
  logLines.value = log.lines || []
  installing.value = !!log.installing
  if (!log.installing) await refreshStatus()
}

async function install(name: 'openclaw' | 'hermes') {
  await api.send('POST', '/api/onboard/install', { name })
  message.info(`Installing ${name}…`)
}

async function saveKey() {
  if (!apiKey.value.trim()) {
    message.warning('Paste a key or skip for now')
    return
  }
  try {
    const r = await api.send<{ ok: boolean; verified?: boolean }>('POST', '/api/onboard/openclaw-key', {
      provider: 'openai',
      apiKey: apiKey.value.trim(),
      model: model.value.trim(),
    })
    message.success(r.verified ? 'Key verified — OpenClaw is ready' : 'Key saved')
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Could not save key')
  }
}

async function applyMcpPack() {
  if (!enableMcpPack.value) return
  mcpApplying.value = true
  try {
    const r = await api.send<{
      ok: boolean
      warnings?: string[]
      slugToMcpId?: Record<string, string>
    }>('POST', '/api/onboard/mcp-pack/apply', {
      enableCoo: enableCoo.value,
      enableAdmin: enableAdmin.value,
      enableIt: enableIt.value,
      perplexityApiKey: perplexityKey.value.trim(),
      firecrawlApiKey: firecrawlKey.value.trim(),
      installPlaywright: enableIt.value,
    })
    mcpPackApplied.value = true
    const warn = (r.warnings || []).filter(Boolean)
    if (warn.length) message.warning(warn.join(' '))
    else message.success('Default MCP pack enabled — COO / Admin / IT bindings saved')
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'MCP pack setup failed')
  } finally {
    mcpApplying.value = false
  }
}

async function finish() {
  if (enableMcpPack.value && !mcpPackApplied.value) {
    await applyMcpPack()
  }
  emit('done')
  emit('close')
}

onMounted(async () => {
  await Promise.all([refreshStatus(), refreshMcpStatus()])
  pollTimer = setInterval(() => pollLog().catch(() => {}), 2000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="Welcome to AntlerOffice 2.0"
    style="width: min(680px, 96vw)"
    :mask-closable="false"
    @update:show="(v) => !v && emit('close')"
  >
    <p class="hint">No command line needed — we'll set up OpenClaw (runs tasks) and Hermes (memory).</p>

    <NSpace vertical size="large">
      <NCard size="small" title="OpenClaw">
        <NTag :type="ocInstalled ? 'success' : 'warning'">
          {{ ocInstalled ? `Installed ${ocVersion}` : 'Not installed' }}
        </NTag>
        <NButton v-if="!ocInstalled" style="margin-left: 12px" @click="install('openclaw')">
          Install OpenClaw
        </NButton>
      </NCard>

      <NCard size="small" title="Hermes (memory)">
        <NTag :type="hmInstalled ? 'success' : 'default'">
          {{ hmInstalled ? `Installed ${hmVersion}` : 'Optional' }}
        </NTag>
        <NButton v-if="!hmInstalled" style="margin-left: 12px" @click="install('hermes')">
          Install Hermes
        </NButton>
      </NCard>

      <NCard size="small" title="Your OpenAI API key">
        <NInput v-model:value="apiKey" type="password" placeholder="sk-…" style="margin-bottom: 8px" />
        <NInput v-model:value="model" placeholder="Model (e.g. gpt-4o-mini)" style="margin-bottom: 8px" />
        <NButton @click="saveKey">Save key</NButton>
      </NCard>

      <NCard size="small" title="Default MCP pack (recommended)">
        <p class="hint sm">
          COO + Admin get web research (Perplexity, Firecrawl). IT gets browser automation (Playwright).
        </p>
        <NCheckbox v-model:checked="enableMcpPack" style="margin-bottom: 8px">
          Enable department MCP bindings
        </NCheckbox>
        <template v-if="enableMcpPack">
          <NSpace vertical size="small" style="margin-bottom: 10px">
            <NCheckbox v-model:checked="enableCoo">COO · OpenClaw — Perplexity + Firecrawl</NCheckbox>
            <NCheckbox v-model:checked="enableAdmin">Admin — Perplexity + Firecrawl</NCheckbox>
            <NCheckbox v-model:checked="enableIt">IT — Playwright browser (installs Chromium)</NCheckbox>
          </NSpace>
          <NInput
            v-model:value="perplexityKey"
            type="password"
            placeholder="Perplexity API key (optional now)"
            style="margin-bottom: 8px"
          />
          <NInput
            v-model:value="firecrawlKey"
            type="password"
            placeholder="Firecrawl API key (optional now)"
            style="margin-bottom: 8px"
          />
          <NTag v-if="mcpPackApplied" type="success">MCP pack applied</NTag>
          <NButton v-else :loading="mcpApplying" @click="applyMcpPack">Apply MCP pack now</NButton>
        </template>
      </NCard>

      <details v-if="logLines.length">
        <summary>Install log</summary>
        <pre class="log">{{ logLines.join('\n') }}</pre>
      </details>

      <NSpace justify="end">
        <NButton @click="finish">Skip — try demo</NButton>
        <NButton type="primary" :loading="mcpApplying || installing" @click="finish">Continue</NButton>
      </NSpace>
    </NSpace>
  </NModal>
</template>

<style scoped>
.hint {
  opacity: 0.8;
  margin-bottom: 16px;
}
.hint.sm {
  font-size: 12px;
  margin-bottom: 8px;
}
.log {
  max-height: 160px;
  overflow: auto;
  font-size: 11px;
  background: #111;
  color: #ccc;
  padding: 8px;
  border-radius: 6px;
}
</style>
