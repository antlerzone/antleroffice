<script setup lang="ts">
/**
 * NpcOnboardingWizard — shown immediately after a new NPC is hired.
 *
 * Phases:
 *   intro  → personality → setup steps (0…n) → done
 *
 * All setup steps are defined in src/lib/npc-onboarding-configs.ts.
 * No code changes needed here when adding a new NPC — just update the configs file.
 */
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useBossStore } from '@/stores/boss'
import {
  getNpcOnboardingConfig,
  buildPersonalityPool,
  rollPersonality,
  type NpcOnboardingConfig,
  type OnboardingStep,
  type PersonalityTrait,
} from '@/lib/npc-onboarding-configs'

// ── Bundle required accounts (data-driven, from skill JSONs) ──────────────────

interface RequiredAccountField {
  key: string
  /** i18n key (preferred) — e.g. "npcOnboarding.field.username" */
  labelKey?: string
  /** Fallback plain label if no labelKey */
  label?: string
  type: 'text' | 'password'
  placeholder?: string
}

interface RequiredAccount {
  alias: string
  label: string
  websiteUrl?: string
  optional?: boolean
  fields?: RequiredAccountField[]
}

const bundleRequiredAccounts = ref<RequiredAccount[]>([])

// ── Props / Emits ─────────────────────────────────────────────────────────────

const props = defineProps<{
  show: boolean
  templateId: string
  agentName: string
  agentRole?: string
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  done: []
}>()

// ── API / i18n ────────────────────────────────────────────────────────────────

const { t } = useI18n()
const api = useAntlerApi()
const boss = useBossStore()

