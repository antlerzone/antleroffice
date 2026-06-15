<script setup lang="ts">
import { computed, watch, onMounted, onUnmounted } from "vue";
import { useRoute } from "vue-router";
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

const HEARTBEAT_MS = 5 * 60 * 1000;

const { theme } = useTheme();
const route = useRoute();
const localeStore = useLocaleStore();
const boss = useBossStore();
const { t } = useI18n();

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

onMounted(() => {
  if (boss.token) startHeartbeat();
});

onUnmounted(() => {
  stopHeartbeat();
});

watch(
  () => boss.token,
  (next) => {
    if (next) startHeartbeat();
    else stopHeartbeat();
  },
);

const naiveLocale = computed(() =>
  localeStore.locale === "zh-CN" ? zhCN : enUS,
);
const naiveDateLocale = computed(() =>
  localeStore.locale === "zh-CN" ? dateZhCN : dateEnUS,
);

const APP_TITLE = import.meta.env.VITE_APP_TITLE || "Antler Office";

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
