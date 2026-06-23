<script setup lang="ts">
import { computed, onMounted, ref, type Component } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NIcon, NInput, NModal, NSpin, NTag, useDialog, useMessage } from 'naive-ui'
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
import { useOfficeProfile } from '@/composables/useOfficeProfile'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { officeWebUrl } from '@/lib/office-web'

const PENDING_UNBIND_KEY = 'antleroffice-pending-unbind'

const api = useAntlerApi()

type LocalBindStatus = 'unbound' | 'owned_by_me' | 'owned_by_other'

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
const dialog = useDialog()
const { t } = useI18n()
const ecsSession = useEcsSessionStore()
const boss = useBossStore()
const localGateway = useLocalGateway()
const { desktopDisplayName, hostname, load: loadOfficeProfile } = useOfficeProfile()

const loading = ref(true)
const connecting = ref(false)
const ownedDesktops = ref<PortalDesktop[]>([])
const sharedDesktops = ref<PortalDesktop[]>([])
const localDesktopId = ref('')
const localBindStatus = ref<LocalBindStatus>('unbound')

const showManualModal = ref(false)
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

function customDesktopLabel(desk?: PortalDesktop): string {
  const fromSettings = desktopDisplayName.value.trim()
  if (fromSettings) return fromSettings
  const name = String(desk?.displayName || '').trim()
  if (!name) return ''
  const host = String(desk?.hostname || '').trim()
  const id = String(desk?.desktopId || '').trim()
  if (host && name.toLowerCase() === host.toLowerCase()) return ''
  if (id && name === id) return ''
  return name
}

function formatGatewayTitle(kind: 'local' | 'remote', desk?: PortalDesktop): string {
  const base = kind === 'local' ? t('routes.portalLocalOffice') : t('routes.portalGateway')
  const suffix = customDesktopLabel(desk)
  return suffix ? `${base} (${suffix})` : base
}

function normalizeHost(value: string) {
  return String(value || '').trim().toLowerCase()
}

/** Same PC re-registered with a new desktop-id — hide stale cloud row; use 本机 only. */
function isStaleSameMachineGateway(desk: PortalDesktop) {
  const localDesk = ownedDesktops.value.find((d) => d.isLocal)
  const localHost = normalizeHost(localDesk?.hostname || hostname.value)
  const deskHost = normalizeHost(desk.hostname || '')
  if (!localHost || !deskHost) return false
  return localHost === deskHost
}

const remoteOwnedDesktops = computed(() =>
  ownedDesktops.value.filter((d) => !d.isLocal && !isStaleSameMachineGateway(d)),
)

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

  if (localBindStatus.value !== 'owned_by_other') {
    const localDesk = ownedDesktops.value.find((d) => d.isLocal)
    const localBadge =
      localBindStatus.value === 'unbound' ? t('routes.portalNewDevice') : undefined
    items.push({
      id: 'local',
      title: formatGatewayTitle('local', localDesk),
      desc: localOfficeDesc.value,
      icon: DesktopOutline,
      onClick: () => void connectGateway('local'),
      status: localGateway.checking.value
        ? 'checking'
        : localGateway.live.value
          ? 'live'
          : 'offline',
      badge: localBadge,
      isCurrent: ownedDesktops.value.some((d) => d.isLocal && d.isCurrent),
    })
  }

  for (const desk of remoteOwnedDesktops.value) {
    items.push({
      id: desk.desktopId,
      title: formatGatewayTitle('remote', desk),
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
      localBindStatus?: LocalBindStatus
    }>('/api/portal/desktops')
    ownedDesktops.value = data.owned || []
    sharedDesktops.value = data.shared || []
    localDesktopId.value = data.localDesktopId || ''
    localBindStatus.value = data.localBindStatus || 'unbound'
  } catch {
    ownedDesktops.value = []
    sharedDesktops.value = []
    localBindStatus.value = 'unbound'
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
    const connectRes = await portalFetch<{ created?: boolean }>('/api/gateway/connect', {
      method: 'POST',
      body: JSON.stringify(body),
    })

    if (mode === 'local') {
      await ecsSession.refreshOffices().catch(() => {})
      await loadDesktops()
      if (connectRes.created) {
        message.success(t('routes.portalBindSuccess'))
      }
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

function clearUnbindPending() {
  try {
    localStorage.removeItem(PENDING_UNBIND_KEY)
  } catch {
    /* ignore */
  }
}

function localUnbindOfficeCredit(): number {
  const localDesk = ownedDesktops.value.find((d) => d.isLocal)
  const officeId = localDesk?.officeId || ecsSession.session?.selectedOfficeId
  const office = ecsSession.session?.offices?.find((o) => o.id === officeId)
  if (typeof office?.creditBalance === 'number') return office.creditBalance
  return boss.session?.creditBalance ?? 0
}

async function confirmUnbindLocal() {
  try {
    const res = await portalFetch<{ creditBalanceRemoved?: number }>('/api/portal/desktops/unbind-local', {
      method: 'POST',
    })
    clearUnbindPending()
    await ecsSession.refreshOffices().catch(() => {})
    await loadDesktops()
    await localGateway.refresh()
    const removed =
      typeof res.creditBalanceRemoved === 'number' ? res.creditBalanceRemoved : localUnbindOfficeCredit()
    message.success(
      removed > 0
        ? t('routes.portalUnbindSuccessWithCredits', { balance: removed })
        : t('routes.portalUnbindSuccess'),
    )
    await router.replace({ name: 'Portal' })
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('routes.portalUnbindFailed'))
  }
}

function maybeShowUnbindConfirm() {
  const q = router.currentRoute.value.query
  const fromQuery = q.unbindConfirm === '1' || q.unbindConfirm === 'true'
  let fromStorage = false
  try {
    fromStorage = localStorage.getItem(PENDING_UNBIND_KEY) === '1'
  } catch {
    fromStorage = false
  }
  if (!fromQuery && !fromStorage) return
  if (localBindStatus.value !== 'owned_by_me') {
    clearUnbindPending()
    if (fromQuery) void router.replace({ name: 'Portal' })
    return
  }
  const creditBalance = localUnbindOfficeCredit()
  dialog.warning({
    title: t('routes.portalUnbindConfirmTitle'),
    content:
      creditBalance > 0
        ? t('routes.portalUnbindConfirmBodyWithCredits', { balance: creditBalance })
        : t('routes.portalUnbindConfirmBody'),
    positiveText: t('routes.portalUnbindConfirmOk'),
    negativeText: t('routes.portalUnbindConfirmCancel'),
    onPositiveClick: () => {
      void confirmUnbindLocal()
    },
    onNegativeClick: () => {
      clearUnbindPending()
      if (fromQuery) void router.replace({ name: 'Portal' })
    },
  })
}

onMounted(async () => {
  if (!ecsSession.session) {
    router.replace({ name: 'Login' })
    return
  }
  loading.value = false
  await ecsSession.refreshSession().catch(() => false)
  void ecsSession.refreshOffices().catch(() => {})
  void loadOfficeProfile().catch(() => {})
  await loadDesktops()
  localGateway.startBackground()
  maybeShowUnbindConfirm()
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
        <p v-if="!loading && localBindStatus === 'owned_by_other'" class="portal-bound-other">
          {{ t('routes.portalComputerBoundOther') }}
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
              <span>{{ formatGatewayTitle('remote', desk) }}</span>
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
