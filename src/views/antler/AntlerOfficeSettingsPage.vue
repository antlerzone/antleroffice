<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { NCard, NForm, NFormItem, NInput, NButton, NSpin, NSelect, NTag, NSpace, NTabs, NTabPane, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useOfficeProfile } from '@/composables/useOfficeProfile'
import { useLocalGateway } from '@/composables/useLocalGateway'
import { useThemeStore, type ThemeMode } from '@/stores/theme'
import { useBossStore } from '@/stores/boss'
import SummonSettingsTab from '@/components/settings/SummonSettingsTab.vue'
import VoiceSettingsTab from '@/components/settings/VoiceSettingsTab.vue'
import PersonaSettingsTab from '@/components/settings/PersonaSettingsTab.vue'
import DailyStandupSettingsTab from '@/components/settings/DailyStandupSettingsTab.vue'
import DevToolsSettingsTab from '@/components/settings/DevToolsSettingsTab.vue'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import { buildDesktopUnbindSignInUrl } from '@/lib/office-web'
import { openExternalUrl } from '@/lib/desktop-shell'

const PENDING_UNBIND_KEY = 'antleroffice-pending-unbind'

const { t } = useI18n()
const message = useMessage()
const themeStore = useThemeStore()
const boss = useBossStore()
const { bossDisplayName, desktopDisplayName, hostname, load, save } = useOfficeProfile()
const localGateway = useLocalGateway()
const { ensureLoaded } = useVoiceAssistantSettings()
const settingsTab = ref('general')
const loading = ref(true)
const saving = ref(false)
const reconnecting = ref(false)
const localBindStatus = ref<'unbound' | 'owned_by_me' | 'owned_by_other'>('unbound')

const gatewayStatus = computed(() => {
  if (localGateway.checking.value) return { label: 'Connecting…', type: 'info' as const }
  if (localGateway.live.value) return { label: 'Connected', type: 'success' as const }
  return { label: 'Disconnected', type: 'error' as const }
})

const themeOptions = computed(() => [
  { label: t('pages.settings.themeLight'), value: 'light' },
  { label: t('pages.settings.themeDark'), value: 'dark' },
])

const autosaveTabs = new Set(['summon', 'voice', 'persona', 'standup'])
const showAutosaveBadge = computed(() => autosaveTabs.has(settingsTab.value))

onMounted(async () => {
  loading.value = true
  ensureLoaded()
  localGateway.startBackground()
  try {
    await load()
    await loadLocalBindStatus()
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Could not load settings')
  } finally {
    loading.value = false
  }
})

async function loadLocalBindStatus() {
  if (!boss.token) return
  try {
    const headers: Record<string, string> = { 'X-Boss-Token': boss.token }
    const res = await fetch('/api/portal/desktops', { headers })
    const data = await res.json()
    if (res.ok && data.ok) {
      localBindStatus.value = data.localBindStatus || 'unbound'
    }
  } catch {
    localBindStatus.value = 'unbound'
  }
}

function startUnbindFlow() {
  try {
    localStorage.setItem(PENDING_UNBIND_KEY, '1')
  } catch {
    /* ignore */
  }
  openExternalUrl(buildDesktopUnbindSignInUrl())
}

async function reconnectOpenClaw() {
  reconnecting.value = true
  try {
    await fetch('/api/gateway/start', { method: 'POST' })
    await localGateway.refresh()
    if (localGateway.live.value) message.success('OpenClaw gateway connected')
    else message.warning('OpenClaw is still offline — ensure it is installed and running')
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Reconnect failed')
  } finally {
    reconnecting.value = false
  }
}

function handleThemeChange(mode: ThemeMode) {
  themeStore.setMode(mode)
}

