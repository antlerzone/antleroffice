<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NSpin, NText } from 'naive-ui'
import { useEcsSessionStore } from '@/stores/ecsSession'
import { isElectronApp, isLocalDevHost } from '@/lib/desktop-shell'

const route = useRoute()
const router = useRouter()
const ecsSession = useEcsSessionStore()

const error = ref('')
const ran = ref(false)
const browserDone = ref(false)

onMounted(async () => {
  if (ran.value) return
  ran.value = true

  const accessToken = String(route.query.accessToken || route.query.token || '').trim()
  if (!accessToken) {
    error.value = 'Missing sign-in token.'
    return
  }

  try {
    await ecsSession.adoptAccessToken(accessToken)
    const next = String(route.query.next || '/portal')
    const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/portal'
    if (isElectronApp() || isLocalDevHost()) {
      await router.replace(safeNext)
    } else {
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
      <NText depth="3" style="margin-top: 12px; max-width: 360px;">
        You can close this browser tab and return to the AntlerOffice app. It will open your office automatically.
      </NText>
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
}

.complete-link:hover {
  text-decoration: underline;
}
</style>
