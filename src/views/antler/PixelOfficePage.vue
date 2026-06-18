<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NIcon } from 'naive-ui'
import { ChevronBackOutline } from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'
import { useLocalGateway } from '@/composables/useLocalGateway'
import OfficeSharePanel from '@/components/antler/OfficeSharePanel.vue'
import OfficePresenceBar from '@/components/antler/OfficePresenceBar.vue'

const router = useRouter()
const { t } = useI18n()
const localGateway = useLocalGateway()
const officeUrl = '/office-pa/index.html'

const connState = computed(() => {
  if (localGateway.checking.value) return 'Connecting…'
  return localGateway.live.value ? 'Connected' : 'Disconnected'
})

function goToPortal() {
  router.push({ name: 'Portal' })
}

onMounted(() => {
  localGateway.startBackground()
})
</script>

<template>
  <div class="antler-v1-root pixel-office-page">
    <section class="office office-full">
      <div class="office-frame">
        <iframe id="officeFrame" :src="officeUrl" title="AntlerOffice pixel office" />
      </div>
      <div class="legend">
        <NButton quaternary size="small" class="portal-back-btn" @click="goToPortal">
          <template #icon>
            <NIcon :component="ChevronBackOutline" />
          </template>
          {{ t('common.backToPortal') }}
        </NButton>
        <OfficePresenceBar />
        <span><i class="dot busy" /> Typing = working</span>
        <span><i class="dot idle" /> Seated = idle</span>
        <span class="hint-sm">Click an NPC · drag to move · scroll to zoom</span>
        <span class="conn" :class="{ ok: localGateway.live.value }">{{ connState }}</span>
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
  background: #0f1115;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.conn {
  padding: 2px 10px;
  border-radius: 999px;
  background: rgba(231, 76, 60, 0.15);
  color: #e74c3c;
  font-weight: 600;
}

.conn.ok {
  background: rgba(70, 209, 96, 0.15);
  color: #46d160;
}

.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 4px;
}

.dot.busy {
  background: #f59e0b;
}

.dot.idle {
  background: #6b7280;
}

.hint-sm {
  opacity: 0.7;
}
</style>
