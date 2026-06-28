<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NSpin, NText, NButton } from 'naive-ui'
import { useEcsSessionStore } from '@/stores/ecsSession'
import { isElectronApp } from '@/lib/desktop-shell'

const route = useRoute()
const router = useRouter()
const ecsSession = useEcsSessionStore()

const error = ref('')
const ran = ref(false)
const browserDone = ref(false)

function safeNextPath(): string {
  const next = String(route.query.next || '/portal')
  return next.startsWith('/') && !next.startsWith('//') ? next : '/portal'
}

// Bring the desktop app to the front via the antleroffice:// deep link.
function openDesktopApp() {
  const accessToken = String(route.query.accessToken || route.query.token || '').trim()
  const url = `antleroffice://auth?accessToken=${encodeURIComponent(accessToken)}&next=${encodeURIComponent(safeNextPath())}`
  window.location.href = url
}

// Escape hatch for people who actually want to use the app inside this browser.
function continueInBrowser() {
  void router.replace(safeNextPath())
}

onMounted(async () => {
  if (ran.value) return
  ran.value = true

  const accessToken = String(route.query.accessToken || route.query.token || '').trim()
  if (!accessToken) {
    error.value = 'Missing sign-in token.'
    return
  }

  try {
    // Always adopt the token: this sets the server-side desktop hand-off, so the
    // AntlerOffice desktop app (polling /api/ecs/auth/desktop-pending) picks the
    // session up and opens the office automatically.
    await ecsSession.adoptAccessToken(accessToken)

    if (isElectronApp()) {
      // Inside the desktop app itself: go straight to the office.
      await router.replace(safeNextPath())
    } else {
      // A normal browser tab (including the OAuth hand-off tab opened from the
      // desktop app): do NOT open the portal here. Just tell the user to return
      // to the AntlerOffice app — it will open the office automatically.
      browserDone.value = true
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Sign-in failed'
  }
})
</script>

<template>
  <div class="complete-page">
    <p v-if="error" class="complete-error">{{ error }}</p>
    <template v-else-if="browserDone">
      <NText style="font-size: 18px; font-weight: 600;">Signed in successfully</NText>
      <NText depth="3" style="margin-top: 12px; max-width: 380px;">
        Please return to the AntlerOffice desktop app — your office will open there
        automatically. You can close this browser tab.
      </NText>
      <NButton type="primary" style="margin-top: 20px;" @click="openDesktopApp">
        Open AntlerOffice
      </NButton>
      <a class="complete-link complete-link--muted" @click.prevent="continueInBrowser">
        Or continue in this browser
      </a>
    </template>
    <template v-else>
      <NSpin size="medium" />
      <NText depth="3" style="margin-top: 16px;">Signing you in…</NText>
    </template>
    <a v-if="error" href="/login" class="complete-link">Back to sign in</a>
  </div>
</template>

<style scoped>
.complete-page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
}

.complete-error {
  color: var(--error-color, #e74c3c);
  margin-bottom: 16px;
}

.complete-link {
  color: var(--primary-color, #3b82f6);
  text-decoration: none;
  cursor: pointer;
}

.complete-link:hover {
  text-decoration: underline;
}

.complete-link--muted {
  margin-top: 14px;
  font-size: 13px;
  opacity: 0.7;
}
</style>
