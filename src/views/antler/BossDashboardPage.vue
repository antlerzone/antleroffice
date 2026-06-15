<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NCard, NStatistic, NGrid, NGi, NSpin } from 'naive-ui'
import { useBossStore } from '@/stores/boss'
import { useAntlerApi } from '@/composables/useAntlerApi'

const boss = useBossStore()
const api = useAntlerApi()
const loading = ref(true)
const agentCount = ref(0)
const openclawOk = ref(false)

onMounted(async () => {
  await boss.refreshSession()
  try {
    const [agents, oc] = await Promise.all([
      api.get<{ agents: unknown[] }>('/api/config/agents'),
      api.get<{ available?: boolean }>('/api/openclaw/status'),
    ])
    agentCount.value = agents.agents?.length ?? 0
    openclawOk.value = !!oc.available
  } catch {
    /* demo mode */
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <NSpin :show="loading">
    <h2 style="margin-top: 0">Home</h2>
    <p class="hint">Your subscription and team at a glance.</p>
    <NGrid cols="1 s:2 m:3" :x-gap="16" :y-gap="16">
      <NGi>
        <NCard>
          <NStatistic label="Plan" :value="boss.session?.plan || '—'" />
        </NCard>
      </NGi>
      <NGi>
        <NCard>
          <NStatistic label="Credits" :value="boss.session?.creditBalance ?? 0" />
        </NCard>
      </NGi>
      <NGi>
        <NCard>
          <NStatistic label="Your agents" :value="agentCount" />
        </NCard>
      </NGi>
      <NGi>
        <NCard>
          <NStatistic
            label="OpenClaw"
            :value="openclawOk ? 'Ready' : 'Demo / setup'"
          />
        </NCard>
      </NGi>
    </NGrid>
  </NSpin>
</template>

<style scoped>
.hint {
  opacity: 0.75;
  margin-bottom: 16px;
}
</style>
