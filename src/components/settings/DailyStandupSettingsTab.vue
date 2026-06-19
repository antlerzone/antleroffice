<script setup lang="ts">
import { computed, onMounted } from 'vue'
import {
  NCard,
  NSpace,
  NSwitch,
  NText,
  NSelect,
  NButton,
  NDivider,
  NCheckbox,
  NAlert,
  NSpin,
} from 'naive-ui'
import TimePickerField from '@/components/settings/TimePickerField.vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import {
  useDailyStandupSettings,
  type StandupParticipant,
  type StandupPeriod,
} from '@/composables/useDailyStandupSettings'
import { useVoiceSettings } from '@/composables/useVoiceSettings'
import StandupParticipantVoiceRow from '@/components/settings/StandupParticipantVoiceRow.vue'

withDefaults(defineProps<{ cardClass?: string }>(), { cardClass: '' })

const { t } = useI18n()
const message = useMessage()
const {
  config,
  candidates,
  loading,
  saving,
  running,
  load,
  save,
  runStandup,
  parseCronHourMinute,
  buildCron,
} = useDailyStandupSettings()
const { profiles, refreshProfiles } = useVoiceSettings()

onMounted(() => {
  Promise.all([load(), refreshProfiles()]).catch((e) =>
    message.error(e instanceof Error ? e.message : 'Load failed'),
  )
})

const periodOptions = computed(() => [
  { label: t('pages.settings.voiceAssistant.standup.periodYesterday'), value: 'yesterday' },
  { label: t('pages.settings.voiceAssistant.standup.periodLastWeek'), value: 'last_week' },
  { label: t('pages.settings.voiceAssistant.standup.periodLast7Days'), value: 'last_7_days' },
])

const scheduleParts = computed(() =>
  parseCronHourMinute(config.value?.schedule?.cron || '0 8 * * *'),
)

function onTimePickerChange({ hour, minute }: { hour: number; minute: number }) {
  void onScheduleChange(hour, minute)
}

const enabledCount = computed(
  () => config.value?.participants.filter((p) => p.enabled).length || 0,
)

const sortedParticipants = computed(() => {
  const list = [...(config.value?.participants || [])]
  return list.sort((a, b) => a.order - b.order)
})

async function patchParticipants(next: StandupParticipant[]) {
  const ordered = next.map((p, i) => ({ ...p, order: i }))
  await save({ participants: ordered })
}

function moveParticipant(agentId: string, delta: number) {
  const list = sortedParticipants.value.map((p) => ({ ...p }))
  const index = list.findIndex((p) => p.agentId === agentId)
  if (index < 0) return
  const target = index + delta
  if (target < 0 || target >= list.length) return
  const tmp = list[index]
  list[index] = list[target]
  list[target] = tmp
  void patchParticipants(list)
}

function toggleParticipant(agentId: string, enabled: boolean) {
  const list = sortedParticipants.value.map((p) =>
    p.agentId === agentId ? { ...p, enabled } : p,
  )
  void patchParticipants(list)
}

function updateParticipantVoice(agentId: string, patch: Partial<StandupParticipant['voice']>) {
  const list = sortedParticipants.value.map((p) =>
    p.agentId === agentId ? { ...p, voice: { ...p.voice, ...patch } } : p,
  )
  void patchParticipants(list)
}

async function onScheduleChange(hour: number, minute: number) {
  await save({ schedule: { ...config.value!.schedule, cron: buildCron(hour, minute) } })
}

