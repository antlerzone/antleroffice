<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { NCard, NSpace, NText, NInput, NAlert, NButton, NSpin } from 'naive-ui'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAntlerApi } from '@/composables/useAntlerApi'

withDefaults(defineProps<{ cardClass?: string }>(), { cardClass: '' })

type RetellStatus = {
  ok?: boolean
  configured?: boolean
  maskedKey?: string
  updatedAt?: string | null
  error?: string
}

const { t } = useI18n()
const api = useAntlerApi()
const message = useMessage()

const loading = ref(true)
const saving = ref(false)
const removing = ref(false)
const configured = ref(false)
const maskedKey = ref('')
const updatedAt = ref<string | null>(null)
const draftKey = ref('')

const statusType = computed(() => (configured.value ? 'success' : 'warning'))
const statusText = computed(() =>
  configured.value
    ? t('accounts.retell.statusConnected', { maskedKey: maskedKey.value })
    : t('accounts.retell.statusMissing'),
)
const keyPlaceholder = computed(() =>
  configured.value
    ? t('accounts.retell.keyPlaceholderSet')
    : t('accounts.retell.keyPlaceholderEmpty'),
)

function applyStatus(s: RetellStatus) {
  configured.value = !!s.configured
  maskedKey.value = s.maskedKey || ''
  updatedAt.value = s.updatedAt || null
}

async function load() {
  loading.value = true
  try {
    const s = await api.send<RetellStatus>('GET', '/api/config/retell')
    applyStatus(s)
  } catch {
    configured.value = false
    maskedKey.value = ''
  } finally {
    loading.value = false
  }
}

async function save() {
  const key = draftKey.value.trim()
  if (!key) {
    message.warning(t('accounts.retell.warnEmpty'))
    return
  }
  saving.value = true
  try {
    const s = await api.send<RetellStatus>('POST', '/api/config/retell', { apiKey: key })
    applyStatus(s)
    draftKey.value = ''
    message.success(t('accounts.retell.saved'))
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('accounts.retell.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function remove() {
  removing.value = true
  try {
    const s = await api.send<RetellStatus>('DELETE', '/api/config/retell')
    applyStatus(s)
    draftKey.value = ''
    message.success(t('accounts.retell.removed'))
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('accounts.retell.removeFailed'))
  } finally {
    removing.value = false
  }
}

onMounted(load)
</script>

<template>
  <NCard :title="t('accounts.retell.title')" :class="cardClass">
    <NSpin :show="loading">
      <NSpace vertical :size="14">
        <NText depth="3" style="font-size: 13px; line-height: 1.6">
          <i18n-t keypath="accounts.retell.intro" tag="span">
            <template #link>
              <a href="https://dashboard.retellai.com" target="_blank" rel="noopener">
                {{ t('accounts.retell.dashboardLink') }}
              </a>
            </template>
          </i18n-t>
        </NText>

        <NAlert :type="statusType" :show-icon="false">
          {{ statusText }}
        </NAlert>

        <div>
          <NText style="font-size: 13px; display: block; margin-bottom: 6px">
            {{ t('accounts.retell.keyLabel') }}
          </NText>
          <NInput
            v-model:value="draftKey"
            type="password"
            show-password-on="click"
            :placeholder="keyPlaceholder"
          />
        </div>

        <NSpace :size="10">
          <NButton type="primary" :loading="saving" @click="save">
            {{ t('accounts.retell.save') }}
          </NButton>
          <NButton v-if="configured" tertiary type="error" :loading="removing" @click="remove">
            {{ t('accounts.retell.remove') }}
          </NButton>
        </NSpace>
      </NSpace>
    </NSpin>
  </NCard>
</template>
