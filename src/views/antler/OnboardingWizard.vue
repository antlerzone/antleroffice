<script setup lang="ts">
/**
 * OnboardingWizard — first-run setup for new AntlerOffice users.
 *
 * Steps:
 *   0  language      — pick UI language (applies immediately)
 *   1  welcome       — animated greeting
 *   2  desktop_name  — name this desktop (one user can have multiple)
 *   3  industry      — 8-option grid
 *   4  size          — 4-option list
 *   5  goals         — multi-select grid
 *   6  boss_style    — 4-option list
 *   7  ai_key        — connect AI model
 *   8  voice         — optional CosyVoice install (GPU check + progress)
 *   9  done          — recommended NPCs
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NModal, NButton, NInput, NText, NProgress, useMessage } from 'naive-ui'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useAiSetupStore } from '@/stores/aiSetup'
import { useLocaleStore } from '@/stores/locale'
import { AI_PROVIDERS, aiProviderOptions } from '@/lib/ai-providers'
import type { AppLocale } from '@/i18n/locale'
import { getStoredLocale } from '@/i18n/locale'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'done'): void }>()

const api = useAntlerApi()
const message = useMessage()
const aiSetup = useAiSetupStore()
const localeStore = useLocaleStore()
const { t } = useI18n()

// ── Steps ────────────────────────────────────────────────────────────────────
const STEPS = [
  'language', 'welcome', 'desktop_name', 'industry', 'size',
  'goals', 'boss_style', 'ai_key', 'voice', 'done',
] as const
type Step = typeof STEPS[number]
const stepIndex = ref(0)
const currentStep = computed<Step>(() => STEPS[stepIndex.value])

// ── Profile ───────────────────────────────────────────────────────────────────
const desktopName = ref('')
const language = ref('')
const industry = ref('')
const size = ref('')
const goals = ref<string[]>([])
const bossStyle = ref('')

// ── Language options (always shown in their own language) ─────────────────────
const languageOptions = [
  { value: 'zh-CN', appLocale: 'zh-CN' as AppLocale, label: '简体中文', sub: '中国大陆' },
  { value: 'zh-TW', appLocale: 'zh-CN' as AppLocale, label: '繁體中文', sub: '台湾、香港、澳門' },
  { value: 'en',    appLocale: 'en-US' as AppLocale, label: 'English',  sub: 'English interface' },
  { value: 'ms',    appLocale: 'en-US' as AppLocale, label: 'Bahasa Melayu', sub: 'Malaysia / Brunei' },
]

function pickLanguage(opt: typeof languageOptions[number]) {
  language.value = opt.value
  localeStore.setLocale(opt.appLocale, true)
  stepIndex.value++
}

// ── AI key ───────────────────────────────────────────────────────────────────
const provider = ref('openai')
const apiKey = ref('')
const model = ref('')
const models = ref<{ label: string; value: string }[]>([])
const loadingModels = ref(false)
const savingKey = ref(false)
const aiProviders = aiProviderOptions()

const modelOptions = computed(() => {
  const prefix = `${provider.value}/`
  const filtered = models.value.filter((m) => m.value.startsWith(prefix))
  return filtered.length ? filtered : models.value
})

async function loadModels() {
  loadingModels.value = true
  try {
    const st = await api.get<{ available: boolean; models?: { model?: string } }>('/api/openclaw/status')
    if (st.models?.model) model.value = st.models.model
    const ml = await api.get<{ models: { key: string; name: string; available: boolean }[] }>(
      '/api/openclaw/models?all=1',
    )
    models.value = (ml.models || []).map((m) => ({ label: m.name || m.key, value: m.key }))
    if (!model.value && modelOptions.value.length) {
      const preset = AI_PROVIDERS.find((p) => p.id === provider.value)
      model.value =
        modelOptions.value.find((m) => m.value === preset?.defaultModel)?.value ||
        modelOptions.value.find((m) => m.value.startsWith(`${provider.value}/`))?.value ||
        modelOptions.value[0].value
    }
  } catch {
    models.value = []
  } finally {
    loadingModels.value = false
  }
}

watch(provider, () => {
  const match = modelOptions.value.find((m) => m.value.startsWith(`${provider.value}/`))
  if (match) model.value = match.value
})

// ── Voice / CosyVoice ────────────────────────────────────────────────────────
type VoiceSetupPhase =
  | 'idle' | 'checking' | 'no_gpu' | 'ready_to_install'
  | 'installing' | 'running' | 'failed' | 'skipped'

const voicePhase = ref<VoiceSetupPhase>('checking')
const voiceGpuOk = ref(false)
const voiceGpuVram = ref<number | null>(null)
const voiceSetupMsg = ref('')
const voiceSetupError = ref('')
const voiceProgress = ref(0)
let voicePollTimer: ReturnType<typeof setInterval> | null = null

const PHASE_LABELS: Record<string, string> = {
  idle: '准备中…',
  checking: '检测中…',
  cloning_repo: '下载声音引擎…',
  installing_deps: '安装依赖包…',
  downloading_model: '下载 AI 声音模型…',
  starting: '启动中…',
  running: '已就绪 ✓',
  failed: '安装失败',
}

const PHASE_PROGRESS: Record<string, number> = {
  idle: 0,
  cloning_repo: 20,
  installing_deps: 50,
  downloading_model: 75,
  starting: 90,
  running: 100,
}

async function checkVoiceRequirements() {
  voicePhase.value = 'checking'
  try {
    const st = await api.get<{
      gpu?: { meetsRequirements?: boolean; vramMb?: number | null; reason?: string }
      setup?: { phase?: string; message?: string }
    }>('/api/voice/status')
    voiceGpuOk.value = !!st.gpu?.meetsRequirements
    voiceGpuVram.value = st.gpu?.vramMb ?? null
    if (!voiceGpuOk.value) {
      voicePhase.value = 'no_gpu'
      return
    }
    const phase = st.setup?.phase || 'idle'
    if (phase === 'running') {
      voicePhase.value = 'running'
      voiceProgress.value = 100
    } else if (phase === 'failed') {
      voicePhase.value = 'failed'
      voiceSetupError.value = st.setup?.message || t('onboarding.voice.failedWarn')
    } else if (['cloning_repo', 'installing_deps', 'downloading_model', 'starting'].includes(phase)) {
      voicePhase.value = 'installing'
      voiceProgress.value = PHASE_PROGRESS[phase] || 10
      startVoicePolling()
    } else {
      voicePhase.value = 'ready_to_install'
    }
  } catch {
    voicePhase.value = 'ready_to_install'
  }
}

async function startVoiceInstall() {
  voicePhase.value = 'installing'
  voiceProgress.value = 5
  voiceSetupMsg.value = t('onboarding.voice.installingSubtitle')
  try {
    await api.send('POST', '/api/voice/setup/start', {})
    startVoicePolling()
  } catch (e) {
    voicePhase.value = 'failed'
    voiceSetupError.value = e instanceof Error ? e.message : t('onboarding.voice.failedWarn')
  }
}

function startVoicePolling() {
  stopVoicePolling()
  voicePollTimer = setInterval(async () => {
    try {
      const s = await api.get<{ phase?: string; message?: string; error?: string | null }>(
        '/api/voice/setup',
      )
      const phase = s.phase || 'idle'
      voiceSetupMsg.value = PHASE_LABELS[phase] || s.message || ''
      voiceProgress.value = PHASE_PROGRESS[phase] ?? voiceProgress.value
      if (phase === 'running') {
        voicePhase.value = 'running'
        voiceProgress.value = 100
        stopVoicePolling()
      } else if (phase === 'failed') {
        voicePhase.value = 'failed'
        voiceSetupError.value = s.error || s.message || t('onboarding.voice.failedWarn')
        stopVoicePolling()
      }
    } catch { /* ignore poll errors */ }
  }, 3000)
}

