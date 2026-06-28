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
import { useEcsSessionStore } from "@/stores/ecsSession";
import { isElectronApp, isSummonHost } from "@/lib/desktop-shell";
import { installAudioUnlockOnGesture } from "@/lib/audio-unlock";
import { useVoice2 } from "@/composables/useVoice2";
import { summonInfo } from "@/lib/summon-debug";
import { useVoiceWake } from "@/composables/useVoiceWake";
import { useVoiceSetupProgress } from "@/composables/useVoiceSetupProgress";
import DownloadToastManager from "@/components/common/DownloadToastManager.vue";
import SummonWakeNotifier from "@/components/common/SummonWakeNotifier.vue";

const HEARTBEAT_MS = 5 * 60 * 1000;

const { theme } = useTheme();
const route = useRoute();
const router = useRouter();
const localeStore = useLocaleStore();
const boss = useBossStore();
const { t } = useI18n();
const { bootstrap: bootstrapVoiceWake, disconnectEvents: disconnectVoiceWake } = useVoiceWake();
useVoiceSetupProgress();

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let removeAudioUnlock: (() => void) | null = null;

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

function openPortalRoute() {
  void router.push({ name: 'Portal' })
}

async function bootstrapSession() {
  const ecs = useEcsSessionStore();
  ecs.restoreFromStorage();
  if (ecs.session?.accessToken) {
    await ecs.refreshSession().catch(() => {});
  }
  await boss.ensureSession().catch(() => {});
}

onMounted(async () => {
  removeAudioUnlock = installAudioUnlockOnGesture();
  await bootstrapSession();
  if (boss.token) startHeartbeat();
  // v2 语音：默认模式什么都不做；只有用户在设置里开了“一直听”才自动连接。
  try { useVoice2().init(); } catch { /* 非语音宿主忽略 */ }
  // v1 语音唤醒已停用（改用 v2）。原 bootstrapVoiceWake() 不再调用。
  if (isElectronApp()) {
    window.antlerDesktop?.onVoiceWakeOpenSettings?.(openSettingsRoute)
  }
  window.addEventListener('antler:open-settings', openSettingsRoute)
  window.addEventListener('antler:navigate-portal', openPortalRoute)
});

onUnmounted(() => {
  stopHeartbeat();
  disconnectVoiceWake();
  removeAudioUnlock?.();
  removeAudioUnlock = null;
  window.removeEventListener('antler:open-settings', openSettingsRoute)
  window.removeEventListener('antler:navigate-portal', openPortalRoute)
});

watch(
  () => boss.token,
  (next, prev) => {
    if (next) {
      startHeartbeat();
      // v1 语音唤醒已停用（改用 v2）。
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
          <DownloadToastManager />
          <SummonWakeNotifier />
        </NDialogProvider>
      </NMessageProvider>
    </NNotificationProvider>
  </NConfigProvider>
</template>