function authHeaders(): Record<string, string> {
  return boss.token
    ? { 'X-Boss-Token': boss.token, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' }
}

// ── State ─────────────────────────────────────────────────────────────────────

type Phase = 'intro' | 'personality' | 'setup' | 'done'
const phase = ref<Phase>('intro')
const setupStepIndex = ref(0)

// Personality
const personalityPool = ref<PersonalityTrait[]>([])
const pickedPersonality = ref<PersonalityTrait[]>([])

// Step answers: stepId → chosen value
const answers = ref<Record<string, string>>({})

// Credential fields: fieldKey → value
const credFields = ref<Record<string, string>>({})
const credSaving = ref(false)
const credError = ref('')
const credSaved = ref(false) // current credential step saved successfully

// Browser-capture
const captureSessionId = ref('')
const captureLoading = ref(false)
const captureWaiting = ref(false)
const captureFinishing = ref(false)
const captureError = ref('')
const captureDone = ref(false)

// ── Config ────────────────────────────────────────────────────────────────────

const config = computed<NpcOnboardingConfig | null>(() =>
  getNpcOnboardingConfig(props.templateId),
)

/** Resolve a field label: use i18n key if present, fall back to plain label */
function resolveFieldLabel(field: RequiredAccountField): string {
  if (field.labelKey) {
    const translated = t(field.labelKey)
    // If translation key isn't found, vue-i18n returns the key itself — use fallback label then
    if (translated !== field.labelKey) return translated
  }
  return field.label ?? field.key
}

/** Auto-generate api_credentials steps from requiredAccounts declared in skill JSONs */
const autoAccountSteps = computed<OnboardingStep[]>(() =>
  bundleRequiredAccounts.value.map((acct) => ({
    id: `_acct_${acct.alias}`,
    type: 'api_credentials' as const,
    title: t('npcOnboarding.accountSetup.title', { label: acct.label }),
    hint: t('npcOnboarding.accountSetup.hint', { label: acct.label }),
    credentialWebsite: acct.alias,
    credentialWebsiteUrl: acct.websiteUrl,
    optional: acct.optional ?? true,
    fields: (acct.fields ?? [
      { key: 'username', labelKey: 'npcOnboarding.field.username', type: 'text' as const },
      { key: 'password', labelKey: 'npcOnboarding.field.password', type: 'password' as const },
    ]).map((f) => ({ ...f, label: resolveFieldLabel(f) })),
  })),
)

/** All steps = auto account steps first, then NPC-specific config steps */
const allSteps = computed<OnboardingStep[]>(() => [
  ...autoAccountSteps.value,
  ...(config.value?.steps ?? []),
])

const visibleSteps = computed<OnboardingStep[]>(() =>
  allSteps.value.filter((step) => isStepVisible(step)),
)

const currentStep = computed<OnboardingStep | null>(
  () => visibleSteps.value[setupStepIndex.value] ?? null,
)

const hasSetupSteps = computed(() => visibleSteps.value.length > 0)

function isStepVisible(step: OnboardingStep): boolean {
  if (!step.showWhen) return true
  const answer = answers.value[step.showWhen.stepId]
  const expected = step.showWhen.value
  if (Array.isArray(expected)) return answer != null && expected.includes(answer)
  return answer === expected
}

// ── Fetch bundle required accounts from server ────────────────────────────────

async function fetchRequiredAccounts() {
  if (!props.templateId) return
  try {
    const res = await api.send<{ manifest?: { requiredAccounts?: typeof bundleRequiredAccounts.value } }>(
      'GET',
      `/api/catalog/agents/${props.templateId}`,
    )
    bundleRequiredAccounts.value = res?.manifest?.requiredAccounts ?? []
  } catch {
    bundleRequiredAccounts.value = []
  }
}

onMounted(() => {
  fetchRequiredAccounts()
})

// ── Reset on open ─────────────────────────────────────────────────────────────

watch(
  () => props.show,
  (open) => {
    if (!open) return
    phase.value = 'intro'
    setupStepIndex.value = 0
    answers.value = {}
    credFields.value = {}
    credSaving.value = false
    credError.value = ''
    credSaved.value = false
    captureSessionId.value = ''
    captureLoading.value = false
    captureWaiting.value = false
    captureFinishing.value = false
    captureError.value = ''
    captureDone.value = false
    // Refresh required accounts each time wizard opens (bundle may have updated)
    fetchRequiredAccounts()

    if (config.value) {
      const pool = buildPersonalityPool(config.value)
      personalityPool.value = pool
      pickedPersonality.value = rollPersonality(pool, 3)
    }
  },
)

// Watch visibleSteps to recalculate when answers change step visibility
watch(answers, () => {
  // If current step index is now out of range, move forward
  if (phase.value === 'setup' && setupStepIndex.value >= visibleSteps.value.length) {
    completeDone()
  }
}, { deep: true })

// ── Navigation ────────────────────────────────────────────────────────────────

function toPersonality() {
  phase.value = 'personality'
}

function toSetup() {
  if (!hasSetupSteps.value) {
    completeDone()
    return
  }
  setupStepIndex.value = 0
  resetCurrentStepState()
  phase.value = 'setup'
}

function nextSetupStep() {
  if (setupStepIndex.value < visibleSteps.value.length - 1) {
    setupStepIndex.value++
    resetCurrentStepState()
  } else {
    completeDone()
  }
}

async function applyCtoServerChoice() {
  // CTO onboarding: if boss chose to enable SSH, flip gate 1 on. Host/user and
  // per-action approval are handled later (Settings or COO chat).
  if (props.templateId !== 'cto') return
  if (answers.value['enable_ssh'] !== 'yes') return
  try {
    await fetch('/api/dev/settings', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ serverAccess: { sshEnabled: true } }),
    })
  } catch {
    /* non-fatal */
  }
}

async function applyCodingLevelChoice() {
  // Save the CEO's own coding-comprehension level (asked on any IT-role onboarding).
  // Stored globally as dev.ceoCodingLevel so every COO→CEO report adapts to it.
  const level = answers.value['coding_level']
  if (!level) return
  try {
    await fetch('/api/dev/settings', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ ceoCodingLevel: level }),
    })
  } catch {
    /* non-fatal */
  }
}

function completeDone() {
  // Cancel any open browser session
  if (captureSessionId.value) {
    cancelCapture().catch(() => {})
    captureSessionId.value = ''
  }
  void applyCtoServerChoice()
  void applyCodingLevelChoice()
  phase.value = 'done'
}

function resetCurrentStepState() {
  credFields.value = {}
  credError.value = ''
  credSaved.value = false
  captureSessionId.value = ''
  captureLoading.value = false
  captureWaiting.value = false
  captureFinishing.value = false
  captureError.value = ''
  captureDone.value = false
}