function stopVoicePolling() {
  if (voicePollTimer) { clearInterval(voicePollTimer); voicePollTimer = null }
}

onUnmounted(stopVoicePolling)

watch(currentStep, (step) => {
  if (step === 'voice') void checkVoiceRequirements()
  else stopVoicePolling()
})

// ── Consent ──────────────────────────────────────────────────────────────────
const shareInstallData = ref(true)

// ── Navigation ───────────────────────────────────────────────────────────────
const saving = ref(false)

function canAdvance(): boolean {
  if (currentStep.value === 'language') return !!language.value
  if (currentStep.value === 'desktop_name') return desktopName.value.trim().length > 0
  if (currentStep.value === 'industry') return !!industry.value
  if (currentStep.value === 'size') return !!size.value
  if (currentStep.value === 'goals') return goals.value.length > 0
  if (currentStep.value === 'boss_style') return !!bossStyle.value
  return true
}

async function next() {
  if (!canAdvance()) return
  if (currentStep.value === 'boss_style') {
    saving.value = true
    try {
      await api.send('POST', '/api/onboard/company-profile', {
        desktopName: desktopName.value.trim(),
        language: language.value,
        industry: industry.value,
        size: size.value,
        goals: goals.value,
        bossStyle: bossStyle.value,
        shareInstallData: shareInstallData.value,
      })
    } catch { /* non-fatal */ } finally { saving.value = false }
  }
  stepIndex.value++
}

