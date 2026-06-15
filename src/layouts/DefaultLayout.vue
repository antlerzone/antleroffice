<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NLayout, NLayoutSider, NLayoutHeader, NLayoutContent } from 'naive-ui'
import AppHeader from '@/components/layout/AppHeader.vue'
import AppSidebar from '@/components/layout/AppSidebar.vue'
import OnboardingWizard from '@/views/antler/OnboardingWizard.vue'
import BossChatMessenger from '@/components/antler/BossChatMessenger.vue'
import MemberModeBanner from '@/components/antler/MemberModeBanner.vue'
import { useWebSocketStore } from '@/stores/websocket'
import { useHermesConnectionStore } from '@/stores/hermes/connection'
import { useBossStore } from '@/stores/boss'

const collapsed = ref(false)
const wsStore = useWebSocketStore()
const connStore = useHermesConnectionStore()
const bossStore = useBossStore()
const route = useRoute()
const router = useRouter()
const showOnboarding = ref(false)

const ONBOARDED_KEY = 'antleroffice2.onboarded'

const isOpenClaw = computed(() => connStore.currentGateway === 'openclaw')

const showBossChat = computed(() => route.meta.public !== true)

onMounted(async () => {
  const ok = await bossStore.ensureSession().catch(() => false)
  if (!ok && bossStore.ecsEnabled) {
    void router.replace({ name: 'BossLogin', query: { redirect: route.fullPath } })
    return
  }
  if (!localStorage.getItem(ONBOARDED_KEY)) {
    showOnboarding.value = true
  }
  if (isOpenClaw.value) {
    wsStore.connect()
  } else {
    connStore.connect()
  }

  const currentGateway = isOpenClaw.value ? 'openclaw' : 'hermes'
  const routeGateway = route.meta?.gateway as string | undefined
  if (routeGateway && routeGateway !== currentGateway) {
    router.replace(isOpenClaw.value ? { name: 'PixelOffice' } : '/hermes/chat')
  }
})

function onOnboardingDone() {
  localStorage.setItem(ONBOARDED_KEY, '1')
  showOnboarding.value = false
}

watch(isOpenClaw, (val) => {
  if (val) {
    wsStore.connect()
    connStore.disconnect()
  } else {
    wsStore.disconnect()
    connStore.connect()
  }

  const currentGateway = val ? 'openclaw' : 'hermes'
  const routeGateway = route.meta?.gateway as string | undefined
  if (routeGateway && routeGateway !== currentGateway) {
    router.push(val ? { name: 'PixelOffice' } : '/hermes/chat')
  }
})

onUnmounted(() => {
  wsStore.disconnect()
})
</script>

<template>
  <NLayout has-sider position="absolute" class="app-layout-root">
    <NLayoutSider
      class="app-layout-sider"
      bordered
      collapse-mode="width"
      :collapsed-width="64"
      :width="240"
      :collapsed="collapsed"
      show-trigger
      :native-scrollbar="false"
      style="height: 100vh;"
      @collapse="collapsed = true"
      @expand="collapsed = false"
    >
      <AppSidebar :collapsed="collapsed" />
    </NLayoutSider>

    <NLayout class="app-layout-main">
      <NLayoutHeader bordered class="app-layout-header">
        <AppHeader />
      </NLayoutHeader>

      <NLayoutContent
        class="app-layout-content"
        :class="{ 'app-layout-content--bleed': route.meta.fullBleed }"
        :native-scrollbar="false"
        :content-style="route.meta.fullBleed ? 'padding: 0; height: 100%;' : 'padding: 24px;'"
      >
        <MemberModeBanner v-if="!route.meta.fullBleed" />
        <div class="page-container" :class="{ 'page-container--bleed': route.meta.fullBleed }">
          <RouterView v-slot="{ Component }">
            <transition name="fade" mode="out-in">
              <component :is="Component" />
            </transition>
          </RouterView>
        </div>
      </NLayoutContent>
    </NLayout>
    <OnboardingWizard :show="showOnboarding" @close="onOnboardingDone" @done="onOnboardingDone" />
    <BossChatMessenger v-if="showBossChat" />
  </NLayout>
</template>

<style scoped>
.app-layout-root {
  inset: 0;
  height: 100vh;
  overflow: hidden;
}

.app-layout-main {
  height: 100vh;
  overflow: hidden;
}

.app-layout-header {
  height: var(--header-height);
  padding: 0 24px;
  display: flex;
  align-items: center;
  position: sticky;
  top: 0;
  z-index: 12;
  background: var(--bg-card);
}

.app-layout-content {
  height: calc(100vh - var(--header-height));
}

:deep(.app-layout-content .n-layout-scroll-container) {
  height: 100%;
}

.page-container--bleed {
  height: 100%;
  min-height: 0;
}

.app-layout-content--bleed :deep(.n-layout-scroll-container) {
  overflow: hidden;
}
</style>
