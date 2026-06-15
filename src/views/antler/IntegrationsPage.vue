<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NCard, NInput, NButton, NSelect, NSpace, NTag, useMessage } from 'naive-ui'
import { useAntlerApi } from '@/composables/useAntlerApi'

const api = useAntlerApi()
const message = useMessage()
const available = ref(false)
const model = ref('')
const models = ref<{ label: string; value: string }[]>([])
const openaiKey = ref('')
const savingKey = ref(false)
const savingModel = ref(false)

const providers = [
  { id: 'openai', name: 'OpenAI' },
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'gemini', name: 'Google Gemini' },
]

async function load() {
  try {
    const st = await api.get<{ available: boolean; models?: { model?: string } }>('/api/openclaw/status')
    available.value = !!st.available
    if (!st.available) return
    const ml = await api.get<{ models: { key: string; name: string; available: boolean }[] }>(
      '/api/openclaw/models?all=1',
    )
    models.value = (ml.models || [])
      .filter((m) => m.available)
      .map((m) => ({ label: m.name || m.key, value: m.key }))
    if (st.models?.model) model.value = st.models.model
  } catch {
    available.value = false
  }
}

async function saveProvider(provider: string) {
  const key = openaiKey.value.trim()
  if (!key) return
  savingKey.value = true
  try {
    await api.send('POST', '/api/openclaw/provider-key', { provider, apiKey: key })
    message.success('Key saved')
    openaiKey.value = ''
    await load()
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Failed')
  } finally {
    savingKey.value = false
  }
}

async function saveModel() {
  if (!model.value) return
  savingModel.value = true
  try {
    await api.send('POST', '/api/openclaw/model', { ref: model.value })
    message.success('Default model updated')
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Failed')
  } finally {
    savingModel.value = false
  }
}

onMounted(() => load())
</script>

<template>
  <div>
    <h2 style="margin-top: 0">Integrations</h2>
    <p class="hint">Connect your AI keys — we store them in OpenClaw for you. No CLI.</p>

    <NCard v-if="!available" title="Setup needed">
      <p>OpenClaw is not installed yet. Use the setup wizard from Home or Settings.</p>
    </NCard>

    <template v-else>
      <NCard title="Default model" style="margin-bottom: 16px">
        <NSpace>
          <NSelect v-model:value="model" :options="models" style="min-width: 280px" />
          <NButton type="primary" :loading="savingModel" @click="saveModel">Set default</NButton>
        </NSpace>
      </NCard>

      <NCard title="Provider keys">
        <div v-for="p in providers" :key="p.id" class="prov-row">
          <div><strong>{{ p.name }}</strong> <NTag size="small">{{ p.id }}</NTag></div>
          <NSpace style="margin-top: 8px">
            <NInput v-model:value="openaiKey" type="password" placeholder="Paste API key…" style="min-width: 280px" />
            <NButton :loading="savingKey" @click="saveProvider(p.id)">Save</NButton>
          </NSpace>
        </div>
        <p class="hint" style="margin-top: 12px">Keys are masked after save. All agents share the default model above.</p>
      </NCard>
    </template>
  </div>
</template>

<style scoped>
.hint {
  opacity: 0.75;
  margin-bottom: 16px;
}
.prov-row {
  padding: 12px 0;
  border-bottom: 1px solid var(--border-color, #eee);
}
.prov-row:last-child {
  border-bottom: none;
}
</style>
