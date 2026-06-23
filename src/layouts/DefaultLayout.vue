<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NLayout, NLayoutSider, NLayoutHeader, NLayoutContent } from 'naive-ui'
import AppHeader from '@/components/layout/AppHeader.vue'
import AppSidebar from '@/components/layout/AppSidebar.vue'
import OnboardingWizard from '@/views/antler/OnboardingWizard.vue'
import BossChatMessenger from '@/components/antler/BossChatMessenger.vue'
import MemberModeBanner from '@/components/antler/MemberModeBanner.vue'
import { useWebSocketStore } from '@/stores/websocket'
import { useBossStore } from '@/stores/boss'
import { useEcsSessionStore } from '@/stores/ecsSession'
import { useAiSetupStore } from '@/stores/aiSetup'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useLocalGateway } from '@/composables/useLocalGateway'

const collapsed = ref(false)
const wsStore = useWebSocketStore()
const bossStore = useBossStore()
const aiSetup = useAiSetupStore()
const api = useAntlerApi()
const localGateway = useLocalGateway()
const route = useRoute()
const router = useRouter()
const showOnboarding = ref(false)

const showBossChat = computed(() => route.meta.public !== true)

const showAiSetupModal = computed(() => showOnboarding.value || aiSetup.showModal)

async function refreshSetupState(force = false) {
  try {
    const st = await api.get<{
      needsAiSetup?: boolean
      needsCompanySetup?: boolean
      showSetupWizard?: boolean
    }>('/api/onboard/state')
    if (force || route.query.setup === '1') {
      showOnboarding.value = !!st.needsCompanySetup || !!st.needsAiSetup
    } else if (st.showSetupWizard) {
      showOnboarding.value = true
    }
  } catch {
    if (route.query.setup === '1') showOnboarding.value = true
  }
}

onMounted(async () => {
  const ecsSession = useEcsSessionStore()
  ecsSession.restoreFromStorage()
  if (ecsSession.session?.accessToken) {
    await ecsSession.refreshSession().catch(() => false)
  }
  const ok = await bossStore.ensureSession().catch(() => false)
  if (!ok && bossStore.ecsEnabled) {
    void router.replace({ name: 'BossLogin', query: { redirect: route.fullPath } })
    return
  }
  await refreshSetupState(true)
  localGateway.startBackground()
  await wsStore.connect()
  const sync = () => {
    void wsStore.ws.syncGatewayState().then(() => {
      if (wsStore.state !== wsStore.ws.state) wsStore.state = wsStore.ws.state
    })
  }
  sync()
  setTimeout(sync, 2000)
  setTimeout(sync, 5000)

  const routeGateway = route.meta?.gateway as string | undefined
  if (routeGateway === 'hermes') {
    void router.replace({ name: 'PixelOffice' })
  }
})

function onOnboardingDone() {
  showOnboarding.value = false
  aiSetup.close()
  if (route.query.setup) {
    const q = { ...route.query }
    delete q.setup
    void router.replace({ path: route.path, query: q })
  }
}

watch(
  () => aiSetup.showModal,
  (open) => {
    if (open) showOnboarding.value = true
  },
)
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
          <RouterView v-slot="{ Component, route: childRoute }">
            <transition name="fade" mode="out-in">
              <component :is="Component" :key="childRoute.fullPath" />
            </transition>
          </RouterView>
        </div>
      </NLayoutContent>
    </NLayout>
    <OnboardingWizard :show="showAiSetupModal" @close="onOnboardingDone" @done="onOnboardingDone" />
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