function toggleGoal(val: string) {
  const idx = goals.value.indexOf(val)
  if (idx >= 0) goals.value.splice(idx, 1)
  else goals.value.push(val)
}

async function saveAiKey() {
  const key = apiKey.value.trim()
  if (!key) { message.warning(t('onboarding.aiKey.keyPlaceholder')); return }
  savingKey.value = true
  try {
    const r = await api.send<{ ok: boolean; verified?: boolean; error?: string }>(
      'POST', '/api/onboard/openclaw-key',
      { provider: provider.value, apiKey: key, model: model.value },
    )
    if (!r.ok) throw new Error(r.error || 'Could not save key')
    apiKey.value = ''
    stepIndex.value++
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('onboarding.aiKey.saveContinue'))
  } finally { savingKey.value = false }
}

async function skipAiKey() {
  try { await api.send('POST', '/api/onboard/ai-skip', {}) } catch { /* ignore */ }
  stepIndex.value++
}

function skipVoice() {
  stopVoicePolling()
  voicePhase.value = 'skipped'
  stepIndex.value++
}

function finish() {
  stopVoicePolling()
  void api.send('POST', '/api/onboard/company-profile', {
    desktopName: desktopName.value.trim(),
    language: language.value,
    shareInstallData: shareInstallData.value,
  }).catch(() => {})
  emit('done')
  emit('close')
  aiSetup.close()
}

// ── Init ─────────────────────────────────────────────────────────────────────
watch(
  () => props.show,
  async (visible) => {
    if (visible) {
      // Skip language step when user already picked a locale in a prior session.
      stepIndex.value = getStoredLocale() ? 1 : 0
      await loadModels()
    } else {
      stopVoicePolling()
    }
  },
  { immediate: true },
)

// ── Choice data (driven by i18n) ──────────────────────────────────────────────
const industryOptions = computed(() => [
  { value: 'e-commerce', label: t('onboarding.industry.options.ecommerce.label'), sub: t('onboarding.industry.options.ecommerce.sub') },
  { value: 'fnb',        label: t('onboarding.industry.options.fnb.label'),       sub: t('onboarding.industry.options.fnb.sub') },
  { value: 'services',   label: t('onboarding.industry.options.services.label'),  sub: t('onboarding.industry.options.services.sub') },
  { value: 'retail',     label: t('onboarding.industry.options.retail.label'),    sub: t('onboarding.industry.options.retail.sub') },
  { value: 'tech',       label: t('onboarding.industry.options.tech.label'),      sub: t('onboarding.industry.options.tech.sub') },
  { value: 'education',  label: t('onboarding.industry.options.education.label'), sub: t('onboarding.industry.options.education.sub') },
  { value: 'health',     label: t('onboarding.industry.options.health.label'),    sub: t('onboarding.industry.options.health.sub') },
  { value: 'other',      label: t('onboarding.industry.options.other.label'),     sub: t('onboarding.industry.options.other.sub') },
])

const sizeOptions = computed(() => [
  { value: 'solo',   label: t('onboarding.size.options.solo.label'),   sub: t('onboarding.size.options.solo.sub') },
  { value: 'small',  label: t('onboarding.size.options.small.label'),  sub: t('onboarding.size.options.small.sub') },
  { value: 'medium', label: t('onboarding.size.options.medium.label'), sub: t('onboarding.size.options.medium.sub') },
  { value: 'large',  label: t('onboarding.size.options.large.label'),  sub: t('onboarding.size.options.large.sub') },
])

