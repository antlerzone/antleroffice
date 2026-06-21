<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  NCard,
  NSpace,
  NSwitch,
  NText,
  NButton,
  NDivider,
  NAlert,
  NSpin,
  NInputNumber,
  NList,
  NListItem,
  NTag,
} from 'naive-ui'
import TimePickerField from '@/components/settings/TimePickerField.vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import {
  useCooHeartbeatSettings,
  type CooHeartbeatDiscoveryItem,
} from '@/composables/useCooHeartbeatSettings'

withDefaults(defineProps<{ cardClass?: string }>(), { cardClass: '' })

const { t } = useI18n()
const message = useMessage()
const {
  config,
  loading,
  saving,
  running,
  load,
  save,
  runHeartbeat,
  fetchDiscovery,
  parseCronHourMinute,
  buildDailyCron,
} = useCooHeartbeatSettings()

const discoveryItems = ref<CooHeartbeatDiscoveryItem[]>([])
const discoveryLoading = ref(false)

onMounted(() => {
  Promise.all([load(), refreshDiscovery()]).catch((e) =>
    message.error(e instanceof Error ? e.message : 'Load failed'),
  )
})

const scheduleParts = computed(() =>
  parseCronHourMinute(config.value?.schedule?.cron || '0 */4 * * *'),
)

async function refreshDiscovery() {
  discoveryLoading.value = true
  try {
    const res = await fetchDiscovery()
    discoveryItems.value = res.items || []
  } catch {
    discoveryItems.value = []
  } finally {
    discoveryLoading.value = false
  }
}

function onTimePickerChange({ hour, minute }: { hour: number; minute: number }) {
  void save({ schedule: { ...config.value!.schedule, cron: buildDailyCron(hour, minute) } })
}

async function onRunNow() {
  try {
    const res = await runHeartbeat()
    if (res.ok) {
      message.success(t('pages.settings.voiceAssistant.cooHeartbeat.runSuccess'))
      await refreshDiscovery()
    } else {
      message.error(res.error || t('pages.settings.voiceAssistant.cooHeartbeat.runFailed'))
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.settings.voiceAssistant.cooHeartbeat.runFailed'))
  }
}

function itemTag(item: CooHeartbeatDiscoveryItem) {
  if (item.needsCeo) return { type: 'warning' as const, label: 'CEO' }
  if (item.autoRunnable) return { type: 'success' as const, label: 'AUTO' }
  return { type: 'default' as const, label: 'WATCH' }
}
</script>

<template>
  <NSpin :show="loading">
    <NCard :title="t('pages.settings.voiceAssistant.cooHeartbeat.title')" :class="cardClass">
      <NSpace vertical size="large">
        <NAlert type="info" :bordered="false">
          {{ t('pages.settings.voiceAssistant.cooHeartbeat.hint') }}
          {{ t('pages.settings.voiceAssistant.cooHeartbeat.schedulerNote') }}
        </NAlert>

        <div>
          <NSwitch
            :value="config?.enabled"
            :loading="saving"
            @update:value="(v) => save({ enabled: v })"
          />
          <NText style="margin-left: 8px">{{ t('pages.settings.voiceAssistant.cooHeartbeat.enabled') }}</NText>
        </div>

        <div>
          <NText strong>{{ t('pages.settings.voiceAssistant.cooHeartbeat.schedule') }}</NText>
          <div style="margin-top: 8px">
            <TimePickerField
              :hour="scheduleParts.hour"
              :minute="scheduleParts.minute"
              :disabled="!config?.enabled || saving"
              @change="onTimePickerChange"
            />
          </div>
          <NText depth="3" style="display: block; margin-top: 6px">
            {{ t('pages.settings.voiceAssistant.cooHeartbeat.scheduleHint') }}
          </NText>
        </div>

        <NDivider />

        <div>
          <NSwitch
            :value="config?.autonomousLoop"
            :loading="saving"
            @update:value="(v) => save({ autonomousLoop: v })"
          />
          <NText style="margin-left: 8px">{{ t('pages.settings.voiceAssistant.cooHeartbeat.autonomousLoop') }}</NText>
          <NText depth="3" style="display: block; margin-top: 6px">
            {{ t('pages.settings.voiceAssistant.cooHeartbeat.autonomousHint') }}
          </NText>
        </div>

        <NAlert type="info" :bordered="false">
          {{ t('pages.settings.voiceAssistant.cooHeartbeat.futurePlanNote') }}
        </NAlert>

        <NAlert type="default" :bordered="false">
          {{ t('pages.settings.voiceAssistant.cooHeartbeat.parallelDecisionsNote') }}
        </NAlert>

        <div>
          <NText strong>{{ t('pages.settings.voiceAssistant.cooHeartbeat.loopIntervalMinutes') }}</NText>
          <NInputNumber
            :value="config?.loopIntervalMinutes ?? 2"
            :min="1"
            :max="30"
            :disabled="saving || !config?.enabled"
            style="width: 120px; margin-left: 12px"
            @update:value="(v) => v != null && save({ loopIntervalMinutes: v })"
          />
        </div>

        <div>
          <NText strong>{{ t('pages.settings.voiceAssistant.cooHeartbeat.staleJobHours') }}</NText>
          <NInputNumber
            :value="config?.staleJobHours ?? 24"
            :min="1"
            :max="168"
            :disabled="saving"
            style="width: 120px; margin-left: 12px"
            @update:value="(v) => v != null && save({ staleJobHours: v })"
          />
        </div>

        <NDivider />

        <NSpace align="center">
          <NButton type="primary" :loading="running" @click="onRunNow">
            {{ t('pages.settings.voiceAssistant.cooHeartbeat.runNow') }}
          </NButton>
          <NButton :loading="discoveryLoading" @click="refreshDiscovery">
            {{ t('pages.settings.voiceAssistant.cooHeartbeat.refreshDiscovery') }}
          </NButton>
        </NSpace>

        <div v-if="discoveryItems.length">
          <NText strong>{{ t('pages.settings.voiceAssistant.cooHeartbeat.discoveryTitle') }}</NText>
          <NList bordered style="margin-top: 8px">
            <NListItem v-for="(item, idx) in discoveryItems" :key="`${item.kind}-${idx}`">
              <NSpace align="center" :size="8">
                <NTag :type="itemTag(item).type" size="small">{{ itemTag(item).label }}</NTag>
                <NText>{{ item.summary }}</NText>
              </NSpace>
            </NListItem>
          </NList>
        </div>
        <NText v-else depth="3">{{ t('pages.settings.voiceAssistant.cooHeartbeat.discoveryEmpty') }}</NText>
      </NSpace>
    </NCard>
  </NSpin>
</template>
