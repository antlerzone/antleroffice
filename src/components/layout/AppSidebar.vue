<script setup lang="ts">
import { h, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NMenu, NText, NSwitch, NSpace } from 'naive-ui'
import type { MenuOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  GridOutline,
  ChatboxEllipsesOutline,
  ChatbubblesOutline,
  BookOutline,
  CalendarOutline,
  SparklesOutline,
  GitNetworkOutline,
  ExtensionPuzzleOutline,
  CogOutline,
  PulseOutline,
  FolderOutline,
  PeopleOutline,
  BusinessOutline,
  ConstructOutline,
  TerminalOutline,
  DesktopOutline,
  ArchiveOutline,
  SettingsOutline,
  CodeSlashOutline,
  AnalyticsOutline,
  ColorPaletteOutline,
  LinkOutline,
  CheckmarkDoneOutline,
} from '@vicons/ionicons5'
import { NIcon } from 'naive-ui'
import { routes } from '@/router/routes'
import { useHermesConnectionStore } from '@/stores/hermes/connection'
import { useBossStore } from '@/stores/boss'

defineProps<{ collapsed: boolean }>()

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const connStore = useHermesConnectionStore()
const bossStore = useBossStore()

const iconMap: Record<string, unknown> = {
  GridOutline,
  ChatboxEllipsesOutline,
  ChatbubblesOutline,
  BookOutline,
  CalendarOutline,
  SparklesOutline,
  GitNetworkOutline,
  ExtensionPuzzleOutline,
  CogOutline,
  PulseOutline,
  FolderOutline,
  PeopleOutline,
  BusinessOutline,
  ConstructOutline,
  TerminalOutline,
  DesktopOutline,
  ArchiveOutline,
  SettingsOutline,
  CodeSlashOutline,
  AnalyticsOutline,
  ColorPaletteOutline,
  LinkOutline,
  CheckmarkDoneOutline,
}

function renderIcon(iconName: string) {
  const icon = iconMap[iconName]
  if (!icon) return undefined
  return () => h(NIcon, null, { default: () => h(icon as any) })
}

const menuOptions = computed<MenuOption[]>(() => {
  const mainRoute = routes.find((r) => r.path === '/')
  if (!mainRoute?.children) return []

  const currentGateway = connStore.currentGateway
  const tier = bossStore.showAdvanced ? 'advanced' : 'boss'

  return mainRoute.children
    .filter((child) => {
      if (child.meta?.hidden) return false
      const gateway = child.meta?.gateway as string | undefined
      if (gateway !== currentGateway) return false
      const routeTier = (child.meta?.tier as string) || 'advanced'
      if (tier === 'boss') return routeTier === 'boss'
      return routeTier === 'advanced' || routeTier === 'boss'
    })
    .map((child) => ({
      label: child.meta?.titleKey ? t(child.meta.titleKey as string) : (child.meta?.title as string),
      key: child.name as string,
      icon: child.meta?.icon ? renderIcon(child.meta.icon as string) : undefined,
    }))
})

const activeKey = computed(() => route.name as string)

function handleSelect(key: string) {
  router.push({ name: key })
}
</script>

<template>
  <div style="display: flex; flex-direction: column; height: 100%;">
    <div style="display: flex; align-items: center; padding: 20px 24px; gap: 10px;">
      <span style="font-size: 24px;">▦</span>
      <NText
        v-if="!collapsed"
        strong
        style="font-size: 17px; white-space: nowrap; letter-spacing: -0.5px;"
      >
        AntlerOffice 2.0
      </NText>
    </div>

    <NMenu
      :value="activeKey"
      :collapsed="collapsed"
      :collapsed-width="64"
      :collapsed-icon-size="20"
      :options="menuOptions"
      :indent="24"
      @update:value="handleSelect"
    />

    <div v-if="!collapsed" style="padding: 12px 20px; margin-top: auto; border-top: 1px solid var(--border-color);">
      <NSpace align="center" justify="space-between">
        <NText depth="3" style="font-size: 12px">Advanced</NText>
        <NSwitch
          size="small"
          :value="bossStore.showAdvanced"
          @update:value="bossStore.setShowAdvanced"
        />
      </NSpace>
    </div>
  </div>
</template>