const goalOptions = computed(() => [
  { value: 'accounting',        label: t('onboarding.goals.options.accounting.label'),       sub: t('onboarding.goals.options.accounting.sub'),       npc: 'accounting_manager' },
  { value: 'marketing',         label: t('onboarding.goals.options.marketing.label'),        sub: t('onboarding.goals.options.marketing.sub'),        npc: 'marketing_manager' },
  { value: 'content',           label: t('onboarding.goals.options.content.label'),          sub: t('onboarding.goals.options.content.sub'),          npc: 'marketing_editor' },
  { value: 'sales',             label: t('onboarding.goals.options.sales.label'),            sub: t('onboarding.goals.options.sales.sub'),            npc: 'sales_senior' },
  { value: 'customer_service',  label: t('onboarding.goals.options.customer_service.label'), sub: t('onboarding.goals.options.customer_service.sub'), npc: 'customer_service_senior' },
  { value: 'admin',             label: t('onboarding.goals.options.admin.label'),            sub: t('onboarding.goals.options.admin.sub'),            npc: 'admin_manager' },
  { value: 'dev',               label: t('onboarding.goals.options.dev.label'),              sub: t('onboarding.goals.options.dev.sub'),              npc: 'it_guys' },
  { value: 'hr',                label: t('onboarding.goals.options.hr.label'),               sub: t('onboarding.goals.options.hr.sub'),               npc: 'human_resource' },
])

const bossStyleOptions = computed(() => [
  { value: 'brief',    label: t('onboarding.bossStyle.options.brief.label'),    sub: t('onboarding.bossStyle.options.brief.sub') },
  { value: 'detailed', label: t('onboarding.bossStyle.options.detailed.label'), sub: t('onboarding.bossStyle.options.detailed.sub') },
  { value: 'warm',     label: t('onboarding.bossStyle.options.warm.label'),     sub: t('onboarding.bossStyle.options.warm.sub') },
  { value: 'casual',   label: t('onboarding.bossStyle.options.casual.label'),   sub: t('onboarding.bossStyle.options.casual.sub') },
])

const recommendedNpcs = computed(() =>
  goalOptions.value.filter((g) => goals.value.includes(g.value)).slice(0, 4),
)

