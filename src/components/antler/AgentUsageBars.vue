<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NProgress } from 'naive-ui'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { formatPeriod } from '@/lib/period-sg'

const props = defineProps<{
  agentId: string
}>()

const api = useAntlerApi()
const usage = ref({ homeTasks: 0, otTasks: 0, tokens: 0 })

const homePct = computed(() => {
  const total = usage.value.homeTasks + usage.value.otTasks
  if (!total) return 0
  return Math.round((usage.value.homeTasks / total) * 100)
})

const otPct = computed(() => {
  const total = usage.value.homeTasks + usage.value.otTasks
  if (!total) return 0
  return Math.round((usage.value.otTasks / total) * 100)
})

async function load() {
  if (!props.agentId) return
  try {
    const res = await api.get<{
      usage: { homeTasks: number; otTasks: number; tokens: number }
    }>(`/api/usage/agent?agentId=${encodeURIComponent(props.agentId)}&period=${formatPeriod()}`)
    usage.value = res.usage
  } catch {
    usage.value = { homeTasks: 0, otTasks: 0, tokens: 0 }
  }
}

watch(() => props.agentId, load)
onMounted(load)
</script>

<template>
  <div class="usage-bars">
    <div class="bar-row">
      <span class="label">{{ $t('payslip.usage.home') }}</span>
      <NProgress type="line" :percentage="homePct" :show-indicator="false" status="success" />
      <span class="count">{{ usage.homeTasks }}</span>
    </div>
    <div class="bar-row">
      <span class="label">{{ $t('payslip.usage.ot') }}</span>
      <NProgress type="line" :percentage="otPct" :show-indicator="false" status="warning" />
      <span class="count">{{ usage.otTasks }}</span>
    </div>
  </div>
</template>

<style scoped>
.usage-bars {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.bar-row {
  display: grid;
  grid-template-columns: 5.5rem 1fr 2rem;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.label {
  opacity: 0.8;
}
.count {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
