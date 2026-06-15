<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAntlerApi } from '@/composables/useAntlerApi'
import OfficeSharePanel from '@/components/antler/OfficeSharePanel.vue'
import OfficePresenceBar from '@/components/antler/OfficePresenceBar.vue'

const api = useAntlerApi()
const connState = ref('Connecting…')
const officeUrl = '/office-pa/index.html'

onMounted(() => {
  api
    .get('/api/office/snapshot')
    .then(() => {
      connState.value = 'Connected'
    })
    .catch(() => {
      connState.value = 'Disconnected'
    })
})
</script>

<template>
  <div class="antler-v1-root pixel-office-page">
    <section class="office office-full">
      <div class="office-frame">
        <iframe id="officeFrame" :src="officeUrl" title="AntlerOffice pixel office" />
      </div>
      <div class="legend">
        <OfficePresenceBar />
        <span><i class="dot busy" /> Typing = working</span>
        <span><i class="dot idle" /> Seated = idle</span>
        <span class="hint-sm">Click an NPC · drag to move · scroll to zoom</span>
        <span class="conn" :class="{ ok: connState === 'Connected' }">{{ connState }}</span>
        <OfficeSharePanel />
      </div>
    </section>
  </div>
</template>

<style scoped>
.pixel-office-page {
  height: 100%;
  min-height: 0;
}

.office-full {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.office-frame {
  flex: 1;
  min-height: 0;
  display: flex;
}

#officeFrame {
  width: 100%;
  height: 100%;
  min-height: 480px;
  border: 0;
  border-radius: 8px;
  display: block;
}

.conn.ok {
  color: var(--accent-2);
}
</style>
