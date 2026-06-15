<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NAlert } from 'naive-ui'
import { useBossStore } from '@/stores/boss'

const route = useRoute()
const router = useRouter()
const boss = useBossStore()

const loading = ref(false)
const error = ref('')
const ecsEnabled = ref(false)

onMounted(async () => {
  try {
    const cfg = await fetch('/api/boss/auth/config').then((r) => r.json())
    ecsEnabled.value = !!cfg.ecsEnabled
  } catch {
    ecsEnabled.value = false
  }

  const token = typeof route.query.token === 'string' ? route.query.token : ''
  if (token) {
    const ok = await boss.adoptToken(token)
    if (ok) {
      void router.replace({ name: 'PixelOffice' })
      return
    }
  }

  if (route.query.error) {
    error.value = String(route.query.error)
  }

  if (await boss.refreshSession()) {
    void router.replace({ name: 'PixelOffice' })
  }
})

async function signInWithEcs() {
  loading.value = true
  error.value = ''
  try {
    const r = await fetch('/api/boss/auth/oauth/start')
    const data = await r.json()
    if (!data.ok || !data.authorizeUrl) throw new Error(data.error || 'Could not start login')
    window.location.href = data.authorizeUrl
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Login failed'
    loading.value = false
  }
}

async function devMockLogin() {
  loading.value = true
  error.value = ''
  try {
    await boss.login('boss', 'boss')
    void router.replace({ name: 'PixelOffice' })
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Login failed'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="boss-login">
    <div class="box">
      <h1>Antler Office</h1>
      <p class="hint">Sign in with your ECS account to manage agents, credits, and office sharing.</p>
      <NAlert v-if="error" type="error" :title="error" style="margin-bottom: 12px" />
      <NButton
        v-if="ecsEnabled"
        type="primary"
        block
        size="large"
        :loading="loading"
        @click="signInWithEcs"
      >
        Sign in with Antler Office
      </NButton>
      <NButton
        v-else
        type="primary"
        block
        size="large"
        :loading="loading"
        @click="devMockLogin"
      >
        Continue (dev mock)
      </NButton>
      <p v-if="ecsEnabled" class="hint sm">Opens ECS login in your browser, then returns here automatically.</p>
    </div>
  </div>
</template>

<style scoped>
.boss-login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0f1115;
  padding: 24px;
}
.box {
  width: 100%;
  max-width: 420px;
  padding: 28px;
  border-radius: 12px;
  border: 1px solid #2a2f3a;
  background: #171a21;
}
h1 {
  margin: 0 0 8px;
  font-size: 24px;
}
.hint {
  color: #9aa0a6;
  font-size: 14px;
  line-height: 1.5;
}
.hint.sm {
  margin-top: 12px;
  font-size: 12px;
}
</style>
