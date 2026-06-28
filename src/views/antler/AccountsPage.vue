<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { NIcon, useMessage } from 'naive-ui'
import { EyeOutline, EyeOffOutline, LogoFacebook, LogoInstagram, LogoLinkedin, LogoTiktok, GlobeOutline, AddOutline, CloseOutline, CheckmarkCircleOutline, AlertCircleOutline, KeyOutline, ChevronBackOutline } from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'
import { useWebAccounts, type BossWebAccount } from '@/composables/useWebAccounts'
import { useBossStore } from '@/stores/boss'
import RetellApiKeyCard from '@/components/settings/RetellApiKeyCard.vue'

const { t } = useI18n()
const message = useMessage()
const boss = useBossStore()

const {
  loading,
  prefs,
  pageRows,
  total,
  totalPages,
  pageInfo,
  PAGE_SIZES,
  revealed,
  refresh,
  revealSecrets,
  hideSecrets,
  isRevealed,
  passwordDisplay,
  onPageChange,
  onPageSizeChange,
} = useWebAccounts()

const revealing = ref<string | null>(null)

function revealedUsername(row: BossWebAccount) {
  return revealed.value[row.alias]?.username || row.username
}

async function togglePassword(row: BossWebAccount) {
  if (isRevealed(row.alias)) {
    hideSecrets(row.alias)
    return
  }
  revealing.value = row.alias
  try {
    await revealSecrets(row.alias)
  } catch {
    message.error(t('accounts.revealFailed'))
  } finally {
    revealing.value = null
  }
}

onMounted(() => {
  refresh().catch(() => message.error(t('accounts.loadFailed')))
  fetchAccountTypes()
  fetchTelemarketerHired()
})

function authHeaders(): Record<string, string> {
  return boss.token ? { 'X-Boss-Token': boss.token, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }
}

// ── Telemarketer hire status (gates the Retell API key card) ───────────────
const telemarketerHired = ref(false)

async function fetchTelemarketerHired() {
  try {
    const res = await fetch('/api/config/agents/catalog', { headers: authHeaders() })
    const data = await res.json()
    const templates: Array<{ id?: string; hired?: boolean }> = data.templates ?? []
    telemarketerHired.value = templates.some((tpl) => tpl.id === 'telemarketer' && tpl.hired === true)
  } catch {
    telemarketerHired.value = false
  }
}

// ── Account types from installed bundles ───────────────────────────────────

interface AccountField {
  key: string
  labelKey?: string
  label?: string
  type: 'text' | 'password'
  placeholder?: string
}

interface AccountType {
  alias: string
  label: string
  category?: string
  websiteUrl?: string
  optional?: boolean
  fields?: AccountField[]
}

const accountTypes = ref<AccountType[]>([])

async function fetchAccountTypes() {
  try {
    // Only accounts required by currently hired NPCs — the page stays empty of
    // manual-entry options until a hired NPC actually needs an account.
    const res = await fetch('/api/catalog/hired-required-accounts', { headers: authHeaders() })
    const data = await res.json()
    if (data.ok) accountTypes.value = data.accounts ?? []
  } catch {
    // Ignore — fallback to empty list
  }
}

// Manual account entry (Add Account / Browser Login) only appears once a hired
// NPC requires at least one account.
const canAddAccounts = computed(() => accountTypes.value.length > 0)

const CATEGORY_ORDER = ['utility', 'banking', 'government', 'saas', 'other']
const CATEGORY_ICONS: Record<string, string> = {
  utility: '💡',
  banking: '🏦',
  government: '🏛️',
  saas: '☁️',
  other: '🔗',
}

function categoryLabel(cat: string): string {
  const key = `npcOnboarding.category.${cat}`
  const translated = t(key)
  return translated !== key ? translated : cat
}