function close() {
  if (captureSessionId.value) {
    cancelCapture().catch(() => {})
    captureSessionId.value = ''
  }
  emit('update:show', false)
  if (phase.value === 'done') emit('done')
}

function finishAndClose() {
  emit('update:show', false)
  emit('done')
}

// ── Personality ───────────────────────────────────────────────────────────────

function reroll() {
  pickedPersonality.value = rollPersonality(personalityPool.value, 3)
}

// ── Choice steps ──────────────────────────────────────────────────────────────

function selectChoice(stepId: string, value: string) {
  answers.value = { ...answers.value, [stepId]: value }
}

function choiceSelected(stepId: string, value: string) {
  return answers.value[stepId] === value
}

// ── API Credential steps ──────────────────────────────────────────────────────

async function saveCredentials() {
  const step = currentStep.value
  if (!step || step.type !== 'api_credentials') return

  credError.value = ''
  const username = String(credFields.value['username'] ?? '').trim()
  const password = String(credFields.value['password'] ?? '').trim()

  // Validate required fields
  for (const field of step.fields ?? []) {
    const val = String(credFields.value[field.key] ?? '').trim()
    if (!val) {
      credError.value = `请填写「${field.label}」`
      return
    }
  }

  credSaving.value = true
  try {
    // Build display name from agent name + website
    const displayName = `${props.agentName} — ${step.credentialWebsite ?? 'account'}`
    const websiteUrl = step.credentialWebsiteUrl
      ? step.credentialWebsiteUrl.replace('{username}', username)
      : ''

    const acctRes = await api.send<{ account?: { alias?: string } }>('POST', '/api/accounts', {
      displayName,
      username,
      password,
      website: step.credentialWebsite ?? props.templateId,
      websiteUrl,
    })

    // If this step also registers an MCP, call mcp-pack/apply with the mapped params
    if (step.mcpApplyParams && Object.keys(step.mcpApplyParams).length > 0) {
      const applyBody: Record<string, string | boolean> = {}
      for (const [fieldKey, bodyKey] of Object.entries(step.mcpApplyParams)) {
        if (fieldKey.startsWith('_')) {
          // Literal value: key is '_paramName', value is the literal string
          applyBody[bodyKey] = fieldKey === '_enableGraphicDesign' ? true : String(step.mcpApplyParams[fieldKey])
        } else {
          applyBody[bodyKey] = String(credFields.value[fieldKey] ?? '').trim()
        }
      }
      // enableGraphicDesign special case: if body param is 'glifApiKey', set enableGraphicDesign too
      if ('glifApiKey' in applyBody) applyBody.enableGraphicDesign = true
      await fetch('/api/onboard/mcp-pack/apply', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(applyBody),
      })
    }

    // 候选 MCP：只装用户选中的那一个，并绑定到本 NPC（token 在后端解密、不经过 AI）
    if (step.installsMcp) {
      await fetch('/api/onboard/mcp/install', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          templateId: props.templateId,
          slug: step.installsMcp,
          accountAlias: acctRes?.account?.alias || step.credentialWebsite || '',
        }),
      })
    }

    credSaved.value = true
  } catch (e) {
    credError.value = e instanceof Error ? e.message : '保存失败，请重试'
  } finally {
    credSaving.value = false
  }
}

// ── Browser-capture steps ─────────────────────────────────────────────────────

async function openBrowser() {
  const step = currentStep.value
  if (!step || step.type !== 'browser_login') return

  captureLoading.value = true
  captureError.value = ''
  try {
    const res = await fetch('/api/accounts/browser-capture/start', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        url: step.platformUrl ?? 'https://www.google.com',
        website: step.platform ?? 'unknown',
        displayName: `${props.agentName} — ${step.platform}`,
        allowedActions: [],
      }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || '无法打开浏览器')
    captureSessionId.value = data.sessionId
    captureWaiting.value = true
  } catch (e) {
    captureError.value = e instanceof Error ? e.message : '出错了，请重试'
  } finally {
    captureLoading.value = false
  }
}

async function finishCapture() {
  if (!captureSessionId.value) return
  captureFinishing.value = true
  captureError.value = ''
  try {
    const res = await fetch(`/api/accounts/browser-capture/${captureSessionId.value}/finish`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || '保存失败')
    captureSessionId.value = ''
    captureWaiting.value = false
    captureDone.value = true
  } catch (e) {
    captureError.value = e instanceof Error ? e.message : '保存失败，请重试'
  } finally {
    captureFinishing.value = false
  }
}

