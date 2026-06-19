<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NPopover, NIcon, NButton, NText } from 'naive-ui'
import { TimeOutline, ChevronUpOutline, ChevronDownOutline } from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'

const props = withDefaults(
  defineProps<{
    hour: number
    minute: number
    disabled?: boolean
    label?: string
  }>(),
  { disabled: false, label: '' },
)

const emit = defineEmits<{
  'update:hour': [hour: number]
  'update:minute': [minute: number]
  change: [payload: { hour: number; minute: number }]
}>()

const { t } = useI18n()
const show = ref(false)
const focusField = ref<'hour' | 'minute'>('hour')

const displayValue = computed(() => {
  const h = String(clampHour(props.hour)).padStart(2, '0')
  const m = String(clampMinute(props.minute)).padStart(2, '0')
  return `${h}:${m}`
})

function clampHour(v: number) {
  return Math.min(23, Math.max(0, Math.floor(Number(v) || 0)))
}

function clampMinute(v: number) {
  return Math.min(59, Math.max(0, Math.floor(Number(v) || 0)))
}

function emitTime(hour: number, minute: number) {
  const h = clampHour(hour)
  const m = clampMinute(minute)
  emit('update:hour', h)
  emit('update:minute', m)
  emit('change', { hour: h, minute: m })
}

function stepHour(delta: number) {
  emitTime((clampHour(props.hour) + delta + 24) % 24, props.minute)
}

function stepMinute(delta: number) {
  let h = clampHour(props.hour)
  let m = clampMinute(props.minute) + delta
  if (m > 59) {
    m = 0
    h = (h + 1) % 24
  } else if (m < 0) {
    m = 59
    h = (h + 23) % 24
  }
  emitTime(h, m)
}

function setNow() {
  const now = new Date()
  emitTime(now.getHours(), now.getMinutes())
}

function clearTime() {
  emitTime(8, 0)
  show.value = false
}

watch(show, (open) => {
  if (open) focusField.value = 'hour'
})
</script>

<template>
  <div class="time-picker-field">
    <NText v-if="label" depth="3" class="time-picker-label">{{ label }}</NText>
    <NPopover
      v-model:show="show"
      trigger="click"
      placement="bottom-start"
      :disabled="disabled"
      raw
      :show-arrow="false"
    >
      <template #trigger>
        <button type="button" class="time-picker-trigger" :disabled="disabled">
          <span class="time-picker-trigger-value">{{ displayValue }}</span>
          <NIcon :component="TimeOutline" class="time-picker-trigger-icon" />
        </button>
      </template>

      <div class="time-picker-panel">
        <div class="time-picker-panel-title">{{ t('timePicker.enterTime') }}</div>

        <div class="time-picker-spin-row">
          <div
            class="time-picker-spin-box"
            :class="{ 'time-picker-spin-box--focus': focusField === 'hour' }"
            @click="focusField = 'hour'"
          >
            <button type="button" class="time-picker-spin-btn" @click.stop="stepHour(1)">
              <NIcon :component="ChevronUpOutline" />
            </button>
            <span class="time-picker-spin-value">{{ String(clampHour(hour)).padStart(2, '0') }}</span>
            <button type="button" class="time-picker-spin-btn" @click.stop="stepHour(-1)">
              <NIcon :component="ChevronDownOutline" />
            </button>
          </div>

          <span class="time-picker-colon">:</span>

          <div
            class="time-picker-spin-box"
            :class="{ 'time-picker-spin-box--focus': focusField === 'minute' }"
            @click="focusField = 'minute'"
          >
            <button type="button" class="time-picker-spin-btn" @click.stop="stepMinute(1)">
              <NIcon :component="ChevronUpOutline" />
            </button>
            <span class="time-picker-spin-value">{{ String(clampMinute(minute)).padStart(2, '0') }}</span>
            <button type="button" class="time-picker-spin-btn" @click.stop="stepMinute(-1)">
              <NIcon :component="ChevronDownOutline" />
            </button>
          </div>
        </div>

        <div class="time-picker-panel-footer">
          <NButton text type="primary" @click="setNow">{{ t('timePicker.now') }}</NButton>
          <NButton text type="primary" @click="clearTime">{{ t('timePicker.clear') }}</NButton>
        </div>
      </div>
    </NPopover>
  </div>
</template>

<style scoped>
.time-picker-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.time-picker-label {
  font-size: 13px;
}
.time-picker-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 200px;
  height: 40px;
  padding: 0 12px;
  border: 1px solid var(--line, rgba(255, 255, 255, 0.18));
  border-radius: 8px;
  background: var(--bg-card, rgba(0, 0, 0, 0.2));
  color: inherit;
  cursor: pointer;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}
.time-picker-trigger:hover:not(:disabled) {
  border-color: rgba(32, 128, 240, 0.55);
}
.time-picker-trigger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.time-picker-trigger-icon {
  font-size: 18px;
  opacity: 0.65;
}
.time-picker-panel {
  width: 280px;
  padding: 16px 16px 12px;
  border-radius: 12px;
  background: #fff;
  color: #1a1a1a;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
}
.time-picker-panel-title {
  font-size: 13px;
  color: #666;
  margin-bottom: 12px;
}
.time-picker-spin-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.time-picker-spin-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 88px;
  padding: 6px 8px 8px;
  border: 1px solid #e0e0e6;
  border-radius: 8px;
  background: #fafafc;
  transition: border-color 0.15s, background 0.15s;
}
.time-picker-spin-box--focus {
  border-color: #2080f0;
  background: #f0f7ff;
}
.time-picker-spin-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 22px;
  border: none;
  background: transparent;
  color: #666;
  cursor: pointer;
  padding: 0;
}
.time-picker-spin-btn:hover {
  color: #2080f0;
}
.time-picker-spin-value {
  font-size: 28px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  padding: 4px 0;
}
.time-picker-colon {
  font-size: 28px;
  font-weight: 600;
  color: #333;
  padding-bottom: 4px;
}
.time-picker-panel-footer {
  display: flex;
  justify-content: space-between;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid #eee;
}
</style>