async function onSave() {
  saving.value = true
  try {
    await save({
      bossDisplayName: bossDisplayName.value,
      desktopDisplayName: desktopDisplayName.value,
    })
    message.success('Settings saved')
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Could not save settings')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="antler-v1-root office-settings-page">
    <div class="view-head">
      <h2 class="view-title">
        {{ t('routes.settings') }}
        <NTag v-if="showAutosaveBadge" size="small" round :bordered="false" class="autosave-badge">
          {{ t('pages.settings.autosaveBadge') }}
        </NTag>
      </h2>
    </div>
    <p class="hint">
      <template v-if="showAutosaveBadge">{{ t('pages.settings.autosaveHint') }}</template>
      <template v-else>{{ t('pages.settings.generalHint') }}</template>
    </p>

    <NSpin :show="loading">
      <NTabs v-model:value="settingsTab" type="line" animated class="settings-tabs">
        <NTabPane name="general" :tab="t('pages.settings.voiceAssistant.tabs.general')">
          <NCard title="OpenClaw on this PC" class="office-settings-card">
        <NSpace align="center" style="margin-bottom: 12px">
          <NTag :type="gatewayStatus.type">{{ gatewayStatus.label }}</NTag>
          <span v-if="localGateway.gatewayUrl" class="hint sm" style="margin: 0">{{ localGateway.gatewayUrl }}</span>
        </NSpace>
        <p class="hint sm">
          AntlerOffice talks to your local OpenClaw gateway automatically. Use reconnect only if the header shows Disconnected.
        </p>
        <NButton :loading="reconnecting" style="margin-top: 12px" @click="reconnectOpenClaw">
          Reconnect OpenClaw
        </NButton>
        <div v-if="localBindStatus === 'owned_by_me'" style="margin-top: 16px">
          <NButton type="error" secondary @click="startUnbindFlow">
            {{ t('routes.settingsUnbindThisComputer') }}
          </NButton>
          <p class="hint sm">{{ t('routes.settingsUnbindHint') }}</p>
        </div>
      </NCard>

      <NCard title="Office profile" class="office-settings-card">
        <NForm label-placement="top" style="max-width: 480px">
          <NFormItem label="Boss name" :show-feedback="false">
            <NInput
              v-model:value="bossDisplayName"
              maxlength="80"
              placeholder="e.g. Alex · shown on org chart as Boss"
            />
          </NFormItem>
          <NFormItem label="Desktop name" :show-feedback="false">
            <NInput
              v-model:value="desktopDisplayName"
              maxlength="80"
              :placeholder="hostname ? `Default: ${hostname}` : 'e.g. HQ MacBook · this computer'"
            />
          </NFormItem>
          <NFormItem :show-label="false" class="office-settings-actions">
            <NButton type="primary" :loading="saving" @click="onSave">Save</NButton>
          </NFormItem>
        </NForm>
        <p class="hint sm">
          Boss name appears on Hierarchy and in chat. Desktop name is shown on the portal and synced to ECS when logged in.
        </p>
      </NCard>

      <NCard :title="t('pages.settings.appearanceSettings')" class="office-settings-card">
        <NForm label-placement="top" style="max-width: 480px">
          <NFormItem :label="t('pages.settings.themeMode')" :show-feedback="false">
            <NSelect
              :value="themeStore.mode"
              :options="themeOptions"
              @update:value="handleThemeChange"
            />
          </NFormItem>
        </NForm>
      </NCard>
        </NTabPane>

        <NTabPane name="summon" :tab="t('pages.settings.voiceAssistant.tabs.summon')">
          <SummonSettingsTab card-class="office-settings-card" />
        </NTabPane>

        <NTabPane name="voice" :tab="t('pages.settings.voiceAssistant.tabs.voice')">
          <VoiceSettingsTab card-class="office-settings-card" />
        </NTabPane>

        <NTabPane name="persona" :tab="t('pages.settings.voiceAssistant.tabs.persona')">
          <PersonaSettingsTab card-class="office-settings-card" />
        </NTabPane>

        <NTabPane name="standup" :tab="t('pages.settings.voiceAssistant.tabs.standup')">
          <DailyStandupSettingsTab card-class="office-settings-card" />
        </NTabPane>

        <NTabPane name="devtools" tab="Dev tools">
          <DevToolsSettingsTab card-class="office-settings-card" />
        </NTabPane>
      </NTabs>
    </NSpin>
  </div>
</template>

<style scoped>
.office-settings-page {
  padding-bottom: 24px;
}
.view-title {
  margin: 0 0 8px;
  font-size: 24px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.autosave-badge {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.02em;
  background: rgba(70, 209, 96, 0.15);
  color: #46d160;
}
.view-head {
  margin-bottom: 0;
}
.office-settings-card {
  margin-top: 16px;
}
.office-settings-actions {
  margin-top: 20px;
}
.office-settings-actions :deep(.n-form-item-blank) {
  min-height: 0;
}
.hint.sm {
  margin: 16px 0 0;
  font-size: 12px;
}
</style>