async function cancelCapture() {
  const sid = captureSessionId.value
  if (!sid) return
  captureSessionId.value = ''
  captureWaiting.value = false
  await fetch(`/api/accounts/browser-capture/${sid}`, {
    method: 'DELETE',
    headers: authHeaders(),
  }).catch(() => {})
}

// ── Tutorial panel ────────────────────────────────────────────────────────────

const tutorialOpen = ref(false)
function toggleTutorial() {
  tutorialOpen.value = !tutorialOpen.value
}

// ── Computed helpers ──────────────────────────────────────────────────────────

const isLastStep = computed(
  () => setupStepIndex.value >= visibleSteps.value.length - 1,
)

const currentStepCanProceed = computed(() => {
  const step = currentStep.value
  if (!step) return true
  if (step.optional) return true
  if (step.type === 'choice') return !!answers.value[step.id]
  if (step.type === 'api_credentials') return credSaved.value
  if (step.type === 'browser_login') return captureDone.value
  return true
})
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="now-backdrop" @click.self="close">
      <div class="now-modal">

        <!-- ── INTRO ─────────────────────────────────────────────── -->
        <template v-if="phase === 'intro'">
          <div class="now-intro">
            <div class="now-avatar">{{ config?.greeting.slice(0, 2) ?? '👤' }}</div>
            <h2 class="now-hello">你好，老板！</h2>
            <p class="now-name-line">我是 <strong>{{ agentName }}</strong></p>
            <p class="now-greeting-text">{{ config?.greeting ?? '很高兴加入您的团队！' }}</p>
          </div>
          <div class="now-actions">
            <button class="now-btn ghost" @click="close">稍后再说</button>
            <button class="now-btn primary" @click="toPersonality">开始 →</button>
          </div>
        </template>

        <!-- ── PERSONALITY ───────────────────────────────────────── -->
        <template v-else-if="phase === 'personality'">
          <h3 class="now-step-title">您希望我是什么样的助手？</h3>
          <p class="now-step-hint">随机给您推荐了 3 个性格，不满意可以重新抽</p>

          <div class="now-trait-list">
            <div
              v-for="trait in pickedPersonality"
              :key="trait.id"
              class="now-trait-card"
            >
              <span class="now-trait-emoji">{{ trait.emoji }}</span>
              <span class="now-trait-label">{{ trait.label }}</span>
            </div>
          </div>

          <button class="now-btn ghost reroll-btn" @click="reroll">🎲 换一套性格</button>

          <div class="now-actions">
            <button class="now-btn ghost" @click="phase = 'intro'">← 返回</button>
            <button class="now-btn primary" @click="toSetup">好的，就这样！</button>
          </div>
        </template>

        <!-- ── SETUP STEPS ───────────────────────────────────────── -->
        <template v-else-if="phase === 'setup' && currentStep">

          <!-- Choice step -->
          <template v-if="currentStep.type === 'choice'">
            <h3 class="now-step-title">{{ currentStep.question }}</h3>
            <p v-if="currentStep.hint" class="now-step-hint">{{ currentStep.hint }}</p>
            <div class="now-choice-grid">
              <button
                v-for="opt in currentStep.options"
                :key="opt.value"
                class="now-choice-btn"
                :class="{ selected: choiceSelected(currentStep.id, opt.value) }"
                @click="selectChoice(currentStep.id, opt.value)"
              >
                <span v-if="opt.emoji" class="now-choice-emoji">{{ opt.emoji }}</span>
                <span class="now-choice-label">{{ opt.label }}</span>
                <span v-if="opt.hint" class="now-choice-hint">{{ opt.hint }}</span>
              </button>
            </div>
          </template>

          <!-- API Credentials step -->
          <template v-else-if="currentStep.type === 'api_credentials'">
            <h3 class="now-step-title">{{ currentStep.title }}</h3>
            <p v-if="currentStep.hint" class="now-step-hint">{{ currentStep.hint }}</p>

            <div v-if="credSaved" class="now-cred-saved">
              {{ t('npcOnboarding.accountSetup.connected') }}
            </div>
            <template v-else>
              <div
                v-for="field in currentStep.fields"
                :key="field.key"
                class="now-field"
              >
                <label class="now-field-label">{{ field.label }}</label>
                <div class="now-field-wrap">
                  <span v-if="field.prefix" class="now-field-affix">{{ field.prefix }}</span>
                  <input
                    v-model="credFields[field.key]"
                    :type="field.type"
                    :placeholder="field.placeholder"
                    class="now-input"
                    :class="{ 'has-suffix': !!field.suffix, 'has-prefix': !!field.prefix }"
                    autocomplete="off"
                  />
                  <span v-if="field.suffix" class="now-field-affix suffix">{{ field.suffix }}</span>
                </div>
                <p v-if="field.hint" class="now-field-hint">{{ field.hint }}</p>
              </div>

              <div v-if="credError" class="now-error">{{ credError }}</div>

              <!-- Tutorial accordion -->
              <div v-if="currentStep.tutorialSteps?.length" class="now-tutorial">
                <button class="now-tutorial-toggle" @click="toggleTutorial">
                  {{ tutorialOpen ? '▲' : '▼' }} 不知道在哪里找？点击查看步骤
                </button>
                <div v-if="tutorialOpen" class="now-tutorial-body">
                  <div
                    v-for="(step, i) in currentStep.tutorialSteps"
                    :key="i"
                    class="now-tutorial-step"
                  >
                    <span class="now-tutorial-num">{{ i + 1 }}</span>
                    <span>{{ step }}</span>
                  </div>
                </div>
              </div>

              <button
                class="now-btn primary connect-btn"
                :disabled="credSaving"
                @click="saveCredentials"
              >
                {{ credSaving ? t('npcOnboarding.accountSetup.connecting') : t('npcOnboarding.accountSetup.connect') }}
              </button>
            </template>
          </template>

          <!-- Browser Login step -->
          <template v-else-if="currentStep.type === 'browser_login'">
            <h3 class="now-step-title">{{ currentStep.title }}</h3>

            <div v-if="captureDone" class="now-cred-saved">
              ✅ 账号已连接成功！
            </div>
            <template v-else-if="captureWaiting">
              <div class="now-waiting">
                <div class="now-waiting-icon">🌐</div>
                <p class="now-waiting-text">Chrome 已打开</p>
                <p class="now-waiting-sub">在浏览器里登录，完成后回来点「已登录」</p>
              </div>
              <div v-if="captureError" class="now-error">{{ captureError }}</div>
              <div class="now-actions">
                <button class="now-btn ghost" @click="cancelCapture">取消</button>
                <button class="now-btn primary" :disabled="captureFinishing" @click="finishCapture">
                  {{ captureFinishing ? '保存中…' : '✓ 已登录' }}
                </button>
              </div>
            </template>
            <template v-else>
              <p class="now-step-hint" style="white-space: pre-line">{{ currentStep.question }}</p>
              <div v-if="captureError" class="now-error">{{ captureError }}</div>
              <button class="now-btn primary connect-btn" :disabled="captureLoading" @click="openBrowser">
                {{ captureLoading ? '正在打开…' : '打开浏览器登录' }}
              </button>
            </template>
          </template>

          <!-- Info step -->
          <template v-else-if="currentStep.type === 'info'">
            <h3 class="now-step-title">{{ currentStep.title }}</h3>
            <p class="now-step-hint">{{ currentStep.hint }}</p>
          </template>

          <!-- Step navigation -->
          <div class="now-actions" v-if="!(currentStep.type === 'browser_login' && captureWaiting)">
            <button
              v-if="currentStep.optional"
              class="now-btn ghost"
              @click="nextSetupStep"
            >
              跳过
            </button>
            <button
              class="now-btn primary"
              :disabled="!currentStepCanProceed"
              @click="nextSetupStep"
            >
              {{ isLastStep ? '完成设置' : '继续 →' }}
            </button>
          </div>

          <!-- Step progress dots -->
          <div class="now-progress">
            <div
              v-for="(_, i) in visibleSteps"
              :key="i"
              class="now-dot"
              :class="{ active: i === setupStepIndex, done: i < setupStepIndex }"
            />
          </div>
        </template>

        <!-- ── DONE ──────────────────────────────────────────────── -->
        <template v-else-if="phase === 'done'">
          <div class="now-done">
            <div class="now-done-icon">🎉</div>
            <h2 class="now-done-title">{{ agentName }} 准备好了！</h2>

            <div v-if="config?.capabilities?.length" class="now-capabilities">
              <p class="now-cap-label">我可以帮您：</p>
              <ul class="now-cap-list">
                <li v-for="cap in config.capabilities" :key="cap">{{ cap }}</li>
              </ul>
            </div>

            <div v-if="config?.completionHint" class="now-hint-box">
              <p class="now-hint-box-label">怎么叫我？</p>
              <p class="now-hint-box-text">{{ config.completionHint }}</p>
            </div>
          </div>
          <div class="now-actions">
            <button class="now-btn primary" @click="finishAndClose">开始工作！</button>
          </div>
        </template>

      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ── Backdrop ── */
