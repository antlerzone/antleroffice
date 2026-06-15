<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NButton, NInput, NTag, useMessage } from 'naive-ui'
import { useBossStore } from '@/stores/boss'
import { useOfficeShareStore } from '@/stores/officeShare'

interface ShareInfo {
  enabled: boolean
  officeId: string | null
  inviteCode: string | null
  hostUrl: string | null
  role: string | null
}

const boss = useBossStore()
const officeShare = useOfficeShareStore()
const message = useMessage()
const expanded = ref(false)
const loading = ref(false)
const share = ref<ShareInfo | null>(null)
const joinCode = ref('')
const joinHost = ref('http://127.0.0.1:3020')
const ecsEnabled = ref(false)

async function load() {
  try {
    const cfg = await fetch('/api/boss/auth/config').then((r) => r.json())
    ecsEnabled.value = !!cfg.ecsEnabled
  } catch {
    ecsEnabled.value = false
  }
  if (!ecsEnabled.value) return
  try {
    const data = await fetch('/api/office/share/info').then((r) => r.json())
    share.value = data.share || null
  } catch {
    share.value = null
  }
}

onMounted(() => {
  void load()
})

async function enableShare() {
  loading.value = true
  try {
    const res = await fetch('/api/office/share/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...boss.authHeaders() },
      body: JSON.stringify({ token: boss.token, name: 'Antler Office' }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'Enable failed')
    share.value = data.share
    await officeShare.refresh()
    message.success('Office sharing enabled')
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Enable failed')
  } finally {
    loading.value = false
  }
}

async function joinShare() {
  loading.value = true
  try {
    const res = await fetch('/api/office/share/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...boss.authHeaders() },
      body: JSON.stringify({
        token: boss.token,
        inviteCode: joinCode.value.trim(),
        hostUrl: joinHost.value.trim(),
      }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'Join failed')
    share.value = data.share
    await officeShare.refresh()
    message.success('Joined office')
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Join failed')
  } finally {
    loading.value = false
  }
}

async function disableShare() {
  loading.value = true
  try {
    const data = await fetch('/api/office/share/disable', { method: 'POST' }).then((r) => r.json())
    share.value = data.share
    await officeShare.refresh()
    message.success('Office sharing disabled')
  } catch {
    message.error('Could not disable sharing')
  } finally {
    loading.value = false
  }
}

function copy(text: string) {
  void navigator.clipboard.writeText(text)
  message.success('Copied')
}
</script>

<template>
  <div v-if="ecsEnabled" class="office-share">
    <button type="button" class="toggle" @click="expanded = !expanded">
      Office sharing
      <NTag v-if="share?.enabled" size="small" type="success" round>{{ share.role || 'on' }}</NTag>
    </button>
    <div v-if="expanded" class="panel">
      <template v-if="share?.enabled && share.role === 'owner'">
        <p class="hint">Share this invite code and host URL with teammates.</p>
        <div class="row">
          <span class="label">Invite code</span>
          <code>{{ share.inviteCode }}</code>
          <NButton size="tiny" quaternary @click="copy(share.inviteCode || '')">Copy</NButton>
        </div>
        <div class="row">
          <span class="label">Host URL</span>
          <code>{{ share.hostUrl }}</code>
          <NButton size="tiny" quaternary @click="copy(share.hostUrl || '')">Copy</NButton>
        </div>
        <NButton size="small" :loading="loading" @click="disableShare">Stop sharing</NButton>
      </template>
      <template v-else-if="share?.enabled">
        <p class="hint">Connected as {{ share.role }} to {{ share.hostUrl }}</p>
        <NButton size="small" :loading="loading" @click="disableShare">Leave office</NButton>
      </template>
      <template v-else>
        <p class="hint">Host this machine or join a teammate's office (Plan 4a).</p>
        <NButton type="primary" size="small" :loading="loading" @click="enableShare">
          Enable sharing (host)
        </NButton>
        <div class="join">
          <NInput v-model:value="joinCode" placeholder="Invite code" size="small" />
          <NInput v-model:value="joinHost" placeholder="Host URL" size="small" />
          <NButton size="small" :loading="loading" @click="joinShare">Join office</NButton>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.office-share {
  margin-left: auto;
}
.toggle {
  background: transparent;
  border: 1px solid #333;
  color: #9aa0a6;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.panel {
  position: absolute;
  right: 16px;
  bottom: 48px;
  width: 320px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid #2a2f3a;
  background: #171a21;
  z-index: 20;
}
.hint {
  font-size: 12px;
  color: #9aa0a6;
  margin: 0 0 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 12px;
}
.label {
  color: #9aa0a6;
  min-width: 72px;
}
code {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.join {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
