import { ref, computed } from 'vue'
import { useBossStore } from '@/stores/boss'
import { useAntlerApi } from '@/composables/useAntlerApi'

interface OfficeModelSettings {
  cooModel?: string
  workerModel?: string
}

export interface CompanyFrameworkSettings {
  enabled?: boolean
  productName?: string
  productSummary?: string
  inScope?: string[]
  outOfScope?: string[]
  currentGoals?: string[]
  futurePlan?: string[]
  futurePlanCompleted?: string[]
  primaryRepo?: string
}

interface OfficeSettings {
  bossDisplayName?: string
  desktopDisplayName?: string
  models?: OfficeModelSettings
  companyFramework?: CompanyFrameworkSettings
}

interface AntlerSettings {
  office?: OfficeSettings
}

function linesToList(text: string): string[] {
  return String(text || '')
    .split(/\r?\n/)
    .map((s) => s.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean)
}

function listToLines(list: string[] | undefined): string {
  return (list || []).join('\n')
}

const bossDisplayName = ref('')
const desktopDisplayName = ref('')
const cooModel = ref('')
const workerModel = ref('')
const hostname = ref('')
const loaded = ref(false)

const frameworkEnabled = ref(true)
const productName = ref('')
const productSummary = ref('')
const inScopeText = ref('')
const outOfScopeText = ref('')
const futurePlanText = ref('')
const primaryRepo = ref('')

export function useOfficeProfile() {
  const api = useAntlerApi()
  const boss = useBossStore()

  const resolvedBossName = computed(() => {
    const custom = bossDisplayName.value.trim()
    if (custom) return custom
    return boss.session?.username?.trim() || 'CEO'
  })

  const resolvedDesktopName = computed(() => {
    const custom = desktopDisplayName.value.trim()
    if (custom) return custom
    return hostname.value.trim() || 'This computer'
  })

  const frameworkConfigured = computed(() => {
    if (!frameworkEnabled.value) return false
    return Boolean(productName.value.trim() || productSummary.value.trim())
  })

  function applyFrameworkFromSettings(fw?: CompanyFrameworkSettings) {
    frameworkEnabled.value = fw?.enabled !== false
    productName.value = fw?.productName || ''
    productSummary.value = fw?.productSummary || ''
    inScopeText.value = listToLines(fw?.inScope)
    outOfScopeText.value = listToLines(fw?.outOfScope)
    futurePlanText.value = listToLines(fw?.futurePlan?.length ? fw.futurePlan : fw?.currentGoals)
    primaryRepo.value = fw?.primaryRepo || ''
  }

  function buildFrameworkPayload(): CompanyFrameworkSettings {
    return {
      enabled: frameworkEnabled.value,
      productName: productName.value.trim(),
      productSummary: productSummary.value.trim(),
      inScope: linesToList(inScopeText.value),
      outOfScope: linesToList(outOfScopeText.value),
      futurePlan: linesToList(futurePlanText.value),
      primaryRepo: primaryRepo.value.trim(),
    }
  }

  async function load() {
    const [settingsRes, statusRes] = await Promise.all([
      api.get<AntlerSettings>('/api/antler/settings'),
      api.get<{ hostname?: string }>('/api/portal/local-status').catch(() => ({ hostname: '' })),
    ])
    bossDisplayName.value = settingsRes.office?.bossDisplayName || ''
    desktopDisplayName.value = settingsRes.office?.desktopDisplayName || ''
    cooModel.value = settingsRes.office?.models?.cooModel || ''
    workerModel.value = settingsRes.office?.models?.workerModel || ''
    applyFrameworkFromSettings(settingsRes.office?.companyFramework)
    hostname.value = statusRes.hostname || ''
    loaded.value = true
  }

  async function save(next: {
    bossDisplayName?: string
    desktopDisplayName?: string
    cooModel?: string
    workerModel?: string
    companyFramework?: CompanyFrameworkSettings
  }) {
    if (typeof next.bossDisplayName === 'string') {
      bossDisplayName.value = next.bossDisplayName
    }
    if (typeof next.desktopDisplayName === 'string') {
      desktopDisplayName.value = next.desktopDisplayName
    }
    if (typeof next.cooModel === 'string') {
      cooModel.value = next.cooModel
    }
    if (typeof next.workerModel === 'string') {
      workerModel.value = next.workerModel
    }
    if (next.companyFramework) {
      applyFrameworkFromSettings(next.companyFramework)
    }
    await api.send('POST', '/api/antler/settings', {
      office: {
        bossDisplayName: bossDisplayName.value.trim(),
        desktopDisplayName: desktopDisplayName.value.trim(),
        models: {
          cooModel: cooModel.value.trim(),
          workerModel: workerModel.value.trim(),
        },
        companyFramework: buildFrameworkPayload(),
      },
    })
    loaded.value = true
  }

  return {
    bossDisplayName,
    desktopDisplayName,
    cooModel,
    workerModel,
    hostname,
    loaded,
    resolvedBossName,
    resolvedDesktopName,
    frameworkEnabled,
    productName,
    productSummary,
    inScopeText,
    outOfScopeText,
    futurePlanText,
    primaryRepo,
    frameworkConfigured,
    buildFrameworkPayload,
    load,
    save,
  }
}