.now-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  padding: 16px;
}

/* ── Modal ── */
.now-modal {
  background: var(--panel, #1d2130);
  border: 1px solid var(--line, rgba(255,255,255,0.1));
  border-radius: 20px;
  width: min(480px, 100%);
  max-height: 88vh;
  overflow-y: auto;
  padding: 32px 28px 24px;
  box-shadow: 0 32px 80px rgba(0,0,0,0.6);
  display: flex;
  flex-direction: column;
  gap: 0;
}

/* ── Intro ── */
.now-intro {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 8px;
  padding-bottom: 20px;
}

.now-avatar {
  font-size: 48px;
  line-height: 1;
  margin-bottom: 4px;
}

.now-hello {
  font-size: 22px;
  font-weight: 700;
  margin: 0;
}

.now-name-line {
  font-size: 15px;
  margin: 0;
  opacity: 0.8;
}

.now-greeting-text {
  font-size: 14px;
  line-height: 1.7;
  opacity: 0.75;
  max-width: 360px;
  margin: 6px 0 0;
}

/* ── Step ── */
.now-step-title {
  font-size: 17px;
  font-weight: 600;
  margin: 0 0 6px;
}

.now-step-hint {
  font-size: 13px;
  line-height: 1.6;
  opacity: 0.7;
  margin: 0 0 18px;
}

/* ── Personality ── */
.now-trait-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 16px;
}

