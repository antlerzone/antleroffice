<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { NCard, NText, NButton, NSpace, NAlert, useMessage } from 'naive-ui'

const message = useMessage()
const currentVersion = ref('')
const pendingVersion = ref<string | null>(null)
const scheduledAt = ref<number | null>(null)
const checking = ref(false)
const isElectron = typeof window !== 'undefined' && !!(window as Window & { antlerDesktop?: { isElectron: boolean } }).antlerDesktop?.isElectron

let unsub: (() => void) | undefined

async function loadStatus() {
  try {
    const res = await fetch('/api/app/update/status')
    const data = await res.json()
    if (data.ok) {
      currentVersion.value = data.currentVersion || ''
      pendingVersion.value = data.schedule?.pendingVersion || null
      scheduledAt.value = data.schedule?.scheduledAt || null
    }
  } catch { /* */ }
}

async function checkUpdate() {
  checking.value = true
  try {
    const desktop = (window as Window & { antlerDesktop?: { checkForUpdates: () => Promise<{ ok: boolean; version?: string; error?: string }> } }).antlerDesktop
    if (desktop?.checkForUpdates) {
      const r = await desktop.checkForUpdates()
      if (r.version) message.info(`Update available: v${r.version}`)
      else if (r.error) message.warning(r.error)
      else message.success('You are on the latest version')
    } else {
      message.info('Updates are installed via the AntlerOffice desktop app')
    }
  } finally {
    checking.value = false
  }
}

async function approveUpdate() {
  const desktop = (window as Window & { antlerDesktop?: { approveUpdate: () => Promise<{ ok: boolean }> } }).antlerDesktop
  if (!desktop?.approveUpdate) {
    message.warning('Open the AntlerOffice desktop app to install updates')
    return
  }
  await desktop.approveUpdate()
  message.success('Downloading update…')
}

onMounted(() => {
  loadStatus()
  const desktop = (window as Window & { antlerDesktop?: { onUpdateStatus: (cb: (p: { type: string; version?: string }) => void) => () => void } }).antlerDesktop
  if (desktop?.onUpdateStatus) {
    unsub = desktop.onUpdateStatus((p) => {
      if (p.type === 'available' && p.version) {
        pendingVersion.value = p.version
        message.info(`AntlerOffice v${p.version} is available — Boss approval required`)
      }
    })
  }
})

onUnmounted(() => {
  unsub?.()
})
</script>

<template>
  <NCard title="App updates" class="app-card">
    <NSpace vertical :size="12">
      <NText>Current version: <strong>{{ currentVersion || '…' }}</strong></NText>
      <NAlert v-if="pendingVersion" type="warning" :bordered="false">
        v{{ pendingVersion }} is available. Boss must approve before install and restart.
      </NAlert>
      <NText v-if="scheduledAt" depth="3">
        Scheduled: {{ new Date(scheduledAt).toLocaleString() }}
      </NText>
      <NSpace>
        <NButton :loading="checking" :disabled="!isElectron" @click="checkUpdate">Check for updates</NButton>
        <NButton v-if="pendingVersion" type="primary" :disabled="!isElectron" @click="approveUpdate">
          Approve update
        </NButton>
      </NSpace>
      <NText depth="3" style="font-size: 13px">
        Tell COO: “Update AntlerOffice now” or “Schedule update at 2am tomorrow”.
      </NText>
    </NSpace>
  </NCard>
</template>
