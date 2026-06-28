<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { NCard, NForm, NFormItem, NInput, NButton, NSpin, NSelect, NTag, NSpace, NTabs, NTabPane, NSwitch, useMessage, useThemeVars } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useOfficeProfile } from '@/composables/useOfficeProfile'
import { useLocalGateway } from '@/composables/useLocalGateway'
import { useThemeStore, type ThemeMode } from '@/stores/theme'
import { useBossStore } from '@/stores/boss'
import Voice2SettingsTab from '@/components/settings/Voice2SettingsTab.vue'
import CompanyFrameworkSettingsCard from '@/components/settings/CompanyFrameworkSettingsCard.vue'
import DevToolsSettingsTab from '@/components/settings/DevToolsSettingsTab.vue'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import { buildDesktopUnbindSignInUrl } from '@/lib/office-web'
import { openExternalUrl } from '@/lib/desktop-shell'

const PENDING_UNBIND_KEY = 'antleroffice-pending-unbind'

const { t } = useI18n()
const message = useMessage()
const themeVars = useThemeVars()
const router = useRouter()
const themeStore = useThemeStore()
const boss = useBossStore()
const { bossDisplayName, desktopDisplayName, cooModel, workerModel, hostname, load, save } = useOfficeProfile()
const localGateway = useLocalGateway()
const { ensureLoaded } = useVoiceAssistantSettings()
const settingsTab = ref('general')
const loading = ref(true)
const saving = ref(false)
const reconnecting = ref(false)
const localBindStatus = ref<'unbound' | 'owned_by_me' | 'owned_by_other'>('unbound')
const modelOptions = ref<{ label: string; value: string }[]>([])

async function loadModelOptions() {
  try {
    const headers: Record<string, string> = boss.token ? { 'X-Boss-Token': boss.token } : {}
    const res = await fetch('/api/openclaw/models?all=1', { headers })
    const data = await res.json()
    modelOptions.value = (data.models || [])
      .map((m: { key?: string; name?: string; ref?: string }) => {
        const val = m.key || m.ref || ''
        return val ? { label: m.name || val, value: val } : null
      })
      .filter(Boolean)
  } catch {
    modelOptions.value = []
  }
}

// Role-gated tabs: fetch hired agents to show/hide role-specific settings
interface HiredAgent { id: string; name: string; role: string }
const hiredAgents = ref<HiredAgent[]>([])
const hasITAgent = computed(() =>
  hiredAgents.value.some((a) => a.role === 'it' || a.role === 'it_junior' || a.role?.startsWith('it')),
)

const gatewayStatus = computed(() => {
  const g = 'pages.settings.voiceAssistant.general'
  if (localGateway.checking.value) return { label: t(`${g}.gatewayConnecting`), type: 'info' as const }
  if (localGateway.live.value) return { label: t(`${g}.gatewayConnected`), type: 'success' as const }
  return { label: t(`${g}.gatewayDisconnected`), type: 'error' as const }
})

const themeOptions = computed(() => [
  { label: t('pages.settings.themeLight'), value: 'light' },
  { label: t('pages.settings.themeDark'), value: 'dark' },
])

// Browser Agent settings
const browserAgentHeadless = ref(false)
const savingBrowserAgent = ref(false)

async function loadBrowserAgentSettings() {
  try {
    const headers: Record<string, string> = boss.token ? { 'X-Boss-Token': boss.token } : {}
    const res = await fetch('/api/browser-agent/settings', { headers })
    if (res.ok) {
      const data = await res.json()
      browserAgentHeadless.value = !!data.headless
    }
  } catch { /* ignore */ }
}

async function saveBrowserAgentHeadless(val: boolean) {
  savingBrowserAgent.value = true
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(boss.token ? { 'X-Boss-Token': boss.token } : {}),
    }
    await fetch('/api/browser-agent/settings', {
      method: 'POST',
      headers,
      body: JSON.stringify({ headless: val }),
    })
    browserAgentHeadless.value = val
    message.success(val
      ? t('pages.settings.voiceAssistant.general.browserAgentHeadless')
      : t('pages.settings.voiceAssistant.general.browserAgentVisible')
    )
  } catch {
    message.error('保存失败')
  } finally {
    savingBrowserAgent.value = false
  }
}

const autosaveTabs = new Set(['voiceAssistant'])
const showAutosaveBadge = computed(() => autosaveTabs.has(settingsTab.value))

onMounted(async () => {
  loading.value = true
  ensureLoaded()
  localGateway.startBackground()
  try {
    await load()
    await loadLocalBindStatus()
    await loadHiredAgents()
    loadModelOptions()
    loadBrowserAgentSettings()
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Could not load settings')
  } finally {
    loading.value = false
  }
})