// progress dots cover steps 1-8 (skip language & done)
const progressSteps = ['welcome', 'desktop_name', 'industry', 'size', 'goals', 'boss_style', 'ai_key', 'voice']
const progressIndex = computed(() => progressSteps.indexOf(currentStep.value))
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    style="width: min(560px, 96vw); border-radius: 16px;"
    :mask-closable="false"
    :closable="false"
    :title="undefined"
    :segmented="false"
  >
    <!-- Progress dots (hidden on language step and done) -->
    <div v-if="progressIndex >= 0" class="progress-bar">
      <div
        v-for="(_, i) in progressSteps" :key="i"
        class="dot"
        :class="{ active: i === progressIndex, done: i < progressIndex }"
      />
    </div>

    <!-- 0: Language selection (NO progress dots, shown before welcome) -->
    <div v-if="currentStep === 'language'" class="step lang-step">
      <div class="mascot">🦌</div>
      <div class="q">{{ t('onboarding.language.title') }}</div>
      <p class="muted">{{ t('onboarding.language.subtitle') }}</p>
      <div class="list1">
        <button
          v-for="opt in languageOptions" :key="opt.value"
          class="row lang-row"
          @click="pickLanguage(opt)"
        >
          <span class="clabel">{{ opt.label }}</span>
          <span class="csub">{{ opt.sub }}</span>
        </button>
      </div>
    </div>

    <!-- 1: Welcome -->
    <div v-else-if="currentStep === 'welcome'" class="step center">
      <div class="mascot">🦌</div>
      <h2>{{ t('onboarding.welcome.title') }}</h2>
      <p class="muted">{{ t('onboarding.welcome.subtitle') }}</p>
      <NButton type="primary" size="large" style="width:100%; margin-top:8px;" @click="stepIndex++">
        {{ t('onboarding.welcome.start') }}
      </NButton>
    </div>

    <!-- 2: Desktop name -->
    <div v-else-if="currentStep === 'desktop_name'" class="step">
      <div class="q">{{ t('onboarding.desktopName.title') }}</div>
      <p class="muted">{{ t('onboarding.desktopName.subtitle') }}</p>
      <NInput
        v-model:value="desktopName"
        size="large"
        :placeholder="t('onboarding.desktopName.placeholder')"
        @keydown.enter="next"
      />
      <div class="nav">
        <NButton quaternary @click="stepIndex--">{{ t('onboarding.nav.back') }}</NButton>
        <NButton type="primary" :disabled="!canAdvance()" @click="next">{{ t('onboarding.nav.next') }}</NButton>
      </div>
    </div>

    <!-- 3: Industry -->
    <div v-else-if="currentStep === 'industry'" class="step">
      <div class="q">{{ t('onboarding.industry.title') }}</div>
      <p class="muted">{{ t('onboarding.industry.subtitle') }}</p>
      <div class="grid2">
        <button
          v-for="opt in industryOptions" :key="opt.value"
          class="card" :class="{ sel: industry === opt.value }"
          @click="industry = opt.value"
        >
          <span class="clabel">{{ opt.label }}</span>
          <span class="csub">{{ opt.sub }}</span>
        </button>
      </div>
      <div class="nav">
        <NButton quaternary @click="stepIndex--">{{ t('onboarding.nav.back') }}</NButton>
        <NButton type="primary" :disabled="!canAdvance()" @click="next">{{ t('onboarding.nav.next') }}</NButton>
      </div>
    </div>

    <!-- 4: Size -->
    <div v-else-if="currentStep === 'size'" class="step">
      <div class="q">{{ t('onboarding.size.title') }}</div>
      <p class="muted">{{ t('onboarding.size.subtitle') }}</p>
      <div class="list1">
        <button
          v-for="opt in sizeOptions" :key="opt.value"
          class="row" :class="{ sel: size === opt.value }"
          @click="size = opt.value"
        >
          <span class="clabel">{{ opt.label }}</span>
          <span class="csub">{{ opt.sub }}</span>
        </button>
      </div>
      <div class="nav">
        <NButton quaternary @click="stepIndex--">{{ t('onboarding.nav.back') }}</NButton>
        <NButton type="primary" :disabled="!canAdvance()" @click="next">{{ t('onboarding.nav.next') }}</NButton>
      </div>
    </div>

    <!-- 5: Goals (multi-select) -->
    <div v-else-if="currentStep === 'goals'" class="step">
      <div class="q">{{ t('onboarding.goals.title') }}</div>
      <p class="muted">{{ t('onboarding.goals.subtitle') }}</p>
      <div class="grid2">
        <button
          v-for="opt in goalOptions" :key="opt.value"
          class="card" :class="{ sel: goals.includes(opt.value) }"
          @click="toggleGoal(opt.value)"
        >
          <span class="clabel">{{ opt.label }}</span>
          <span class="csub">{{ opt.sub }}</span>
          <span v-if="goals.includes(opt.value)" class="chk">✓</span>
        </button>
      </div>
      <div class="nav">
        <NButton quaternary @click="stepIndex--">{{ t('onboarding.nav.back') }}</NButton>
        <NButton type="primary" :disabled="!canAdvance()" @click="next">{{ t('onboarding.nav.next') }}</NButton>
      </div>
    </div>

    <!-- 6: Boss style -->
    <div v-else-if="currentStep === 'boss_style'" class="step">
      <div class="q">{{ t('onboarding.bossStyle.title') }}</div>
      <p class="muted">{{ t('onboarding.bossStyle.subtitle') }}</p>
      <div class="list1">
        <button
          v-for="opt in bossStyleOptions" :key="opt.value"
          class="row" :class="{ sel: bossStyle === opt.value }"
          @click="bossStyle = opt.value"
        >
          <span class="clabel">{{ opt.label }}</span>
          <span class="csub">{{ opt.sub }}</span>
        </button>
      </div>
      <div class="nav">
        <NButton quaternary @click="stepIndex--">{{ t('onboarding.nav.back') }}</NButton>
        <NButton type="primary" :loading="saving" :disabled="!canAdvance()" @click="next">
          {{ t('onboarding.nav.next') }}
        </NButton>
      </div>
    </div>

    <!-- 7: AI key -->
    <div v-else-if="currentStep === 'ai_key'" class="step">
      <div class="q">{{ t('onboarding.aiKey.title') }}</div>
      <p class="muted">{{ t('onboarding.aiKey.subtitle') }}</p>
      <div class="tabs">
        <button
          v-for="p in aiProviders" :key="p.value"
          class="tab" :class="{ active: provider === p.value }"
          @click="provider = p.value"
        >{{ p.label }}</button>
      </div>
      <div v-if="modelOptions.length" class="fgroup">
        <label class="flabel">{{ t('onboarding.aiKey.modelLabel') }}</label>
        <select v-model="model" class="nsel">
          <option v-for="m in modelOptions" :key="m.value" :value="m.value">{{ m.label }}</option>
        </select>
      </div>
      <div class="fgroup">
        <label class="flabel">{{ t('onboarding.aiKey.keyLabel') }}</label>
        <NInput
          v-model:value="apiKey"
          type="password"
          :placeholder="t('onboarding.aiKey.keyPlaceholder')"
          @keydown.enter="saveAiKey"
        />
      </div>
      <NText depth="3" style="font-size:12px; line-height:1.6;">
        {{ t('onboarding.aiKey.keyNote') }}
      </NText>
      <div class="nav">
        <NButton quaternary @click="stepIndex--">{{ t('onboarding.nav.back') }}</NButton>
        <div style="display:flex; gap:8px;">
          <NButton @click="skipAiKey">{{ t('onboarding.aiKey.setupLater') }}</NButton>
          <NButton type="primary" :loading="savingKey" @click="saveAiKey">{{ t('onboarding.aiKey.saveContinue') }}</NButton>
        </div>
      </div>
    </div>

    <!-- 8: Voice / CosyVoice -->
    <div v-else-if="currentStep === 'voice'" class="step">
      <!-- Checking -->
      <template v-if="voicePhase === 'checking'">
        <div class="q">{{ t('onboarding.voice.title') }}</div>
        <p class="muted">{{ t('onboarding.voice.checking') }}</p>
        <div class="checking-spinner">⏳</div>
      </template>

      <!-- No GPU -->
      <template v-else-if="voicePhase === 'no_gpu'">
        <div class="q">{{ t('onboarding.voice.title') }}</div>
        <div class="voice-info-box warn">
          <p class="info-title">{{ t('onboarding.voice.noGpuTitle') }}</p>
          <p class="info-body">
            {{ t('onboarding.voice.noGpuBody') }}
            {{ voiceGpuVram != null
              ? t('onboarding.voice.noGpuVram', { vramMb: voiceGpuVram })
              : t('onboarding.voice.noGpuNoCard') }}
          </p>
          <p class="info-body" style="margin-top:6px;">{{ t('onboarding.voice.noGpuAlt') }}</p>
        </div>
        <div class="nav">
          <NButton quaternary @click="stepIndex--">{{ t('onboarding.nav.back') }}</NButton>
          <NButton type="primary" @click="skipVoice">{{ t('onboarding.voice.ok') }}</NButton>
        </div>
      </template>

      <!-- Ready to install -->
      <template v-else-if="voicePhase === 'ready_to_install'">
        <div class="q">{{ t('onboarding.voice.title') }}</div>
        <p class="muted">{{ t('onboarding.voice.readyTitle') }}</p>
        <div class="voice-info-box">
          <p class="info-title">{{ t('onboarding.voice.readySupported') }}</p>
          <p class="info-body">{{ t('onboarding.voice.readyBody') }}</p>
          <div class="req-list">
            <span class="req">{{ t('onboarding.voice.reqGpu', { vram: voiceGpuVram ? `(${voiceGpuVram} MB)` : '' }) }}</span>
            <span class="req">{{ t('onboarding.voice.reqPython') }}</span>
            <span class="req">{{ t('onboarding.voice.reqTime') }}</span>
          </div>
        </div>
        <div class="nav">
          <NButton quaternary @click="stepIndex--">{{ t('onboarding.nav.back') }}</NButton>
          <div style="display:flex; gap:8px;">
            <NButton @click="skipVoice">{{ t('onboarding.voice.skipLater') }}</NButton>
            <NButton type="primary" @click="startVoiceInstall">{{ t('onboarding.voice.installBtn') }}</NButton>
          </div>
        </div>
      </template>

      <!-- Installing -->
      <template v-else-if="voicePhase === 'installing'">
        <div class="q">{{ t('onboarding.voice.installingTitle') }}</div>
        <p class="muted">{{ voiceSetupMsg || t('onboarding.voice.installingSubtitle') }}</p>
        <NProgress
          type="line"
          :percentage="voiceProgress"
          :show-indicator="false"
          status="success"
          style="margin: 8px 0;"
        />
        <div class="voice-info-box">
          <p class="info-body">{{ t('onboarding.voice.installingBody') }}</p>
        </div>
        <div class="nav">
          <span />
          <NButton type="primary" @click="skipVoice">{{ t('onboarding.voice.continueBtn') }}</NButton>
        </div>
      </template>

      <!-- Running (success) -->
      <template v-else-if="voicePhase === 'running'">
        <div class="q">{{ t('onboarding.voice.runningTitle') }}</div>
        <div class="voice-info-box success">
          <p class="info-title">✅ {{ t('onboarding.voice.runningTitle') }}</p>
          <p class="info-body">{{ t('onboarding.voice.runningBody') }}</p>
        </div>
        <div class="nav">
          <span />
          <NButton type="primary" @click="stepIndex++">{{ t('onboarding.nav.next') }}</NButton>
        </div>
      </template>

      <!-- Failed -->
      <template v-else-if="voicePhase === 'failed'">
        <div class="q">{{ t('onboarding.voice.title') }}</div>
        <div class="voice-info-box warn">
          <p class="info-title">{{ t('onboarding.voice.failedWarn') }}</p>
          <p class="info-body">{{ voiceSetupError || t('onboarding.voice.failedBody') }}</p>
          <p class="info-body" style="margin-top:4px;">{{ t('onboarding.voice.failedBody') }}</p>
        </div>
        <div class="nav">
          <NButton quaternary @click="stepIndex--">{{ t('onboarding.nav.back') }}</NButton>
          <div style="display:flex; gap:8px;">
            <NButton @click="skipVoice">{{ t('onboarding.voice.skip') }}</NButton>
            <NButton type="primary" @click="startVoiceInstall">{{ t('onboarding.voice.retry') }}</NButton>
          </div>
        </div>
      </template>
    </div>

    <!-- 9: Done -->
    <div v-else-if="currentStep === 'done'" class="step center">
      <div class="mascot">🎉</div>
      <h2>{{ t('onboarding.done.title', { name: desktopName || '🦌' }) }}</h2>
      <p class="muted">{{ t('onboarding.done.subtitle') }}</p>
      <div v-if="recommendedNpcs.length" class="npc-grid">
        <div v-for="n in recommendedNpcs" :key="n.npc" class="npc-card">
          <span class="clabel">{{ n.label }}</span>
          <span class="csub">{{ n.sub }}</span>
        </div>
      </div>
      <p class="muted" style="font-size:12px;">{{ t('onboarding.done.hireHint') }}</p>

      <!-- Consent toggle -->
      <button
        class="consent-row"
        :class="{ on: shareInstallData }"
        @click="shareInstallData = !shareInstallData"
      >
        <div class="consent-toggle">
          <div class="toggle-knob" />
        </div>
        <div class="consent-text">
          <span class="consent-label">{{ t('onboarding.done.consentLabel') }}</span>
          <span class="consent-sub">{{ t('onboarding.done.consentSub') }}</span>
        </div>
      </button>

      <NButton type="primary" size="large" style="width:100%; margin-top:4px;" @click="finish">
        {{ t('onboarding.done.enter') }}
      </NButton>
    </div>
  </NModal>
