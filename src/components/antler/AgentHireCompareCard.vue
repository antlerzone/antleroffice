<script setup lang="ts">
import { computed } from 'vue'
import { NCard, NStatistic, NGrid, NGi } from 'naive-ui'

const props = defineProps<{
  otPerTask: number
  monthlySalary: number
  otTasksThisMonth?: number
  workerName?: string
}>()

const breakEven = computed(() => {
  if (!props.otPerTask || !props.monthlySalary) return 0
  return Math.ceil(props.monthlySalary / props.otPerTask)
})

const otSpend = computed(() => (props.otTasksThisMonth ?? 0) * props.otPerTask)
</script>

<template>
  <NCard size="small" :title="workerName ? `Hire ${workerName}?` : 'OT vs Hire'">
    <NGrid cols="2 s:4" :x-gap="12" :y-gap="8">
      <NGi>
        <NStatistic label="OT / task" :value="otPerTask" />
      </NGi>
      <NGi>
        <NStatistic label="OT this month" :value="otSpend" />
      </NGi>
      <NGi>
        <NStatistic label="Hire / month" :value="monthlySalary" />
      </NGi>
      <NGi>
        <NStatistic label="Break-even tasks" :value="breakEven" />
      </NGi>
    </NGrid>
    <p class="hint">
      After {{ breakEven }} cross-worker tasks this month, hiring is cheaper than OT.
    </p>
  </NCard>
</template>

<style scoped>
.hint {
  margin: 12px 0 0;
  font-size: 12px;
  opacity: 0.75;
}
</style>