async function loadHiredAgents() {
  try {
    const headers: Record<string, string> = boss.token ? { 'X-Boss-Token': boss.token } : {}
    const res = await fetch('/api/config/agents', { headers })
    const data = await res.json()
    if (res.ok && Array.isArray(data.agents)) {
      hiredAgents.value = data.agents.filter((a: HiredAgent) => a.role !== 'secretary' && a.role !== 'coo')
    }
  } catch {
    // silently ignore — just won't show role-gated tabs
  }
}

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
      cooModel: cooModel.value,
      workerModel: workerModel.value,
    })
    message.success(t('pages.settings.voiceAssistant.general.saveSuccess'))
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
      <NTabs
        v-model:value="settingsTab"
        type="line"
        animated
        class="settings-tabs"
        :style="{ '--tabs-sticky-bg': themeVars.bodyColor }"
      >
        <NTabPane name="general" :tab="t('pages.settings.voiceAssistant.tabs.general')">
          <NCard :title="t('pages.settings.voiceAssistant.general.openclawTitle')" class="office-settings-card">
        <NSpace align="center" style="margin-bottom: 12px">
          <NTag :type="gatewayStatus.type">{{ gatewayStatus.label }}</NTag>
          <span v-if="localGateway.gatewayUrl" class="hint sm" style="margin: 0">{{ localGateway.gatewayUrl }}</span>
        </NSpace>
        <p class="hint sm">
          {{ t('pages.settings.voiceAssistant.general.gatewayHint') }}
        </p>
        <div v-show="!localGateway.live.value">
          <p class="hint sm" style="color: #e8a838; margin-top: 6px">
            {{ t('pages.settings.voiceAssistant.general.gatewayOfflineHint') }}
          </p>
          <NButton :loading="reconnecting" style="margin-top: 8px" @click="reconnectOpenClaw">
            {{ t('pages.settings.voiceAssistant.general.reconnect') }}
          </NButton>
        </div>
        <div v-if="localBindStatus === 'owned_by_me'" style="margin-top: 16px">
          <NButton type="error" secondary @click="startUnbindFlow">
            {{ t('pages.settings.voiceAssistant.general.unbind') }}
          </NButton>
          <p class="hint sm">{{ t('pages.settings.voiceAssistant.general.unbindHint') }}</p>
        </div>
      </NCard>

      <NCard :title="t('pages.settings.voiceAssistant.general.officeProfileTitle')" class="office-settings-card">
        <NForm label-placement="top" style="max-width: 480px">
          <NFormItem :label="t('pages.settings.voiceAssistant.general.ceoName')" :show-feedback="false">
            <NInput
              v-model:value="bossDisplayName"
              maxlength="80"
              :placeholder="t('pages.settings.voiceAssistant.general.ceoNamePlaceholder')"
            />
          </NFormItem>
          <NFormItem :label="t('pages.settings.voiceAssistant.general.desktopName')" :show-feedback="false">
            <NInput
              v-model:value="desktopDisplayName"
              maxlength="80"
              :placeholder="hostname ? `Default: ${hostname}` : t('pages.settings.voiceAssistant.general.desktopName')"
            />
          </NFormItem>
          <NFormItem :label="t('pages.settings.voiceAssistant.general.cooModel')" :show-feedback="false">
            <NSelect
              v-model:value="cooModel"
              filterable
              tag
              :options="modelOptions"
              :placeholder="t('pages.settings.voiceAssistant.general.cooModelPlaceholder')"
              style="width: 100%"
            />
          </NFormItem>
          <NFormItem :label="t('pages.settings.voiceAssistant.general.workerModel')" :show-feedback="false">
            <NSelect
              v-model:value="workerModel"
              filterable
              tag
              :options="modelOptions"
              :placeholder="t('pages.settings.voiceAssistant.general.workerModelPlaceholder')"
              style="width: 100%"
            />
          </NFormItem>
          <NFormItem :show-label="false" class="office-settings-actions">
            <NButton type="primary" :loading="saving" @click="onSave">{{ t('pages.settings.voiceAssistant.general.save') }}</NButton>
          </NFormItem>
        </NForm>
        <p class="hint sm">
          {{ t('pages.settings.voiceAssistant.general.profileHint') }}
        </p>
      </NCard>

      <CompanyFrameworkSettingsCard card-class="office-settings-card" />

      <!-- Browser Agent mode -->
      <NCard :title="t('pages.settings.voiceAssistant.general.browserAgentTitle')" class="office-settings-card">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:16px;">
          <div>
            <p style="margin:0 0 4px; font-size:14px; font-weight:500;">
              {{ browserAgentHeadless
                ? t('pages.settings.voiceAssistant.general.browserAgentHeadless')
                : t('pages.settings.voiceAssistant.general.browserAgentVisible') }}
            </p>
            <p style="margin:0; font-size:12px; color:var(--n-text-color-3);">
              {{ browserAgentHeadless
                ? t('pages.settings.voiceAssistant.general.browserAgentHeadlessDesc')
                : t('pages.settings.voiceAssistant.general.browserAgentVisibleDesc') }}
            </p>
          </div>
          <NSwitch
            :value="browserAgentHeadless"
            :loading="savingBrowserAgent"
            @update:value="saveBrowserAgentHeadless"
          >
            <template #checked>{{ t('pages.settings.voiceAssistant.general.browserAgentBack') }}</template>
            <template #unchecked>{{ t('pages.settings.voiceAssistant.general.browserAgentShow') }}</template>
          </NSwitch>
        </div>
      </NCard>

      <!-- SaaS Admin shortcut -->
      <NCard :title="t('pages.settings.voiceAssistant.general.saasTitle')" class="office-settings-card">
        <div style="display:flex; align-items:center; justify-content:space-between;">
          <div>
            <p style="margin:0; font-size:13px;">{{ t('pages.settings.voiceAssistant.general.saasDesc') }}</p>
          </div>
          <NButton @click="router.push({ name: 'SkillInstalls' })">{{ t('pages.settings.voiceAssistant.general.saasLink') }}</NButton>
        </div>
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

        <NTabPane name="voiceAssistant" :tab="t('pages.settings.voiceAssistant.tabs.voiceAssistant')">
          <Voice2SettingsTab card-class="office-settings-card" />
        </NTabPane>

        <NTabPane v-if="hasITAgent" name="devtools" :tab="t('pages.settings.voiceAssistant.tabs.devtools')">
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
/* Pin the General / Voice assistant tab bar to the top while scrolling.
   Background follows the theme (light/dark) so the tab text stays readable. */
.settings-tabs :deep(.n-tabs-nav) {
  position: sticky;
  top: 0;
  z-index: 20;
  background: var(--tabs-sticky-bg, #fff);
}
</style>
