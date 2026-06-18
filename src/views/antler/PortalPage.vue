<script setup lang="ts">
import { computed, onMounted, ref, type Component } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NIcon, NInput, NModal, NSpin, NTag, useMessage } from 'naive-ui'
import {
  ArrowForwardOutline,
  BusinessOutline,
  DesktopOutline,
  LogOutOutline,
  PeopleOutline,
  ShieldCheckmarkOutline,
} from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'
import { useEcsSessionStore } from '@/stores/ecsSession'
import { useBossStore } from '@/stores/boss'
import { useLocalGateway } from '@/composables/useLocalGateway'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { officeWebUrl } from '@/lib/office-web'

const api = useAntlerApi()

type PortalDesktop = {
  desktopId: string
  displayName: string
  officeId?: string
  hostname?: string
  online?: boolean
  isLocal?: boolean
  isCurrent?: boolean
  shared?: boolean
  kind?: 'owned' | 'shared'
  gatewayWsUrl?: string
  shareId?: string
  shareStatus?: 'pending' | 'active'
}

type PortalItem = {
  id: string
  title: string
  desc: string
  icon: Component
  onClick: () => void
  status?: 'live' | 'offline' | 'checking'
  badge?: string
  isCurrent?: boolean
}

const router = useRouter()
const message = useMessage()
const { t } = useI18n()
const ecsSession = useEcsSessionStore()
const boss = useBossStore()
const localGateway = useLocalGateway()

const loading = ref(true)
const connecting = ref(false)
const ownedDesktops = ref<PortalDesktop[]>([])
const sharedDesktops = ref<PortalDesktop[]>([])
const localDesktopId = ref('')

const showManualModal = ref(false)
const showRenameModal = ref(false)
const renameTarget = ref<PortalDesktop | null>(null)
const renameValue = ref('')
const manualForm = ref({
  displayName: '',
  gatewayWsUrl: '',
  gatewayAuthToken: '',
  officeId: '',
})

const displayName = computed(() => {
  const user = ecsSession.session?.user
  if (!user) return ''
  if (user.name?.trim()) return user.name.trim()
  const email = user.email || ''
  return email.includes('@') ? email.split('@')[0] : email
})

const localOfficeDesc = computed(() => {
  if (localGateway.checking.value) return t('routes.portalLocalChecking')
  return localGateway.live.value ? t('routes.portalLocalLive') : t('routes.portalLocalOffline')
})

const portalItems = computed<PortalItem[]>(() => {
  const items: PortalItem[] = []

  if (ecsSession.session?.isSaasAdmin) {
    items.push({
      id: 'saas-admin',
      title: 'SaaS Admin Console',
      desc: 'Platform catalog, workers, departments and skins.',
      icon: ShieldCheckmarkOutline,
      onClick: () => {
        window.open(officeWebUrl('/admin'), '_blank', 'noopener,noreferrer')
      },
    })
  }

  items.push({
    id: 'local',
    title: t('routes.portalLocalOffice'),
    desc: localOfficeDesc.value,
    icon: DesktopOutline,
    onClick: () => void connectGateway('local'),
    status: localGateway.checking.value
      ? 'checking'
      : localGateway.live.value
        ? 'live'
        : 'offline',
    isCurrent: ownedDesktops.value.some((d) => d.isLocal && d.isCurrent),
  })

  for (const desk of ownedDesktops.value.filter((d) => !d.isLocal)) {
    items.push({
      id: desk.desktopId,
      title: desk.displayName || desk.hostname || desk.desktopId,
      desc: desktopDesc(desk, false),
      icon: BusinessOutline,
      onClick: () => void connectGateway('remote', desk.desktopId),
      status: desk.online ? 'live' : 'offline',
      isCurrent: desk.isCurrent,
    })
  }

  return items
})

function desktopDesc(desk: PortalDesktop, shared: boolean) {
  const parts = [
    desk.online ? 'Online' : 'Offline',
    shared
      ? desk.shareStatus === 'pending'
        ? t('routes.portalInvitePending')
        : t('routes.portalSharedBadge')
      : 'Owned',
    desk.hostname || desk.desktopId,
  ]
  return parts.join(' · ')
}

