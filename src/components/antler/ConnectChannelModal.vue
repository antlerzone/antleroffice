<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { NModal, NSelect, NInput, NButton, useMessage } from 'naive-ui'
import { CHANNEL_META, channelMeta, PRIMARY_CHANNEL_IDS, OTHER_CHANNEL_IDS } from '@/lib/antler-channel-meta'
import { useAntlerApi } from '@/composables/useAntlerApi'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void; (e: 'connected'): void }>()

const api = useAntlerApi()
const message = useMessage()

const provider = ref('whatsapp')
const displayName = ref('')
const connectAccount = ref('default')
const error = ref('')
const busy = ref(false)
const qrDataUrl = ref('')
const qrHint = ref('')
const fieldValues = ref<Record<string, string>>({})

const providerOptions = computed(() => [
  {
    type: 'group' as const,
    label: 'Messaging',
    key: 'primary',
    children: PRIMARY_CHANNEL_IDS.map((id) => ({
      label: CHANNEL_META[id]!.label,
      value: id,
    })),
  },
  ...(OTHER_CHANNEL_IDS.length
    ? [
        {
          type: 'group' as const,
          label: 'More channels',
          key: 'other',
          children: OTHER_CHANNEL_IDS.map((id) => ({
            label: CHANNEL_META[id]!.label,
            value: id,
          })),
        },
      ]
    : []),
])

const meta = computed(() => channelMeta(provider.value))
const isLogin = computed(() => !!meta.value.login)
const isWhatsApp = computed(() => provider.value === 'whatsapp')

watch(
  () => props.show,
  (open) => {
    if (!open) return
    provider.value = 'whatsapp'
    displayName.value = ''
    error.value = ''
    qrDataUrl.value = ''
    qrHint.value = ''
    fieldValues.value = {}
    void refreshAccount()
  },
)

watch(provider, () => {
  error.value = ''
  qrDataUrl.value = ''
  qrHint.value = ''
  fieldValues.value = {}
  void refreshAccount()
})

async function refreshAccount() {
  const m = channelMeta(provider.value)
  if (!m.multiAccount) {
    connectAccount.value = 'default'
    return
  }
  const r = await api.get<{ account?: string }>(
    `/api/channels/next-account?provider=${encodeURIComponent(provider.value)}`,
  ).catch(() => ({ account: 'default' as string | undefined }))
  connectAccount.value = r.account || 'default'
}

function close() {
  emit('update:show', false)
}

async function pollWhatsApp(account: string, name: string) {
  busy.value = true
  error.value = 'Scanned? Finishing connection — keep this open up to 3 minutes.'
  try {
    const q = new URLSearchParams({ timeoutMs: '180000', account })
    if (name) q.set('name', name)
    const w = await api.get<{ connected?: boolean; message?: string; needsNewQr?: boolean }>(
      `/api/channels/whatsapp/login/wait?${q}`,
      { timeoutMs: 210000 },
    )
    if (w.connected) {
      await finishWhatsApp(account, name)
      return
    }
    if (w.needsNewQr) {
      await startWhatsAppQr(true)
      return
    }
    const st = await api.get<{ linked?: boolean; connected?: boolean }>(
      `/api/channels/whatsapp/status?account=${encodeURIComponent(account)}`,
    )
    if (st.linked || st.connected) {
      await finishWhatsApp(account, name)
      return
    }
    error.value = w.message || 'Still connecting — tap Retry QR'
  } catch (e) {
    const st = await api.get<{ linked?: boolean; connected?: boolean }>(
      `/api/channels/whatsapp/status?account=${encodeURIComponent(account)}`,
    ).catch(() => null)
    if (st?.linked || st?.connected) await finishWhatsApp(account, name)
    else error.value = e instanceof Error ? e.message : 'Connection timed out'
  } finally {
    busy.value = false
  }
}

async function finishWhatsApp(account: string, name: string) {
  try {
    await api.send('POST', '/api/channels', { provider: 'whatsapp', account, name: name || undefined })
  } catch { /* wait may have registered */ }
  message.success('WhatsApp connected')
  emit('connected')
  close()
}