const groupedAccountTypes = computed(() => {
  const groups: { cat: string; icon: string; label: string; items: AccountType[] }[] = []
  const map: Record<string, AccountType[]> = {}
  for (const acct of accountTypes.value) {
    const cat = acct.category || 'other'
    if (!map[cat]) map[cat] = []
    map[cat].push(acct)
  }
  for (const cat of CATEGORY_ORDER) {
    if (map[cat]?.length) {
      groups.push({ cat, icon: CATEGORY_ICONS[cat] ?? '🔗', label: categoryLabel(cat), items: map[cat] })
    }
  }
  return groups
})

// ── Add Account (credential) modal ─────────────────────────────────────────

type CredStep = 'select' | 'fill' | 'saving' | 'done' | 'error'

const showCredModal = ref(false)
const credStep = ref<CredStep>('select')
const selectedAccountType = ref<AccountType | null>(null)
const credFields = ref<Record<string, string>>({})
const credError = ref('')
const savedAlias = ref('')

// Custom account fallback
const customMode = ref(false)
const customLabel = ref('')
const customUrl = ref('')

function resolveFieldLabel(field: AccountField): string {
  if (field.labelKey) {
    const translated = t(field.labelKey)
    if (translated !== field.labelKey) return translated
  }
  return field.label ?? field.key
}

function openAddAccount() {
  credStep.value = 'select'
  selectedAccountType.value = null
  credFields.value = {}
  credError.value = ''
  savedAlias.value = ''
  customMode.value = false
  customLabel.value = ''
  customUrl.value = ''
  showCredModal.value = true
}

function closeCredModal() {
  showCredModal.value = false
}

function selectAccountType(acct: AccountType) {
  selectedAccountType.value = acct
  customMode.value = false
  credFields.value = {}
  credError.value = ''
  credStep.value = 'fill'
}

function selectCustom() {
  selectedAccountType.value = null
  customMode.value = true
  credFields.value = {}
  credError.value = ''
  credStep.value = 'fill'
}

function backToSelect() {
  credStep.value = 'select'
  credError.value = ''
}

const currentFields = computed<AccountField[]>(() => {
  if (customMode.value) {
    return [
      { key: 'username', labelKey: 'npcOnboarding.field.username', type: 'text' },
      { key: 'password', labelKey: 'npcOnboarding.field.password', type: 'password' },
    ]
  }
  return selectedAccountType.value?.fields ?? [
    { key: 'username', labelKey: 'npcOnboarding.field.username', type: 'text' },
    { key: 'password', labelKey: 'npcOnboarding.field.password', type: 'password' },
  ]
})

const fillTitle = computed(() => {
  if (customMode.value) return customLabel.value || 'Custom Account'
  return selectedAccountType.value?.label ?? ''
})

const canSave = computed(() => {
  if (customMode.value && !customLabel.value.trim()) return false
  for (const field of currentFields.value) {
    if (!String(credFields.value[field.key] ?? '').trim()) return false
  }
  return true
})

async function saveCredAccount() {
  credError.value = ''
  credStep.value = 'saving'
  try {
    const acct = selectedAccountType.value
    const label = customMode.value ? customLabel.value.trim() : acct!.label
    const alias = customMode.value ? undefined : acct!.alias
    const websiteUrl = customMode.value ? customUrl.value.trim() : acct!.websiteUrl

    const body: Record<string, string | undefined> = {
      displayName: label,
      username: String(credFields.value['username'] ?? '').trim(),
      password: String(credFields.value['password'] ?? '').trim(),
      alias,
      website: alias,
      websiteUrl,
    }

    // Handle non-standard fields (e.g. icNumber maps to username slot)
    for (const field of currentFields.value) {
      if (field.key !== 'username' && field.key !== 'password') {
        // Extra fields: prefix with field key in notes or map to username
        body[field.key] = String(credFields.value[field.key] ?? '').trim()
      }
    }

    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'Save failed')
    savedAlias.value = data.alias || alias || ''
    credStep.value = 'done'
    await refresh()
  } catch (e) {
    credError.value = e instanceof Error ? e.message : 'Save failed'
    credStep.value = 'error'
  }
}

function addAnotherCred() {
  credStep.value = 'select'
  selectedAccountType.value = null
  credFields.value = {}
  credError.value = ''
  savedAlias.value = ''
  customMode.value = false
}

