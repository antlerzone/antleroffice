<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useAntlerApi } from '@/composables/useAntlerApi'

interface Viewer {
  id: string
  name: string
  role: string
}

interface PresencePayload {
  viewers?: Viewer[]
  viewerCount?: number
  selection?: { agentId: string | null; by: string | null }
}

const api = useAntlerApi()
const viewers = ref<Viewer[]>([])
const selection = ref<{ agentId: string | null; by: string | null } | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

async function refresh() {
  try {
    const data = await api.get<PresencePayload>('/api/office/presence')
    viewers.value = data.viewers || []
    selection.value = data.selection || null
  } catch {
    viewers.value = []
  }
}

onMounted(() => {
  void refresh()
  timer = setInterval(() => void refresh(), 2000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div v-if="viewers.length" class="presence">
    <span class="label">{{ viewers.length }} viewing</span>
    <span v-for="v in viewers" :key="v.id" class="chip" :class="v.role">{{ v.name }}</span>
    <span v-if="selection?.agentId" class="sel">Selected by {{ selection.by }}</span>
  </div>
</template>

<style scoped>
.presence {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11px;
  color: #9aa0a6;
}
.label {
  font-weight: 600;
}
.chip {
  padding: 2px 8px;
  border-radius: 999px;
  background: #252932;
  border: 1px solid #333;
}
.chip.owner {
  border-color: #46d160;
  color: #c8f7d0;
}
.chip.member {
  border-color: #5b9bd5;
  color: #c5dff5;
}
.sel {
  opacity: 0.85;
}
</style>