.now-trait-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 12px;
  background: var(--panel-2, rgba(255,255,255,0.05));
  border: 1px solid var(--line, rgba(255,255,255,0.1));
}

.now-trait-emoji {
  font-size: 22px;
  line-height: 1;
  flex-shrink: 0;
}

.now-trait-label {
  font-size: 15px;
  font-weight: 500;
}

.reroll-btn {
  width: 100%;
  margin-bottom: 20px;
  font-size: 14px;
}

/* ── Choice grid ── */
.now-choice-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 8px;
  margin-bottom: 20px;
}

.now-choice-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 12px 8px;
  border-radius: 12px;
  border: 2px solid var(--line, rgba(255,255,255,0.1));
  background: transparent;
  color: var(--text, #e8eaed);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  text-align: center;
}

.now-choice-btn:hover {
  background: var(--panel-2, rgba(255,255,255,0.04));
}

.now-choice-btn.selected {
  border-color: #3b82f6;
  background: rgba(59, 130, 246, 0.1);
}

.now-choice-emoji {
  font-size: 22px;
  line-height: 1;
}

.now-choice-label {
  font-size: 13px;
  font-weight: 500;
}

.now-choice-hint {
  font-size: 11px;
  opacity: 0.55;
  line-height: 1.3;
}

/* ── Fields ── */
.now-field {
  margin-bottom: 14px;
}

.now-field-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.85;
  margin-bottom: 6px;
}

.now-field-wrap {
  display: flex;
  align-items: center;
  border: 1px solid var(--line, rgba(255,255,255,0.15));
  border-radius: 8px;
  background: var(--panel-2, rgba(255,255,255,0.04));
  overflow: hidden;
}

.now-field-affix {
  padding: 0 10px;
  font-size: 13px;
  opacity: 0.6;
  white-space: nowrap;
  flex-shrink: 0;
  background: var(--panel, rgba(255,255,255,0.03));
  height: 40px;
  display: flex;
  align-items: center;
}

