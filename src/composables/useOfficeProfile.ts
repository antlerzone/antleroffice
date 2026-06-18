import { ref, computed } from 'vue'
import { useBossStore } from '@/stores/boss'
import { useAntlerApi } from '@/composables/useAntlerApi'

interface OfficeSettings {
  bossDisplayName?: string
  desktopDisplayName?: string
}

interface AntlerSettings {
  office?: OfficeSettings
}

const bossDisplayName = ref('')
const desktopDisplayName = ref('')
const hostname = ref('')
const loaded = ref(false)

export function useOfficeProfile() {
  const api = useAntlerApi()
  const boss = useBossStore()

  const resolvedBossName = computed(() => {
    const custom = bossDisplayName.value.trim()
    if (custom) return custom
    return boss.session?.username?.trim() || 'Boss'
  })

  const resolvedDesktopName = computed(() => {
    const custom = desktopDisplayName.value.trim()
    if (custom) return custom
    return hostname.value.trim() || 'This computer'
  })

  async function load() {
    const [settingsRes, statusRes] = await Promise.all([
      api.get<AntlerSettings>('/api/antler/settings'),
      api.get<{ hostname?: string }>('/api/portal/local-status').catch(() => ({ hostname: '' })),
    ])
    bossDisplayName.value = settingsRes.office?.bossDisplayName || ''
    desktopDisplayName.value = settingsRes.office?.desktopDisplayName || ''
    hostname.value = statusRes.hostname || ''
    loaded.value = true
  }

  async function save(next: { bossDisplayName?: string; desktopDisplayName?: string }) {
    if (typeof next.bossDisplayName === 'string') {
      bossDisplayName.value = next.bossDisplayName
    }
    if (typeof next.desktopDisplayName === 'string') {
      desktopDisplayName.value = next.desktopDisplayName
    }
    await api.send('POST', '/api/antler/settings', {
      office: {
        bossDisplayName: bossDisplayName.value.trim(),
        desktopDisplayName: desktopDisplayName.value.trim(),
      },
    })
    loaded.value = true
  }

  return {
    bossDisplayName,
    desktopDisplayName,
    hostname,
    loaded,
    resolvedBossName,
    resolvedDesktopName,
    load,
    save,
  }
}