// ── Platform registry (browser-capture) ───────────────────────────────────
interface Platform {
  key: string
  label: string
  url: string
  icon?: unknown
  color?: string
  hint?: string
}

const PLATFORMS: Platform[] = [
  { key: 'facebook', label: 'Facebook', url: 'https://www.facebook.com', icon: LogoFacebook, color: '#1877f2', hint: 'facebook_post, facebook_comment' },
  { key: 'instagram', label: 'Instagram', url: 'https://www.instagram.com', icon: LogoInstagram, color: '#e1306c', hint: 'instagram_post, instagram_story' },
  { key: 'xhs', label: '小红书', url: 'https://www.xiaohongshu.com', color: '#ff2442', hint: 'xhs_post, xhs_comment' },
  { key: 'tiktok', label: 'TikTok', url: 'https://www.tiktok.com', icon: LogoTiktok, color: '#010101', hint: 'tiktok_post, tiktok_video' },
  { key: 'linkedin', label: 'LinkedIn', url: 'https://www.linkedin.com', icon: LogoLinkedin, color: '#0a66c2', hint: 'linkedin_post, linkedin_connect' },
  { key: 'twitter', label: 'Twitter / X', url: 'https://x.com', color: '#000000', hint: 'tweet, x_reply' },
  { key: 'custom', label: 'Custom', url: '', icon: GlobeOutline, color: '#6b7280', hint: '' },
]

// ── Browser-capture modal ──────────────────────────────────────────────────
type CaptureStep = 'config' | 'opening' | 'waiting' | 'finishing' | 'done' | 'error'

const showModal = ref(false)
const captureStep = ref<CaptureStep>('config')
const captureSessionId = ref('')
const captureError = ref('')
const captureAlias = ref('')

const form = ref({
  platformKey: 'facebook',
  customUrl: '',
  displayName: '',
  username: '',
})

const selectedPlatform = computed(
  () => PLATFORMS.find((p) => p.key === form.value.platformKey) ?? PLATFORMS[0]!,
)

const resolvedUrl = computed(() => {
  if (form.value.platformKey === 'custom') return form.value.customUrl.trim()
  return selectedPlatform.value.url
})

const canOpen = computed(
  () => !!resolvedUrl.value && !!form.value.displayName.trim(),
)

function openModal() {
  form.value = { platformKey: 'facebook', customUrl: '', displayName: '', username: '' }
  captureStep.value = 'config'
  captureSessionId.value = ''
  captureError.value = ''
  captureAlias.value = ''
  showModal.value = true
}

function closeModal() {
  if (captureSessionId.value && captureStep.value === 'waiting') {
    cancelCapture()
  }
  showModal.value = false
}

async function openBrowser() {
  captureStep.value = 'opening'
  captureError.value = ''
  try {
    const res = await fetch('/api/accounts/browser-capture/start', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        url: resolvedUrl.value,
        website: form.value.platformKey,
        displayName: form.value.displayName.trim(),
        allowedActions: [],
      }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'Failed to open browser')
    captureSessionId.value = data.sessionId
    captureStep.value = 'waiting'
  } catch (e: unknown) {
    captureError.value = e instanceof Error ? e.message : 'Unknown error'
    captureStep.value = 'error'
  }
}

async function finishCapture() {
  captureStep.value = 'finishing'
  captureError.value = ''
  try {
    const res = await fetch(`/api/accounts/browser-capture/${captureSessionId.value}/finish`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        username: form.value.username.trim(),
        displayName: form.value.displayName.trim(),
      }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'Failed to save account')
    captureAlias.value = data.alias || ''
    captureStep.value = 'done'
    await refresh()
  } catch (e: unknown) {
    captureError.value = e instanceof Error ? e.message : 'Unknown error'
    captureStep.value = 'error'
  }
}