.now-field-affix.suffix {
  border-left: 1px solid var(--line, rgba(255,255,255,0.1));
}

.now-input {
  flex: 1;
  padding: 10px 12px;
  background: transparent;
  border: none;
  color: var(--text, #e8eaed);
  font-size: 14px;
  outline: none;
  min-width: 0;
}

.now-field-hint {
  font-size: 11px;
  opacity: 0.55;
  margin: 4px 0 0;
  line-height: 1.4;
}

/* ── Tutorial ── */
.now-tutorial {
  margin-bottom: 16px;
}

.now-tutorial-toggle {
  font-size: 12px;
  color: #60a5fa;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
}

.now-tutorial-body {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--panel-2, rgba(255,255,255,0.04));
  border-radius: 8px;
}

.now-tutorial-step {
  display: flex;
  gap: 10px;
  font-size: 13px;
  line-height: 1.5;
}

.now-tutorial-num {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #3b82f6;
  color: white;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 1px;
}

/* ── Credential saved / Error ── */
.now-cred-saved {
  padding: 14px 16px;
  background: rgba(70, 209, 96, 0.12);
  border: 1px solid rgba(70, 209, 96, 0.3);
  border-radius: 10px;
  color: #46d160;
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 16px;
}

.now-error {
  padding: 10px 14px;
  background: rgba(248, 113, 113, 0.1);
  border: 1px solid rgba(248, 113, 113, 0.3);
  border-radius: 8px;
  color: #f87171;
  font-size: 13px;
  margin-bottom: 12px;
}

/* ── Browser waiting ── */
.now-waiting {
  text-align: center;
  padding: 20px 0 16px;
}

.now-waiting-icon {
  font-size: 36px;
  margin-bottom: 10px;
}

.now-waiting-text {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 6px;
}

.now-waiting-sub {
  font-size: 13px;
  opacity: 0.7;
  margin: 0;
}

/* ── Progress dots ── */
.now-progress {
  display: flex;
  justify-content: center;
  gap: 6px;
  margin-top: 20px;
}

.now-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--line, rgba(255,255,255,0.2));
  transition: background 0.2s;
}

.now-dot.active {
  background: #3b82f6;
  width: 18px;
  border-radius: 3px;
}

.now-dot.done {
  background: #46d160;
}

/* ── Done screen ── */
.now-done {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 12px;
  padding-bottom: 8px;
}

.now-done-icon {
  font-size: 52px;
  line-height: 1;
}

.now-done-title {
  font-size: 20px;
  font-weight: 700;
  margin: 0;
}

.now-capabilities {
  text-align: left;
  width: 100%;
  background: var(--panel-2, rgba(255,255,255,0.04));
  border-radius: 12px;
  padding: 14px 16px;
}

.now-cap-label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.6;
  margin: 0 0 8px;
}

.now-cap-list {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.now-cap-list li {
  font-size: 14px;
  line-height: 1.5;
  opacity: 0.85;
}

.now-hint-box {
  width: 100%;
  background: rgba(59, 130, 246, 0.08);
  border: 1px solid rgba(59, 130, 246, 0.25);
  border-radius: 12px;
  padding: 14px 16px;
  text-align: left;
}

.now-hint-box-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #60a5fa;
  margin: 0 0 6px;
}

.now-hint-box-text {
  font-size: 14px;
  line-height: 1.6;
  margin: 0;
  opacity: 0.9;
}

/* ── Actions ── */
.now-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 24px;
}

.now-btn {
  padding: 10px 20px;
  border-radius: 8px;
  border: none;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s, background 0.15s;
  font-family: inherit;
}

.now-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.now-btn.primary {
  background: #3b82f6;
  color: #fff;
}

.now-btn.primary:not(:disabled):hover {
  background: #2563eb;
}

.now-btn.ghost {
  background: var(--panel-2, rgba(255,255,255,0.06));
  color: var(--text, #e8eaed);
  border: 1px solid var(--line, rgba(255,255,255,0.12));
}

.now-btn.ghost:hover {
  background: var(--panel-2, rgba(255,255,255,0.1));
}

.connect-btn {
  width: 100%;
  margin-top: 4px;
}
</style>
