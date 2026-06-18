<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NModal,
  NButton,
  NSpace,
  NInput,
  NSelect,
  NText,
  useMessage,
} from 'naive-ui'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useAiSetupStore } from '@/stores/aiSetup'
import { AI_PROVIDERS, aiProviderOptions } from '@/lib/ai-providers'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'done'): void }>()

const api = useAntlerApi()
const message = useMessage()
const aiSetup = useAiSetupStore()

const provider = ref('openai')
const apiKey = ref('')
const model = ref('')
const models = ref<{ label: string; value: string }[]>([])
const loadingModels = ref(false)
const saving = ref(false)

const providers = aiProviderOptions()

const modelOptions = computed(() => {
  const prefix = `${provider.value}/`
  const filtered = models.value.filter((m) => m.value.startsWith(prefix))
  return filtered.length ? filtered : models.value
})

async function loadModels() {
  loadingModels.value = true
  try {
    const st = await api.get<{ available: boolean; models?: { model?: string } }>('/api/openclaw/status')
    if (st.models?.model) model.value = st.models.model
    const ml = await api.get<{ models: { key: string; name: string; available: boolean }[] }>(
      '/api/openclaw/models?all=1',
    )
    models.value = (ml.models || []).map((m) => ({
      label: m.name || m.key,
      value: m.key,
    }))
    if (!model.value && modelOptions.value.length) {
      const preset = AI_PROVIDERS.find((p) => p.id === provider.value)
      model.value =
        modelOptions.value.find((m) => m.value === preset?.defaultModel)?.value ||
        modelOptions.value.find((m) => m.value.startsWith(`${provider.value}/`))?.value ||
        modelOptions.value[0].value
    }
  } catch {
    models.value = []
  } finally {
    loadingModels.value = false
  }
}

watch(
  () => props.show,
  (visible) => {
    if (visible) void loadModels()
  },
  { immediate: true },
)

watch(provider, () => {
  const match = modelOptions.value.find((m) => m.value.startsWith(`${provider.value}/`))
  if (match) model.value = match.value
})

async function saveAndContinue() {
  const key = apiKey.value.trim()
  if (!key) {
    message.warning('Paste an API key or skip for now')
    return
  }
  if (!model.value) {
    message.warning('Choose a default model')
    return
  }
  saving.value = true
  try {
    const r = await api.send<{ ok: boolean; verified?: boolean; error?: string }>(
      'POST',
      '/api/onboard/openclaw-key',
      {
        provider: provider.value,
        apiKey: key,
        model: model.value,
      },
    )
    if (!r.ok) throw new Error(r.error || 'Could not save key')
    message.success(r.verified ? 'AI connected — you are ready to go' : 'Key saved')
    apiKey.value = ''
    emit('done')
    emit('close')
    aiSetup.close()
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Could not save key')
  } finally {
    saving.value = false
  }
}

async function skipForNow() {
  try {
    await api.send('POST', '/api/onboard/ai-skip', {})
  } catch {
    /* ignore */
  }
  emit('done')
  emit('close')
  aiSetup.close()
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="Connect your AI"
    style="width: min(520px, 96vw)"
    :mask-closable="false"
    @update:show="(v) => !v && skipForNow()"
  >
    <p class="hint">
      Choose any OpenClaw-supported model and paste your provider API key.
      OpenClaw, Hermes, and MCP tools are already installed on this PC.
    </p>
    <p v-if="aiSetup.reason" class="hint warn">{{ aiSetup.reason }}</p>

    <NSpace vertical size="large">
      <div>
        <label class="field-label">Provider</label>
        <NSelect v-model:value="provider" :options="providers" />
      </div>

      <div>
        <label class="field-label">Default model</label>
        <NSelect
          v-model:value="model"
          :options="modelOptions"
          :loading="loadingModels"
          filterable
          placeholder="Pick a model…"
        />
        <NText depth="3" style="display: block; margin-top: 6px; font-size: 12px;">
          Same catalog as OpenClaw — not limited to OpenAI.
        </NText>
      </div>

      <div>
        <label class="field-label">API key</label>
        <NInput v-model:value="apiKey" type="password" placeholder="Paste provider API key…" />
      </div>

      <NSpace justify="end">
        <NButton :disabled="saving" @click="skipForNow">Skip for now</NButton>
        <NButton type="primary" :loading="saving" @click="saveAndContinue">Save &amp; continue</NButton>
      </NSpace>

      <NText depth="3" style="font-size: 12px; line-height: 1.5;">
        You can skip now. When an agent needs AI, AntlerOffice will ask you to connect a model here or under Settings → Models.
      </NText>
    </NSpace>
  </NModal>
</template>

<style scoped>
.hint {
  opacity: 0.85;
  margin: 0 0 16px;
  line-height: 1.5;
}
.hint.warn {
  color: var(--warning-color, #f0b43c);
}
.field-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 8px;
  opacity: 0.75;
}
</style>