async function cancelCapture() {
  if (!captureSessionId.value) return
  try {
    await fetch(`/api/accounts/browser-capture/${captureSessionId.value}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
  } catch {
    // ignore
  }
  captureSessionId.value = ''
}

function addAnother() {
  form.value = { platformKey: form.value.platformKey, customUrl: form.value.customUrl, displayName: '', username: '' }
  captureStep.value = 'config'
  captureSessionId.value = ''
  captureAlias.value = ''
}
</script>

<template>
  <div class="antler-v1-root accounts-page">
    <!-- ── Page header ── -->
    <div class="view-head">
      <h1 class="view-title">{{ t('accounts.title') }}</h1>
      <div v-if="canAddAccounts" class="head-actions">
        <button type="button" class="btn primary connect-btn" @click="openAddAccount">
          <NIcon :size="16"><KeyOutline /></NIcon>
          Add Account
        </button>
        <button type="button" class="btn ghost connect-btn" @click="openModal">
          <NIcon :size="16"><GlobeOutline /></NIcon>
          Browser Login
        </button>
      </div>
    </div>

    <!-- ── Retell API key (only when Telemarketer NPC is hired) ── -->
    <RetellApiKeyCard v-if="telemarketerHired" class="accounts-retell-card" />

    <!-- ── Search bar ── -->
    <div v-if="!loading" class="accounts-list-bar">
      <input
        v-model="prefs.search"
        type="search"
        class="accounts-search"
        :placeholder="t('accounts.searchPlaceholder')"
        autocomplete="off"
        @input="prefs.page = 1"
      />
    </div>

    <p v-if="loading" class="hint">{{ t('accounts.loading') }}</p>

    <p v-else-if="!total" class="hint">
      {{ prefs.search ? t('accounts.noMatch') : t('accounts.empty') }}
    </p>

    <template v-else>
      <div class="accounts-sheet-wrap">
        <table class="channels-table accounts-sheet">
          <thead>
            <tr>
              <th class="col-num">#</th>
              <th>{{ t('accounts.colLabel') }}</th>
              <th>{{ t('accounts.colUsername') }}</th>
              <th>{{ t('accounts.colPassword') }}</th>
              <th>{{ t('accounts.colAlias') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in pageRows" :key="row.alias">
              <td class="col-num">{{ (prefs.page - 1) * prefs.pageSize + index + 1 }}</td>
              <td>{{ row.displayName }}</td>
              <td>{{ row.username }}</td>
              <td class="col-password">
                <code class="password-text" :class="{ revealed: isRevealed(row.alias) }">
                  {{ passwordDisplay(row) }}
                </code>
                <button
                  v-if="row.secretSet"
                  type="button"
                  class="btn icon-btn"
                  :title="isRevealed(row.alias) ? t('accounts.hidePassword') : t('accounts.showPassword')"
                  :disabled="revealing === row.alias"
                  @click="togglePassword(row)"
                >
                  <NIcon :size="18">
                    <component :is="isRevealed(row.alias) ? EyeOffOutline : EyeOutline" />
                  </NIcon>
                </button>
              </td>
              <td><code>{{ row.alias }}</code></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="channels-list-footer channels-pagination accounts-pagination">
        <span class="channels-page-info">
          {{ t('accounts.pageInfo', { start: pageInfo.start, end: pageInfo.end, total }) }}
        </span>
        <div class="channels-page-btns">
          <button type="button" class="btn ghost sm" :disabled="prefs.page <= 1" @click="onPageChange(prefs.page - 1)">
            {{ t('accounts.prev') }}
          </button>
          <button
            v-for="p in Math.min(totalPages, 5)"
            :key="p"
            type="button"
            class="btn ghost sm"
            :class="{ active: p === prefs.page }"
            :disabled="p === prefs.page"
            @click="onPageChange(p)"
          >
            {{ p }}
          </button>
          <button type="button" class="btn ghost sm" :disabled="prefs.page >= totalPages" @click="onPageChange(prefs.page + 1)">
            {{ t('accounts.next') }}
          </button>
        </div>
        <label class="channels-page-size">
          {{ t('accounts.show') }}
          <select :value="prefs.pageSize" @change="onPageSizeChange(Number(($event.target as HTMLSelectElement).value))">
            <option v-for="n in PAGE_SIZES" :key="n" :value="n">{{ n }}</option>
          </select>
          {{ t('accounts.perPage') }}
        </label>
      </div>
    </template>

    <!-- ── Add Account (credential) modal ── -->
    <Teleport to="body">
      <div v-if="showCredModal" class="bc-backdrop" @click.self="closeCredModal">
        <div class="bc-modal">
          <!-- Header -->
          <div class="bc-modal-head">
            <div class="bc-modal-head-left">
              <button
                v-if="credStep === 'fill'"
                type="button"
                class="btn icon-btn bc-back"
                @click="backToSelect"
              >
                <NIcon :size="18"><ChevronBackOutline /></NIcon>
              </button>
              <span class="bc-modal-title">
                {{ credStep === 'select' ? 'Add Account' : fillTitle }}
              </span>
            </div>
            <button type="button" class="btn icon-btn bc-close" @click="closeCredModal">
              <NIcon :size="20"><CloseOutline /></NIcon>
            </button>
          </div>

          <!-- ── Step: select account type ── -->
          <template v-if="credStep === 'select'">
            <p class="bc-hint">Choose the account you want to add. These are used by your NPC staff to access websites on your behalf.</p>

            <div v-for="group in groupedAccountTypes" :key="group.cat" class="acct-group">
              <div class="acct-group-label">{{ group.icon }} {{ group.label }}</div>
              <div class="acct-type-grid">
                <button
                  v-for="acct in group.items"
                  :key="acct.alias"
                  type="button"
                  class="acct-type-btn"
                  @click="selectAccountType(acct)"
                >
                  <span class="acct-type-name">{{ acct.label }}</span>
                  <span v-if="acct.websiteUrl" class="acct-type-url">{{ acct.websiteUrl.replace('https://', '') }}</span>
                </button>
              </div>
            </div>

            <!-- Custom option -->
            <div class="acct-group">
              <div class="acct-group-label">🔗 Other</div>
              <div class="acct-type-grid">
                <button type="button" class="acct-type-btn custom-btn" @click="selectCustom">
                  <span class="acct-type-name">+ Custom</span>
                  <span class="acct-type-url">Any website</span>
                </button>
              </div>
            </div>
          </template>

          <!-- ── Step: fill credentials ── -->
          <template v-else-if="credStep === 'fill'">
            <p v-if="selectedAccountType?.websiteUrl" class="bc-hint site-hint">
              🌐 {{ selectedAccountType.websiteUrl }}
            </p>

            <!-- Custom: extra fields -->
            <template v-if="customMode">
              <div class="bc-field">
                <label class="bc-label">Account Label <span class="bc-required">*</span></label>
                <input v-model="customLabel" type="text" class="bc-input" placeholder="e.g. My Maybank Business" autocomplete="off" />
              </div>
              <div class="bc-field">
                <label class="bc-label">Website URL <span class="bc-optional">(optional)</span></label>
                <input v-model="customUrl" type="url" class="bc-input" placeholder="https://example.com" autocomplete="off" />
              </div>
            </template>

            <!-- Dynamic credential fields -->
            <div v-for="field in currentFields" :key="field.key" class="bc-field">
              <label class="bc-label">{{ resolveFieldLabel(field) }} <span class="bc-required">*</span></label>
              <input
                v-model="credFields[field.key]"
                :type="field.type"
                class="bc-input"
                :placeholder="field.placeholder ?? ''"
                autocomplete="off"
              />
            </div>

            <div v-if="credError" class="bc-error-inline">{{ credError }}</div>

            <div class="bc-actions">
              <button type="button" class="btn ghost" @click="backToSelect">Back</button>
              <button type="button" class="btn primary" :disabled="!canSave" @click="saveCredAccount">
                Save
              </button>
            </div>
          </template>

          <!-- ── Step: saving ── -->
          <template v-else-if="credStep === 'saving'">
            <div class="bc-status-wrap">
              <div class="bc-spinner" />
              <p class="bc-status-text">Saving…</p>
            </div>
          </template>

          <!-- ── Step: done ── -->
          <template v-else-if="credStep === 'done'">
            <div class="bc-status-wrap success">
              <NIcon :size="48" class="bc-success-icon"><CheckmarkCircleOutline /></NIcon>
              <p class="bc-status-text">Account saved!</p>
              <p class="bc-status-sub">
                Saved as <code>{{ savedAlias }}</code>. Your staff can now use this account.
              </p>
            </div>
            <div class="bc-actions">
              <button type="button" class="btn ghost" @click="addAnotherCred">Add another</button>
              <button type="button" class="btn primary" @click="closeCredModal">Done</button>
            </div>
          </template>

          <!-- ── Step: error ── -->
          <template v-else-if="credStep === 'error'">
            <div class="bc-status-wrap error">
              <NIcon :size="48" class="bc-error-icon"><AlertCircleOutline /></NIcon>
              <p class="bc-status-text">Something went wrong</p>
              <p class="bc-status-sub">{{ credError }}</p>
            </div>
            <div class="bc-actions">
              <button type="button" class="btn ghost" @click="closeCredModal">Close</button>
              <button type="button" class="btn primary" @click="credStep = 'fill'">Try again</button>
            </div>
          </template>
        </div>
      </div>
    </Teleport>

    <!-- ── Browser-capture modal ── -->
    <Teleport to="body">
      <div v-if="showModal" class="bc-backdrop" @click.self="closeModal">
        <div class="bc-modal">
          <div class="bc-modal-head">
            <span class="bc-modal-title">Connect Account via Browser</span>
            <button type="button" class="btn icon-btn bc-close" @click="closeModal">
              <NIcon :size="20"><CloseOutline /></NIcon>
            </button>
          </div>

          <template v-if="captureStep === 'config'">
            <p class="bc-hint">
              AntlerOffice will open Chrome. Log in to the platform, then come back and click <strong>Done</strong>.
              Cookies are saved locally — your password never leaves your computer.
            </p>
            <div class="bc-platform-grid">
              <button
                v-for="p in PLATFORMS"
                :key="p.key"
                type="button"
                class="bc-platform-btn"
                :class="{ selected: form.platformKey === p.key }"
                :style="form.platformKey === p.key ? `border-color: ${p.color}; color: ${p.color}` : ''"
                @click="form.platformKey = p.key"
              >
                <NIcon v-if="p.icon" :size="22"><component :is="p.icon" /></NIcon>
                <span class="bc-platform-label">{{ p.label }}</span>
              </button>
            </div>
            <div v-if="form.platformKey === 'custom'" class="bc-field">
              <label class="bc-label">Platform URL</label>
              <input v-model="form.customUrl" type="url" class="bc-input" placeholder="https://example.com/login" autocomplete="off" />
            </div>
            <div class="bc-field">
              <label class="bc-label">Account label <span class="bc-required">*</span></label>
              <input v-model="form.displayName" type="text" class="bc-input" :placeholder="`e.g. ${selectedPlatform.label} – Company Page`" autocomplete="off" maxlength="80" />
              <p class="bc-field-hint">How this account appears in the agents' list</p>
            </div>
            <div class="bc-field">
              <label class="bc-label">Username / handle <span class="bc-optional">(optional)</span></label>
              <input v-model="form.username" type="text" class="bc-input" placeholder="e.g. @company or email" autocomplete="off" maxlength="120" />
            </div>
            <div class="bc-actions">
              <button type="button" class="btn ghost" @click="closeModal">Cancel</button>
              <button type="button" class="btn primary" :disabled="!canOpen" @click="openBrowser">Open Browser</button>
            </div>
          </template>

          <template v-else-if="captureStep === 'opening'">
            <div class="bc-status-wrap">
              <div class="bc-spinner" />
              <p class="bc-status-text">Opening Chrome…</p>
            </div>
          </template>

          <template v-else-if="captureStep === 'waiting'">
            <div class="bc-waiting">
              <div class="bc-waiting-icon" :style="`background: ${selectedPlatform.color}22; color: ${selectedPlatform.color}`">
                <NIcon v-if="selectedPlatform.icon" :size="32"><component :is="selectedPlatform.icon" /></NIcon>
                <NIcon v-else :size="32"><GlobeOutline /></NIcon>
              </div>
              <p class="bc-waiting-title">Chrome is open</p>
              <p class="bc-waiting-body">
                Log in to <strong>{{ selectedPlatform.label }}</strong> in the browser window that just opened.
                When you're done, come back here and click <strong>Done</strong>.
              </p>
              <p class="bc-waiting-note">The browser will close automatically and your session cookies will be saved securely.</p>
            </div>
            <div class="bc-actions">
              <button type="button" class="btn ghost" @click="cancelCapture(); captureStep = 'config'">Cancel</button>
              <button type="button" class="btn primary" @click="finishCapture">✓ Done — save cookies</button>
            </div>
          </template>

          <template v-else-if="captureStep === 'finishing'">
            <div class="bc-status-wrap">
              <div class="bc-spinner" />
              <p class="bc-status-text">Saving account…</p>
            </div>
          </template>

          <template v-else-if="captureStep === 'done'">
            <div class="bc-status-wrap success">
              <NIcon :size="48" class="bc-success-icon"><CheckmarkCircleOutline /></NIcon>
              <p class="bc-status-text">Account connected!</p>
              <p class="bc-status-sub">Saved as <code>{{ captureAlias }}</code>. Your COO can now use this account.</p>
            </div>
            <div class="bc-actions">
              <button type="button" class="btn ghost" @click="addAnother">Add another</button>
              <button type="button" class="btn primary" @click="closeModal">Close</button>
            </div>
          </template>

          <template v-else-if="captureStep === 'error'">
            <div class="bc-status-wrap error">
              <NIcon :size="48" class="bc-error-icon"><AlertCircleOutline /></NIcon>
              <p class="bc-status-text">Something went wrong</p>
              <p class="bc-status-sub">{{ captureError }}</p>
              <p v-if="/playwright/i.test(captureError)" class="bc-install-hint">
                Run <code>npx playwright install chrome</code> in the AntlerOffice2 folder to install the browser driver.
              </p>
            </div>
            <div class="bc-actions">
              <button type="button" class="btn ghost" @click="closeModal">Close</button>
              <button type="button" class="btn primary" @click="captureStep = 'config'">Try again</button>
            </div>
          </template>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.accounts-page {
  padding-bottom: 24px;
}

.view-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;
}

.head-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.connect-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.accounts-retell-card { margin-bottom: 16px; }

/* ── Search / table ── */
.accounts-list-bar { margin-bottom: 12px; }

.accounts-search {
  width: min(420px, 100%);
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-color, #333);
  background: var(--input-bg, #1a1a1a);
  color: inherit;
}

.accounts-sheet-wrap { overflow-x: auto; margin-bottom: 8px; }
.accounts-sheet { width: 100%; min-width: 560px; }
.col-num { width: 48px; text-align: center; opacity: 0.7; }

.col-password { display: flex; align-items: center; gap: 8px; }

.password-text {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  letter-spacing: 0.02em;
  opacity: 0.85;
}

.password-text.revealed { opacity: 1; font-size: 13px; }
.icon-btn { padding: 4px 6px; min-width: 0; line-height: 0; }
.accounts-pagination { margin-top: 12px; }

/* ── Account type groups ── */
.acct-group { margin-bottom: 20px; }

.acct-group-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.55;
  margin-bottom: 8px;
}

.acct-type-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 8px;
}

.acct-type-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--line, rgba(255,255,255,0.12));
  background: transparent;
  color: var(--text, #e8eaed);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s, background 0.15s;
}

.acct-type-btn:hover {
  border-color: #3b82f6;
  background: rgba(59, 130, 246, 0.06);
}

.custom-btn {
  border-style: dashed;
  opacity: 0.7;
}

.custom-btn:hover { opacity: 1; }

.acct-type-name {
  font-size: 14px;
  font-weight: 600;
}

.acct-type-url {
  font-size: 10px;
  opacity: 0.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.site-hint {
  font-size: 12px;
  opacity: 0.6;
  margin-bottom: 16px !important;
}

.bc-error-inline {
  padding: 10px 14px;
  background: rgba(248, 113, 113, 0.1);
  border: 1px solid rgba(248, 113, 113, 0.3);
  border-radius: 8px;
  color: #f87171;
  font-size: 13px;
  margin-bottom: 12px;
}

.bc-modal-head-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.bc-back { opacity: 0.7; }
.bc-back:hover { opacity: 1; }

/* ── Shared modal styles ── */
.bc-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  padding: 16px;
}

.bc-modal {
  background: var(--panel, #1d2130);
  border: 1px solid var(--line, rgba(255,255,255,0.1));
  border-radius: 16px;
  width: min(520px, 100%);
  max-height: 90vh;
  overflow-y: auto;
  padding: 24px;
  box-shadow: 0 24px 64px rgba(0,0,0,0.5);
}

.bc-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.bc-modal-title { font-size: 16px; font-weight: 600; }
.bc-close { opacity: 0.6; }
.bc-close:hover { opacity: 1; }

.bc-hint {
  font-size: 13px;
  line-height: 1.6;
  opacity: 0.8;
  margin-bottom: 20px;
}

.bc-platform-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: 8px;
  margin-bottom: 20px;
}

.bc-platform-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 12px 8px;
  border-radius: 10px;
  border: 2px solid var(--line, rgba(255,255,255,0.1));
  background: transparent;
  color: var(--text, #e8eaed);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: border-color 0.15s, background 0.15s;
}

.bc-platform-btn:hover { background: var(--panel-2, rgba(255,255,255,0.05)); }
.bc-platform-btn.selected { background: var(--panel-2, rgba(255,255,255,0.06)); }
.bc-platform-label { line-height: 1.2; text-align: center; }

.bc-field { margin-bottom: 16px; }

.bc-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
  opacity: 0.9;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.bc-required { color: #f87171; margin-left: 2px; }
.bc-optional { font-weight: 400; opacity: 0.55; text-transform: none; letter-spacing: 0; }

.bc-input {
  width: 100%;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--line, rgba(255,255,255,0.15));
  background: var(--panel-2, rgba(255,255,255,0.04));
  color: var(--text, #e8eaed);
  font-size: 14px;
  box-sizing: border-box;
  outline: none;
  transition: border-color 0.15s;
}

.bc-input:focus { border-color: #3b82f6; }
.bc-field-hint { font-size: 11px; opacity: 0.55; margin: 4px 0 0; }

.bc-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 24px;
}

.bc-status-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 32px 16px;
  gap: 12px;
}

.bc-status-text { font-size: 16px; font-weight: 600; margin: 0; }

.bc-status-sub {
  font-size: 13px;
  opacity: 0.75;
  margin: 0;
  max-width: 360px;
}

.bc-success-icon { color: #46d160; }
.bc-error-icon { color: #f87171; }

.bc-install-hint {
  font-size: 12px;
  opacity: 0.7;
  background: var(--panel-2, rgba(255,255,255,0.05));
  border-radius: 8px;
  padding: 10px 14px;
  font-family: ui-monospace, monospace;
  margin: 0;
}

.bc-spinner {
  width: 36px;
  height: 36px;
  border: 3px solid var(--line, rgba(255,255,255,0.12));
  border-top-color: #3b82f6;
  border-radius: 50%;
  animation: bc-spin 0.7s linear infinite;
}

@keyframes bc-spin { to { transform: rotate(360deg); } }

.bc-waiting {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 20px 0;
  text-align: center;
}

.bc-waiting-icon {
  width: 64px;
  height: 64px;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.bc-waiting-title { font-size: 17px; font-weight: 600; margin: 0; }
.bc-waiting-body { font-size: 14px; line-height: 1.6; opacity: 0.85; max-width: 380px; margin: 0; }
.bc-waiting-note { font-size: 12px; opacity: 0.55; max-width: 340px; margin: 0; }
</style>
