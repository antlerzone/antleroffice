<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NBreadcrumb, NBreadcrumbItem, NButton, NSpace, NTooltip, NIcon } from 'naive-ui'
import { SunnyOutline, MoonOutline, LogOutOutline, LanguageOutline, ChevronBackOutline } from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'
import { useTheme } from '@/composables/useTheme'
import { useAuthStore } from '@/stores/auth'
import { useLocaleStore } from '@/stores/locale'
import { useWebSocketStore } from '@/stores/websocket'
import ConnectionStatus from '@/components/common/ConnectionStatus.vue'
import GatewaySwitcher from '@/components/common/GatewaySwitcher.vue'

const route = useRoute()
const router = useRouter()
const { isDark, toggle } = useTheme()
const authStore = useAuthStore()
const localeStore = useLocaleStore()
const wsStore = useWebSocketStore()
const { t } = useI18n()

const breadcrumbs = computed(() => {
  if (route.name === 'PixelOffice') {
    return [
      { label: t('routes.portal'), name: 'Portal' },
      { label: t('routes.pixelOffice') },
    ]
  }
  const items: { label: string; name?: string }[] = [{ label: t('common.home'), name: 'Dashboard' }]
  if (route.name !== 'Dashboard') {
    const titleKey = route.meta.titleKey as string | undefined
    const fallbackTitle = route.meta.title as string | undefined
    items.push({ label: titleKey ? t(titleKey) : (fallbackTitle || '') })
  }
  return items
})

const showBackToPortal = computed(() => route.name === 'PixelOffice')

function goToPortal() {
  router.push({ name: 'Portal' })
}

const languageToggleTarget = computed(() => (localeStore.locale === 'zh-CN' ? t('common.languageEn') : t('common.languageZh')))

async function handleLogout() {
  wsStore.disconnect()
  await authStore.logout()
  router.push({ name: 'Login' })
}
</script>

<template>
  <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
    <div style="display: flex; align-items: center; gap: 12px; min-width: 0;">
      <NButton
        v-if="showBackToPortal"
        quaternary
        size="small"
        class="back-to-portal-btn"
        @click="goToPortal"
      >
        <template #icon>
          <NIcon :component="ChevronBackOutline" />
        </template>
        {{ t('common.backToPortal') }}
      </NButton>
      <NBreadcrumb>
      <NBreadcrumbItem
        v-for="(item, index) in breadcrumbs"
        :key="index"
        @click="item.name ? router.push({ name: item.name }) : undefined"
      >
        {{ item.label }}
      </NBreadcrumbItem>
    </NBreadcrumb>
    </div>

    <NSpace :size="8" align="center">
      <ConnectionStatus />
      <GatewaySwitcher />

      <NTooltip>
        <template #trigger>
          <NButton quaternary circle @click="toggle">
            <template #icon>
              <NIcon :component="isDark ? SunnyOutline : MoonOutline" />
            </template>
          </NButton>
        </template>
        {{ isDark ? t('common.switchToLight') : t('common.switchToDark') }}
      </NTooltip>

      <NTooltip>
        <template #trigger>
          <NButton quaternary circle @click="localeStore.toggle">
            <template #icon>
              <NIcon :component="LanguageOutline" />
            </template>
          </NButton>
        </template>
        {{ t('common.toggleLanguage', { target: languageToggleTarget }) }}
      </NTooltip>

      <NTooltip>
        <template #trigger>
          <NButton quaternary circle @click="handleLogout">
            <template #icon>
              <NIcon :component="LogOutOutline" />
            </template>
          </NButton>
        </template>
        {{ t('common.logout') }}
      </NTooltip>
    </NSpace>
  </div>
</template>
