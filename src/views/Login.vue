<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NText, NAlert, NInput, NDivider } from 'naive-ui'
import { useEcsSessionStore } from '@/stores/ecsSession'
import { buildDesktopOAuthUrl, buildDesktopSignUpUrl } from '@/lib/office-web'
import { openExternalUrl, isElectronApp, isLocalDevHost } from '@/lib/desktop-shell'
import AnimatedCharacters from '@/components/common/AnimatedCharacters.vue'

const router = useRouter()
const route = useRoute()
const ecsSession = useEcsSessionStore()

const appName = 'AntlerOffice'
const email = ref('')
const password = ref('')
const error = ref('')
const checking = ref(true)
const loading = ref(false)
let handoffTimer: ReturnType<typeof setInterval> | null = null
let backendReady = false
const usesDesktopOAuth = computed(() => isElectronApp() || isLocalDevHost())

async function waitForBackend(maxMs = 60000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch('/api/health')
      if (res.ok) return true
    } catch {
      /* backend still starting */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function pollDesktopHandoff() {
  if (!backendReady) return false
  try {
    const res = await fetch('/api/ecs/auth/desktop-pending')
    if (!res.ok) return false
    const data = await res.json()
    if (!data.ok || !data.pending) return false
    ecsSession.applySession({
      accessToken: data.accessToken,
      bossToken: data.bossToken,
      user: data.user,
      offices: data.offices,
      selectedOfficeId: data.selectedOfficeId,
      isSaasAdmin: data.isSaasAdmin,
    })
    const redirect = (route.query.redirect as string) || '/portal'
    await router.replace(redirect.startsWith('/') ? redirect : '/portal')
    return true
  } catch {
    return false
  }
}

async function submitLogin() {
  error.value = ''
  const trimmedEmail = email.value.trim()
  if (!trimmedEmail) {
    error.value = 'Please enter your email'
    return
  }
  if (!password.value) {
    error.value = 'Please enter your password'
    return
  }

  loading.value = true
  try {
    const res = await fetch('/api/ecs/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: trimmedEmail, password: password.value }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) {
      error.value = data.error || 'Sign in failed'
      return
    }
    ecsSession.applySession({
      accessToken: data.accessToken,
      bossToken: data.bossToken,
      user: data.user,
      offices: data.offices,
      selectedOfficeId: data.selectedOfficeId,
      isSaasAdmin: data.isSaasAdmin,
    })
    const redirect = (route.query.redirect as string) || '/portal'
    await router.replace(redirect.startsWith('/') ? redirect : '/portal')
  } catch {
    error.value = 'Sign in failed. Check your connection and try again.'
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  ecsSession.restoreFromStorage()
  if (ecsSession.isLoggedIn) {
    const ok = await ecsSession.refreshSession().catch(() => false)
    if (ok) {
      const redirect = (route.query.redirect as string) || '/portal'
      router.replace(redirect.startsWith('/') ? redirect : '/portal')
      return
    }
  }

  const err = route.query.error
  if (typeof err === 'string' && err) {
    error.value = err
  }
  checking.value = false

  if (isElectronApp() || isLocalDevHost()) {
    void waitForBackend().then((ok) => {
      backendReady = ok
      if (!ok) return
      void pollDesktopHandoff()
      handoffTimer = setInterval(() => {
        void pollDesktopHandoff()
      }, 1500)
    })
  }
})

onUnmounted(() => {
  if (handoffTimer) clearInterval(handoffTimer)
})

function openOAuth(provider: 'google' | 'facebook') {
  const url = buildDesktopOAuthUrl(provider)
  // 浏览器(dev)里直接本标签跳转，避免 window.open 被弹窗拦截导致“点了没反应”；登录完会自动跳回 3300。
  if (!isElectronApp() && isLocalDevHost()) window.location.assign(url)
  else openExternalUrl(url)
}

function openSignUp() {
  const url = buildDesktopSignUpUrl()
  if (!isElectronApp() && isLocalDevHost()) window.location.assign(url)
  else openExternalUrl(url)
}
</script>

<template>
  <div class="login-container">
    <div class="login-left">
      <div class="login-brand">
        <img class="login-logo app-logo app-logo--on-dark" src="/antleroffice-logo.png?v=3" alt="AntlerOffice" />
        <span class="login-brand-text">{{ appName }}</span>
      </div>

      <div class="login-characters">
        <AnimatedCharacters
          :is-typing="!!email"
          :show-password="false"
          :password-length="password.length"
        />
      </div>

      <div class="login-decoration login-decoration-1"></div>
      <div class="login-decoration login-decoration-2"></div>
      <div class="login-decoration login-decoration-3"></div>
    </div>

    <div class="login-right">
      <div class="login-form-wrapper">
        <div class="login-mobile-brand">
          <img class="login-logo-small app-logo" src="/antleroffice-logo.png?v=3" alt="AntlerOffice" />
          <span class="login-brand-text">{{ appName }}</span>
        </div>

        <div v-if="checking" class="login-loading">
          <NText depth="3">Loading…</NText>
        </div>

        <template v-else>
          <div class="login-form-header">
            <h2 class="login-form-title">Welcome</h2>
            <p class="login-form-desc">
              Sign in with your Antler account to access your offices.
            </p>
          </div>

          <NAlert v-if="error" type="error" :bordered="false" style="margin-bottom: 20px;">
            {{ error }}
          </NAlert>

          <form class="login-form" @submit.prevent="submitLogin">
            <label class="login-field-label">Email</label>
            <NInput
              v-model:value="email"
              type="text"
              inputmode="email"
              autocomplete="email"
              placeholder="you@company.com"
              size="large"
              :disabled="loading"
              style="margin-bottom: 16px;"
            />

            <label class="login-field-label">Password</label>
            <NInput
              v-model:value="password"
              type="password"
              autocomplete="current-password"
              placeholder="••••••••"
              size="large"
              show-password-on="click"
              :disabled="loading"
              style="margin-bottom: 20px;"
            />

            <NButton type="primary" block size="large" class="login-btn" attr-type="submit" :loading="loading">
              Sign in
            </NButton>
          </form>

          <NDivider style="margin: 24px 0;">or</NDivider>

          <div class="login-actions">
            <NButton block size="large" class="login-btn login-btn--secondary" :disabled="loading" @click="openOAuth('google')">
              Continue with Google
            </NButton>
            <NButton block size="large" class="login-btn login-btn--secondary" :disabled="loading" @click="openOAuth('facebook')">
              Continue with Facebook
            </NButton>
            <NButton block size="large" quaternary class="login-btn" :disabled="loading" @click="openSignUp">
              Create an account
            </NButton>
          </div>

          <p v-if="usesDesktopOAuth" class="login-hint">
            Google and Facebook sign in on office.antlerzone.com in your browser, then return here automatically.
          </p>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-container {
  min-height: 100vh;
  display: flex;
  width: 100%;
}

.login-left {
  flex: 1;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 48px;
  position: relative;
  overflow: hidden;
}

.login-brand {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 18px;
  font-weight: 600;
  color: white;
}

.login-logo {
  width: 35px;
  height: 35px;
  object-fit: contain;
  flex-shrink: 0;
  background: transparent;
  display: block;
  margin-right: -4px;
}

.login-brand-text {
  color: white;
  margin-left: 10px;
}

.login-characters {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 500px;
}

.login-decoration {
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
}

.login-decoration-1 {
  inset: 0;
  background: radial-gradient(circle at center, rgba(255,255,255,0.05) 0%, transparent 70%);
}

.login-decoration-2 {
  top: 25%;
  right: 25%;
  width: 256px;
  height: 256px;
  background: rgba(255,255,255,0.05);
  filter: blur(64px);
}

.login-decoration-3 {
  bottom: 25%;
  left: 25%;
  width: 384px;
  height: 384px;
  background: rgba(255,255,255,0.03);
  filter: blur(64px);
}

.login-right {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: var(--bg-primary);
}

.login-form-wrapper {
  width: 100%;
  max-width: 420px;
}

.login-mobile-brand {
  display: none;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 48px;
  color: var(--text-primary);
}

.login-mobile-brand .login-brand-text {
  color: var(--text-primary);
  margin-left: 10px;
}

.login-logo-small {
  width: 35px;
  height: 35px;
  object-fit: contain;
  flex-shrink: 0;
  background: transparent;
  display: block;
  margin-right: -4px;
}

.login-form-header {
  margin-bottom: 32px;
  text-align: center;
}

.login-form-title {
  font-size: 32px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 8px;
  letter-spacing: -0.5px;
}

.login-form-desc {
  color: var(--text-secondary);
  font-size: 15px;
}

.login-loading {
  text-align: center;
  padding: 40px 0;
}

.login-field-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.login-actions {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.login-btn {
  border-radius: 8px;
  height: 48px;
  font-weight: 600;
  font-size: 15px;
}

.login-btn--secondary {
  marg