async function startWhatsAppQr(force = false) {
  const account = connectAccount.value
  const name = displayName.value.trim()
  busy.value = true
  error.value = ''
  qrDataUrl.value = ''
  qrHint.value = 'Preparing…'
  try {
    const st = await api.get<{ linked?: boolean; gateway?: boolean }>(
      `/api/channels/whatsapp/status?account=${encodeURIComponent(account)}`,
    ).catch(() => ({ linked: false, gateway: false }))
    if (st.linked && !force) {
      await finishWhatsApp(account, name)
      return
    }
    if (!st.gateway) {
      qrHint.value = 'Starting connection engine…'
      await api.send('POST', '/api/gateway/start', {}, { timeoutMs: 60000 })
      await new Promise((r) => setTimeout(r, 2000))
    }
    qrHint.value = 'Generating QR code (up to 45s)…'
    const r = await api.send<{
      qrDataUrl?: string
      alreadyLinked?: boolean
      needsGatewayRestart?: boolean
      message?: string
      error?: string
    }>(
      'POST',
      '/api/channels/whatsapp/login/start',
      { force, account, name: name || undefined },
      { timeoutMs: 70000 },
    )
    if (r.alreadyLinked) {
      await finishWhatsApp(account, name)
      return
    }
    if (r.needsGatewayRestart) {
      error.value = r.error || 'Restarting connection engine…'
      await api.send('POST', '/api/gateway/restart', {}, { timeoutMs: 90000 }).catch(() => {})
      return
    }
    if (r.qrDataUrl) {
      qrDataUrl.value = r.qrDataUrl
      qrHint.value = r.message || 'Scan with WhatsApp → Linked Devices'
      await pollWhatsApp(account, name)
      return
    }
    error.value = r.error || r.message || 'Could not get QR'
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'WhatsApp QR failed'
  } finally {
    busy.value = false
  }
}

async function connectTokenChannel() {
  const m = meta.value
  const body: Record<string, string> = { provider: provider.value }
  if (m.multiAccount) {
    body.account = connectAccount.value
    const n = displayName.value.trim()
    if (n) body.name = n
  }
  let missing = false
  for (const f of m.fields || []) {
    const v = (fieldValues.value[f.key] || '').trim()
    if (!v) missing = true
    else body[f.key] = v
  }
  if (missing) {
    error.value = 'Fill in all required fields.'
    return
  }
  busy.value = true
  error.value = ''
  try {
    await api.send('POST', '/api/channels', body)
    message.success(`${m.label} connected`)
    emit('connected')
    close()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Connect failed'
  } finally {
    busy.value = false
  }
}

async function onConnect() {
  if (isWhatsApp.value) {
    await refreshAccount()
    return startWhatsAppQr(false)
  }
  if (isLogin.value) {
    error.value = `${meta.value.label} in-app linking is not available yet. Use the OpenClaw CLI.`
    return
  }
  await connectTokenChannel()
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="Connect a channel"
    style="max-width: 480px"
    @update:show="emit('update:show', $event)"
  >
    <label class="modal-label">Channel</label>
    <NSelect v-model:value="provider" :options="providerOptions" style="margin: 8px 0 12px" />

    <template v-if="meta.multiAccount">
      <label class="modal-label">Display name (optional)</label>
      <NInput v-model:value="displayName" placeholder="e.g. Support line" style="margin: 8px 0" />
      <p class="hint">
        {{
          isWhatsApp
            ? 'Each connection is a separate phone number. Account ID is assigned automatically.'
            : 'Each connection is a separate account. Account ID is assigned automatically.'
        }}
      </p>
    </template>

    <template v-if="isWhatsApp">
      <p class="hint">
        WhatsApp links by scanning a QR code (WhatsApp → Linked Devices). After linking,
        <strong>only “Message yourself”</strong> on that number sends instructions — other chats are ignored.
      </p>
      <p v-if="qrHint" class="qr-hint">{{ qrHint }}</p>
      <img v-if="qrDataUrl" :src="qrDataUrl" alt="WhatsApp QR" class="wa-qr" />
    </template>

    <template v-else-if="!isLogin">
      <div v-for="f in meta.fields || []" :key="f.key">
        <label class="modal-label">{{ f.label }}</label>
        <NInput
          v-model:value="fieldValues[f.key]"
          type="password"
          :placeholder="f.label"
          style="margin: 8px 0 12px"
        />
      </div>
    </template>

    <template v-else>
      <p class="hint">{{ meta.label }} uses QR / device linking via CLI for now.</p>
    </template>

    <p v-if="error" class="modal-error">{{ error }}</p>

    <template #footer>
      <NButton @click="close">Cancel</NButton>
      <NButton type="primary" :loading="busy" @click="onConnect">
        {{ isWhatsApp ? (qrDataUrl ? 'Waiting for scan…' : 'Show QR code') : 'Connect' }}
      </NButton>
    </template>
  </NModal>
</template>

<style scoped>
.modal-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.8;
}
.hint {
  font-size: 13px;
  opacity: 0.75;
  margin: 8px 0;
}
.modal-error {
  color: #e88080;
  font-size: 13px;
  margin-top: 8px;
}
.qr-hint {
  font-size: 13px;
  color: var(--accent-2, #46d160);
}
.wa-qr {
  display: block;
  margin-top: 12px;
  max-width: 240px;
  background: #fff;
  padding: 8px;
  border-radius: 8px;
}
</style>