async function onRunNow() {
  try {
    const res = await runStandup()
    if (res.ok && res.deliverable) {
      message.success(t('pages.settings.voiceAssistant.standup.runSuccess'))
    } else {
      message.error(res.error || t('pages.settings.voiceAssistant.standup.runFailed'))
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.settings.voiceAssistant.standup.runFailed'))
  }
}
</script>

<template>
  <NSpin :show="loading">
    <NCard :title="t('pages.settings.voiceAssistant.standup.title')" :class="cardClass">
      <NSpace vertical :size="16">
        <NAlert type="info" :show-icon="false">
          {{ t('pages.settings.voiceAssistant.standup.hint') }}
          {{ t('pages.settings.voiceAssistant.standup.schedulerNote') }}
        </NAlert>

        <div>
          <NSwitch
            :value="config?.enabled"
            :loading="saving"
            @update:value="(v) => save({ enabled: v })"
          />
          <NText style="margin-left: 8px">{{ t('pages.settings.voiceAssistant.standup.enabled') }}</NText>
        </div>

        <div v-if="config?.enabled" class="schedule-block">
          <NText strong>{{ t('pages.settings.voiceAssistant.standup.schedule') }}</NText>
          <NText depth="3" style="display: block; font-size: 13px; margin-top: 4px">
            {{ t('pages.settings.voiceAssistant.standup.scheduleHint') }}
          </NText>
          <div style="margin-top: 12px">
            <TimePickerField
              :hour="scheduleParts.hour"
              :minute="scheduleParts.minute"
              :disabled="saving"
              :label="t('pages.settings.voiceAssistant.standup.scheduleTimeLabel')"
              @change="onTimePickerChange"
            />
          </div>
          <NText depth="3" style="display: block; font-size: 12px; margin-top: 8px">
            {{ t('pages.settings.voiceAssistant.standup.scheduleDaily') }}
          </NText>
        </div>

        <div>
          <NText strong>{{ t('pages.settings.voiceAssistant.standup.defaultPeriod') }}</NText>
          <NSelect
            :value="config?.defaultPeriod || 'yesterday'"
            :options="periodOptions"
            :disabled="saving"
            style="margin-top: 8px; max-width: 280px"
            @update:value="(v: StandupPeriod) => save({ defaultPeriod: v })"
          />
        </div>

        <NDivider style="margin: 8px 0" />

        <div>
          <NText strong>{{ t('pages.settings.voiceAssistant.standup.participants') }}</NText>
          <NText depth="3" style="display: block; font-size: 13px; margin-top: 4px">
            {{ t('pages.settings.voiceAssistant.standup.participantsHint', { count: enabledCount }) }}
            {{ t('pages.settings.voiceAssistant.standup.voiceHint') }}
          </NText>

          <NAlert
            v-if="!sortedParticipants.length"
            type="warning"
            style="margin-top: 12px"
          >
            {{ t('pages.settings.voiceAssistant.standup.noParticipants') }}
          </NAlert>

          <NSpace v-else vertical :size="10" style="margin-top: 12px">
            <div
              v-for="(p, index) in sortedParticipants"
              :key="p.agentId"
              class="participant-row"
            >
              <div class="participant-main">
                <NCheckbox
                  :checked="p.enabled"
                  @update:checked="(v) => toggleParticipant(p.agentId, v)"
                />
                <NText style="min-width: 140px">{{ p.label }}</NText>
                <NSpace :size="4">
                  <NButton size="tiny" :disabled="index === 0 || saving" @click="moveParticipant(p.agentId, -1)">
                    ↑
                  </NButton>
                  <NButton
                    size="tiny"
                    :disabled="index === sortedParticipants.length - 1 || saving"
                    @click="moveParticipant(p.agentId, 1)"
                  >
                    ↓
                  </NButton>
                </NSpace>
              </div>
              <StandupParticipantVoiceRow
                v-if="p.enabled"
                :participant="p"
                :profiles="profiles"
                :disabled="saving"
                @update="(patch) => updateParticipantVoice(p.agentId, patch)"
              />
            </div>
          </NSpace>

          <NAlert
            v-if="candidates.length > sortedParticipants.length"
            type="info"
            style="margin-top: 12px"
            :show-icon="false"
          >
            {{ t('pages.settings.voiceAssistant.standup.newAgentsHint') }}
          </NAlert>
        </div>

        <NDivider style="margin: 8px 0" />

        <NSpace align="center">
          <NButton
            type="primary"
            :loading="running"
            :disabled="!enabledCount || saving"
            @click="onRunNow"
          >
            {{ t('pages.settings.voiceAssistant.standup.runNow') }}
          </NButton>
          <NText depth="3">{{ t('pages.settings.voiceAssistant.standup.runNowHint') }}</NText>
        </NSpace>
      </NSpace>
    </NCard>
  </NSpin>
</template>

<style scoped>
.schedule-block {
  margin-top: 4px;
}
.participant-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--line, rgba(255, 255, 255, 0.12));
  border-radius: 8px;
}
.participant-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
