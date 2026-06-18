<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NCard, NForm, NFormItem, NInput, NButton, NSpin, NSelect, NTag, NSpace, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useOfficeProfile } from '@/composables/useOfficeProfile'
import { useLocalGateway } from '@/composables/useLocalGateway'
import { useThemeStore, type ThemeMode } from '@/stores/theme'
import TtsSettingsCard from '@/components/settings/TtsSettingsCard.vue'

const { t } = useI18n()
const message = useMessage()
const themeStore = useThemeStore()
const { bossDisplayName, desktopDisplayName, hostname, load, save } = useOfficeProfile()
const localGateway = useLocalGateway()
const loading = ref(false)
const saving = ref(false)
const reconnecting = ref(false)

const gatewayStatus = computed(() => {
  if (localGateway.checking.value) return { label: 'Connecting…', type: 'info' as const }
  if (localGateway.live.value) return { label: 'Connected', type: 'success' as const }
  return { label: 'Disconnected', type: 'error' as const }
})

const themeOptions = computed(() => [
  { label: t('pages.settings.themeLight'), value: 'light' },
  { label: t('pages.settings.themeDark'), value: 'dark' },
])

onMounted(async () => {
  loading.value = true
  localGateway.startBackground()
  try {
    await load()
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Could not load settings')
  } finally {
    loading.value = false
  }
})

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
    <h2 class="view-title">{{ t('routes.settings') }}</h2>
    <p class="hint">
      Your office identity and appearance. Boss login uses your ECS account — no separate username/password here.
    </p>

    <NSpin :show="loading">
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

      <TtsSettingsCard card-class="office-settings-card" />
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