</template>

<style scoped>
.step { display: flex; flex-direction: column; gap: 14px; padding: 6px 0 4px; min-height: 300px; }
.center { align-items: center; text-align: center; padding: 20px 0 12px; }
.lang-step { align-items: center; text-align: center; padding: 16px 0 8px; }
.lang-step .list1 { width: 100%; text-align: left; }
.mascot { font-size: 54px; line-height: 1; }
h2 { margin: 0; font-size: 22px; font-weight: 700; }
.muted { margin: 0; opacity: 0.65; font-size: 13px; line-height: 1.6; }

/* progress dots */
.progress-bar { display: flex; justify-content: center; gap: 8px; margin-bottom: 18px; }
.dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--n-border-color, #ddd);
  transition: background .2s, transform .2s;
}
.dot.active { background: var(--n-color-target, #4b9eff); transform: scale(1.35); }
.dot.done   { background: #52c41a; }

.q { font-size: 17px; font-weight: 700; line-height: 1.3; }

/* grid / list */
.grid2  { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.list1  { display: flex; flex-direction: column; gap: 8px; }

/* cards */
.card, .row {
  position: relative;
  background: var(--n-color, #fff);
  border: 1.5px solid var(--n-border-color, #e0e0e0);
  border-radius: 10px;
  cursor: pointer; text-align: left;
  display: flex; flex-direction: column; gap: 2px;
  padding: 11px 13px;
  transition: border-color .15s, box-shadow .15s;
}
.row { flex-direction: row; align-items: center; justify-content: space-between; padding: 13px 15px; }
.lang-row { font-size: 15px; }
.card:hover, .row:hover { border-color: var(--n-color-target, #4b9eff); box-shadow: 0 0 0 3px rgba(75,158,255,.1); }
.card.sel, .row.sel { border-color: var(--n-color-target, #4b9eff); background: rgba(75,158,255,.07); }
.clabel { font-size: 13px; font-weight: 600; }
.csub   { font-size: 11px; opacity: .5; }
.chk    { position: absolute; top: 7px; right: 10px; color: var(--n-color-target, #4b9eff); font-weight: 700; font-size: 13px; }

/* AI key */
.tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.tab {
  padding: 5px 13px; border: 1.5px solid var(--n-border-color, #e0e0e0);
  border-radius: 20px; background: transparent; cursor: pointer; font-size: 12px;
  transition: border-color .15s, background .15s;
}
.tab.active { border-color: var(--n-color-target, #4b9eff); background: rgba(75,158,255,.1); font-weight: 600; }
.fgroup { display: flex; flex-direction: column; gap: 5px; }
.flabel { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; opacity: .55; }
.nsel {
  padding: 7px 11px; border: 1.5px solid var(--n-border-color, #e0e0e0);
  border-radius: 8px; background: var(--n-color, #fff); color: inherit; font-size: 13px;
}

/* Voice step */
.checking-spinner { font-size: 36px; text-align: center; padding: 24px 0; }
.voice-info-box {
  border: 1.5px solid var(--n-border-color, #e0e0e0);
  border-radius: 10px; padding: 14px 16px;
  display: flex; flex-direction: column; gap: 6px;
  background: rgba(0,0,0,.02);
}
.voice-info-box.warn    { border-color: #faad14; background: rgba(250,173,20,.06); }
.voice-info-box.success { border-color: #52c41a; background: rgba(82,196,26,.06); }
.info-title { font-weight: 700; font-size: 14px; margin: 0; }
.info-body  { font-size: 12px; line-height: 1.6; margin: 0; opacity: .8; }
.req-list { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
.req { font-size: 12px; opacity: .75; }

/* NPC grid */
.npc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%; }
.npc-card {
  background: rgba(75,158,255,.07);
  border: 1.5px solid rgba(75,158,255,.22);
  border-radius: 10px; padding: 10px 12px;
  display: flex; flex-direction: column; gap: 2px;
}

/* nav */
.nav { display: flex; justify-content: space-between; align-items: center; margin-top: auto; padding-top: 6px; }

/* consent toggle row */
.consent-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  background: var(--n-color, #fff);
  border: 1.5px solid var(--n-border-color, #e0e0e0);
  border-radius: 10px;
  padding: 12px 14px;
  cursor: pointer;
  text-align: left;
  transition: border-color .15s;
}
.consent-row.on { border-color: #52c41a; background: rgba(82,196,26,.05); }
.consent-toggle {
  flex-shrink: 0;
  width: 36px; height: 20px;
  border-radius: 10px;
  background: #ccc;
  margin-top: 2px;
  position: relative;
  transition: background .2s;
}
.consent-row.on .consent-toggle { background: #52c41a; }
.toggle-knob {
  position: absolute;
  top: 2px; left: 2px;
  width: 16px; height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,.2);
  transition: left .2s;
}
.consent-row.on .toggle-knob { left: 18px; }
.consent-text { display: flex; flex-direction: column; gap: 2px; }
.consent-label { font-size: 13px; font-weight: 600; }
.consent-sub { font-size: 11px; opacity: .55; line-height: 1.5; }
</style>