async function acceptAndEnter(desk: PortalDesktop) {
  if (connecting.value) return
  connecting.value = true
  try {
    if (desk.shareStatus === 'pending') {
      await portalFetch(`/api/portal/desktops/${encodeURIComponent(desk.desktopId)}/share/accept`, {
        method: 'POST',
      })
    }
    await connectGateway('remote', desk.desktopId, { skipConnectingGuard: true })
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Connect failed')
  } finally {
    connecting.value = false
    void loadDesktops()
  }
}

async function rejectInvite(desk: PortalDesktop) {
  try {
    await portalFetch(`/api/portal/desktops/${encodeURIComponent(desk.desktopId)}/share/reject`, {
      method: 'POST',
    })
    message.success(t('routes.portalInviteRejected'))
    await loadDesktops()
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Reject failed')
  }
}

async function portalFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  }
  if (boss.token) headers['X-Boss-Token'] = boss.token
  const res = await fetch(path, { ...init, headers })
  const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string }
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

async function loadDesktops() {
  try {
    const data = await portalFetch<{
      ok: true
      owned: PortalDesktop[]
      shared: PortalDesktop[]
      localDesktopId: string
    }>('/api/portal/desktops')
    ownedDesktops.value = data.owned || []
    sharedDesktops.value = data.shared || []
    localDesktopId.value = data.localDesktopId || ''
  } catch {
    ownedDesktops.value = []
    sharedDesktops.value = []
  }
}

