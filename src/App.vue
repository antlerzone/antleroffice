<script setup lang="ts">
import { computed, watch, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  NNotificationProvider,
  zhCN,
  enUS,
  dateZhCN,
  dateEnUS,
} from "naive-ui";
import { useI18n } from "vue-i18n";
import { useTheme } from "@/composables/useTheme";
import { useLocaleStore } from "@/stores/locale";
import { useBossStore } from "@/stores/boss";
import { isElectronApp } from "@/lib/desktop-shell";
import { useVoiceWake } from "@/composables/useVoiceWake";

const HEARTBEAT_MS = 5 * 60 * 1000;

const { theme } = useTheme();
const route = useRoute();
const router = useRouter();
const localeStore = useLocaleStore();
const boss = useBossStore();
const { t } = useI18n();
const { bootstrap: bootstrapVoiceWake, disconnectEvents: disconnectVoiceWake } = useVoiceWake();

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function startHeartbeat() {
  stopHeartbeat();
  if (!boss.token) return;
  void boss.heartbeat();
  heartbeatTimer = setInterval(() => {
    void boss.heartbeat();
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function openSettingsRoute() {
  void router.push({ name: 'Settings' })
}

onMounted(() => {
  if (boss.token) startHeartbeat();
  if (boss.token && isElectronApp()) void bootstrapVoiceWake();
  if (isElectronApp()) {
    window.antlerDesktop?.onVoiceWakeOpenSettings?.(openSettingsRoute)
  }
  window.addEventListener('antler:open-settings', openSettingsRoute)
});

onUnmounted(() => {
  stopHeartbeat();
  disconnectVoiceWake();
  window.removeEventListener('antler:open-settings', openSettingsRoute)
});

watch(
  () => boss.token,
  (next) => {
    if (next) {
      startHeartbeat();
      if (isElectronApp()) void bootstrapVoiceWake();
    } else {
      stopHeartbeat();
      disconnectVoiceWake();
    }
  },
);

const naiveLocale = computed(() =>
  localeStore.locale === "zh-CN" ? zhCN : enUS,
);
const naiveDateLocale = computed(() =>
  localeStore.locale === "zh-CN" ? dateZhCN : dateEnUS,
);

const APP_TITLE = import.meta.env.VITE_APP_TITLE || "AntlerOffice";

watch(
  () =>
    [route.meta.titleKey as string | undefined, localeStore.locale] as const,
  ([titleKey]) => {
    if (typeof document === "undefined") return;
    if (!titleKey) {
      document.title = APP_TITLE;
      return;
    }
    const title = t(titleKey);
    document.title = `${title} - ${APP_TITLE}`;
  },
  { immediate: true },
);
</script>

<template>
  <NConfigProvider
    :theme="theme"
    :locale="naiveLocale"
    :date-locale="naiveDateLocale"
  >
    <NNotificationProvider>
      <NMessageProvider>
        <NDialogProvider>
          <RouterView />
        </NDialogProvider>
      </NMessageProvider>
    </NNotificationProvider>
  </NConfigProvider>
</template>