async function connectGateway(
  mode: 'local' | 'remote',
  desktopId?: string,
  opts?: { skipConnectingGuard?: boolean },
) {
  if (!opts?.skipConnectingGuard && connecting.value) return
  if (!opts?.skipConnectingGuard) connecting.value = true
  try {
    const body: Record<string, string> = { mode }
    if (mode === 'remote' && desktopId) body.desktopId = desktopId
    await portalFetch('/api/gateway/connect', { method: 'POST', body: JSON.stringify(body) })

    if (mode === 'local') {
      let needsAiSetup = false
      try {
        const st = await api.get<{ needsAiSetup?: boolean }>('/api/onboard/state')
        needsAiSetup = !!st.needsAiSetup
      } catch {
        needsAiSetup = false
      }
      router.push({ name: 'PixelOffice', query: needsAiSetup ? { setup: '1' } : undefined })
    } else {
      router.push({ name: 'PixelOffice' })
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Connect failed')
  } finally {
    if (!opts?.skipConnectingGuard) {
      connecting.value = false
      void loadDesktops()
    }
  }
}

function openRename(desk: PortalDesktop) {
  renameTarget.value = desk
  renameValue.value = desk.displayName || ''
  showRenameModal.value = true
}

async function submitRename() {
  if (!renameTarget.value) return
  try {
    await portalFetch(`/api/portal/desktops/${encodeURIComponent(renameTarget.value.desktopId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ displayName: renameValue.value.trim() }),
    })
    showRenameModal.value = false
    await loadDesktops()
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Rename failed')
  }
}

function openManualAdd() {
  manualForm.value = {
    displayName: '',
    gatewayWsUrl: '',
    gatewayAuthToken: '',
    officeId: ecsSession.session?.selectedOfficeId || ecsSession.session?.offices?.[0]?.id || '',
  }
  showManualModal.value = true
}

async function submitManualAdd() {
  try {
    await portalFetch('/api/portal/desktops/manual', {
      method: 'POST',
      body: JSON.stringify(manualForm.value),
    })
    showManualModal.value = false
    message.success('Gateway added')
    await loadDesktops()
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Add failed')
  }
}

function logout() {
  ecsSession.clearSession()
  router.push({ name: 'Login' })
}

onMounted(() => {
  if (!ecsSession.session) {
    router.replace({ name: 'Login' })
    return
  }
  loading.value = false
  void ecsSession.refreshOffices().catch(() => {})
  void loadDesktops()
  localGateway.startBackground()
})
</script>

<template>
  <div class="portal-page">
    <div class="portal-shell">
      <header class="portal-top">
        <div>
          <p class="portal-welcome">Welcome back,</p>
          <p class="portal-user">{{ displayName }}</p>
        </div>
        <NButton quaternary size="small" class="portal-logout" @click="logout">
          <template #icon>
            <NIcon :component="LogOutOutline" />
          </template>
          Logout
        </NButton>
      </header>

      <div class="portal-brand">
        <img class="portal-logo app-logo app-logo--on-dark" src="/antleroffice-logo.png?v=3" alt="AntlerOffice" />
        <div class="portal-brand-text">
          <span class="portal-brand-title">AntlerOffice</span>
        </div>
      </div>

      <div class="portal-heading">
        <h1>{{ t('routes.portalPickGateway') }}</h1>
        <p v-if="!loading">
          {{ t('routes.portalGatewayHint') }}
        </p>
      </div>

      <div v-if="!loading" class="portal-actions">
        <NButton size="small" secondary @click="openManualAdd">{{ t('routes.portalAddGateway') }}</NButton>
        <NButton size="small" quaternary tag="a" :href="officeWebUrl('/dashboard/settings')" target="_blank" rel="noopener">
          {{ t('routes.portalManageSharing') }}
        </NButton>
      </div>

      <NSpin v-if="loading" class="portal-loading" />

      <div v-else class="portal-list">
        <button
          v-for="item in portalItems"
          :key="item.id"
          type="button"
          class="portal-row"
          :class="{
            'portal-row--live': item.status === 'live',
            'portal-row--offline': item.status === 'offline',
            'portal-row--current': item.isCurrent,
          }"
          :disabled="connecting"
          @click="item.onClick"
        >
          <div
            class="portal-row-icon"
            :class="{
              'portal-row-icon--live': item.status === 'live',
              'portal-row-icon--offline': item.status === 'offline',
            }"
          >
            <NIcon :component="item.icon" :size="22" />
          </div>
          <div class="portal-row-body">
            <div class="portal-row-title">
              <span
                v-if="item.status"
                class="portal-status-lamp"
                :class="`portal-status-lamp--${item.status}`"
              />
              <span>{{ item.title }}</span>
              <NTag v-if="item.badge" size="small" round type="info">{{ item.badge }}</NTag>
              <NTag v-if="item.isCurrent" size="small" round type="success">Active</NTag>
            </div>
            <div class="portal-row-desc">{{ item.desc }}</div>
          </div>
          <NIcon :component="ArrowForwardOutline" :size="18" class="portal-row-arrow" />
        </button>

        <div
          v-for="desk in sharedDesktops"
          :key="`shared-${desk.desktopId}`"
          class="portal-row portal-row--shared"
          :class="{
            'portal-row--live': desk.online,
            'portal-row--offline': !desk.online,
            'portal-row--current': desk.isCurrent,
          }"
        >
          <div
            class="portal-row-icon"
            :class="{
              'portal-row-icon--live': desk.online,
              'portal-row-icon--offline': !desk.online,
            }"
          >
            <NIcon :component="PeopleOutline" :size="22" />
          </div>
          <div class="portal-row-body">
            <div class="portal-row-title">
              <span
                class="portal-status-lamp"
                :class="desk.online ? 'portal-status-lamp--live' : 'portal-status-lamp--offline'"
              />
              <span>{{ desk.displayName || desk.hostname || desk.desktopId }}</span>
              <NTag size="small" round type="info">{{ t('routes.portalSharedBadge') }}</NTag>
              <NTag
                v-if="desk.shareStatus === 'pending'"
                size="small"
                round
                type="warning"
              >
                {{ t('routes.portalInvitePending') }}
              </NTag>
              <NTag v-if="desk.isCurrent" size="small" round type="success">Active</NTag>
            </div>
            <div class="portal-row-desc">{{ desktopDesc(desk, true) }}</div>
            <div class="portal-row-actions">
              <NButton
                size="small"
                quaternary
                :disabled="connecting"
                @click="rejectInvite(desk)"
              >
                {{ t('routes.portalRejectInvite') }}
              </NButton>
              <NButton
                size="small"
                type="primary"
                :disabled="connecting"
                @click="acceptAndEnter(desk)"
              >
                {{ t('routes.portalEnterInvite') }}
              </NButton>
            </div>
          </div>
        </div>
      </div>

      <div v-if="!loading && ownedDesktops.length" class="portal-rename-list">
        <p class="portal-rename-title">{{ t('routes.portalRenameDesktop') }}</p>
        <div v-for="desk in ownedDesktops" :key="`rename-${desk.desktopId}`" class="portal-rename-row">
          <span>{{ desk.displayName || desk.desktopId }}</span>
          <NButton size="tiny" quaternary @click="openRename(desk)">Rename</NButton>
        </div>
      </div>

      <p v-if="!loading && portalItems.length <= 1 && sharedDesktops.length === 0" class="portal-empty">
        {{ t('routes.portalNoRemote') }}
        <a :href="officeWebUrl('/portal')" target="_blank" rel="noopener">{{ t('routes.portalOpenWebsite') }}</a>
      </p>

      <p class="portal-footer">
        <a :href="officeWebUrl('/')" target="_blank" rel="noopener">office.antlerzone.com</a>
      </p>
    </div>

    <NModal v-model:show="showManualModal" preset="dialog" :title="t('routes.portalAddGateway')">
      <div class="portal-modal-form">
        <NInput v-model:value="manualForm.displayName" placeholder="Display name" />
        <NInput v-model:value="manualForm.gatewayWsUrl" placeholder="ws://host:18789" />
        <NInput v-model:value="manualForm.gatewayAuthToken" placeholder="Gateway token (optional)" />
        <NInput v-model:value="manualForm.officeId" placeholder="Office ID" />
      </div>
      <template #action>
        <NButton @click="showManualModal = false">Cancel</NButton>
        <NButton type="primary" @click="submitManualAdd">Add</NButton>
      </template>
    </NModal>

    <NModal v-model:show="showRenameModal" preset="dialog" title="Rename desktop">
      <NInput v-model:value="renameValue" placeholder="Display name" />
      <template #action>
        <NButton @click="showRenameModal = false">Cancel</NButton>
        <NButton type="primary" @click="submitRename">Save</NButton>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.portal-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(ellipse at top, #1a2030 0%, #0f1115 55%);
  padding: 24px 16px 40px;
  color: #e8eaed;
}

.portal-shell {
  width: 100%;
  max-width: 560px;
}

.portal-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 20px;
}

.portal-welcome {
  margin: 0;
  font-size: 13px;
  color: #9aa0a6;
}

.portal-user {
  margin: 2px 0 0;
  font-size: 18px;
  font-weight: 600;
}

.portal-brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-bottom: 24px;
}

.portal-logo {
  width: 44px;
  height: 44px;
}

.portal-brand-title {
  font-size: 20px;
  font-weight: 700;
}

.portal-heading {
  text-align: center;
}

.portal-heading h1 {
  margin: 0 0 8px;
  font-size: 28px;
  line-height: 1.2;
}

.portal-heading p {
  margin: 0;
  color: #9aa0a6;
  font-size: 14px;
  line-height: 1.5;
}

.portal-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 16px 0 12px;
  justify-content: center;
}

.portal-loading {
  display: flex;
  justify-content: center;
  margin-top: 32px;
}

.portal-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 8px;
}

.portal-row {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 14px 16px;
  border-radius: 12px;
  border: 1px solid #2a2f3a;
  background: #171a21;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.portal-row:hover:not(:disabled) {
  border-color: #3d4658;
  background: #1c2029;
}

.portal-row:disabled {
  opacity: 0.7;
  cursor: wait;
}

.portal-row--current {
  border-color: #46d16066;
}

.portal-row-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: #222733;
  color: #9aa0a6;
  flex-shrink: 0;
}

.portal-row-icon--live {
  color: #46d160;
  background: #46d1601a;
}

.portal-row-body {
  flex: 1;
  min-width: 0;
}

.portal-row-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
}

.portal-row--shared {
  cursor: default;
}

.portal-row--shared:hover {
  background: #171a21;
  border-color: #2a2f3a;
}

.portal-row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.portal-row-desc {
  margin-top: 4px;
  font-size: 12px;
  color: #9aa0a6;
  line-height: 1.4;
}

.portal-row-arrow {
  color: #6b7280;
  flex-shrink: 0;
}

.portal-status-lamp {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.portal-status-lamp--live {
  background: #46d160;
  box-shadow: 0 0 8px #46d16088;
}

.portal-status-lamp--offline {
  background: #6b7280;
}

.portal-status-lamp--checking {
  background: #f59e0b;
  animation: portal-pulse 1.2s ease-in-out infinite;
}

@keyframes portal-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

.portal-rename-list {
  margin-top: 20px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px dashed #2a2f3a;
}

.portal-rename-title {
  margin: 0 0 8px;
  font-size: 12px;
  color: #9aa0a6;
}

.portal-rename-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}

.portal-empty {
  margin-top: 16px;
  font-size: 13px;
  color: #9aa0a6;
  line-height: 1.5;
  text-align: center;
}

.portal-empty a {
  color: #7dd3fc;
}

.portal-footer {
  margin-top: 24px;
  text-align: center;
  font-size: 12px;
}

.portal-footer a {
  color: #9aa0a6;
}

.portal-modal-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 8px;
}
</style>
