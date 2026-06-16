import { ref, computed, reactive, watch } from 'vue'
import { useAntlerApi } from '@/composables/useAntlerApi'

export interface BossWebAccount {
  id: string
  alias: string
  displayName: string
  username: string
  passwordHash: string
  secretSet: boolean
  status: 'active' | 'inactive'
  createdAt: number
  updatedAt: number
}

export interface RevealedSecrets {
  alias: string
  username: string
  password: string
}

const PREFS_KEY = 'antleroffice.accountsListPrefs'
export const PAGE_SIZES = [10, 20, 50, 100, 200]

function loadPrefs() {
  const defaults = {
    search: '',
    page: 1,
    pageSize: 10,
  }
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
    if (PAGE_SIZES.includes(saved.pageSize)) defaults.pageSize = saved.pageSize
    if (typeof saved.search === 'string') defaults.search = saved.search
  } catch { /* ignore */ }
  return defaults
}

export function useWebAccounts() {
  const api = useAntlerApi()
  const loading = ref(false)
  const accounts = ref<BossWebAccount[]>([])
  const prefs = reactive(loadPrefs())

  const revealed = ref<Record<string, RevealedSecrets>>({})

  function savePrefs() {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ pageSize: prefs.pageSize, search: prefs.search }),
    )
  }

  const filtered = computed(() => {
    const q = prefs.search.trim().toLowerCase()
    let rows = [...accounts.value]
    if (q) {
      rows = rows.filter((a) =>
        [a.alias, a.displayName, a.username, a.passwordHash]
          .join(' ')
          .toLowerCase()
          .includes(q),
      )
    }
    rows.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.alias.localeCompare(b.alias))
    return rows
  })

  const total = computed(() => filtered.value.length)
  const totalPages = computed(() => Math.max(1, Math.ceil(total.value / prefs.pageSize)))

  const pageInfo = computed(() => {
    if (!total.value) return { start: 0, end: 0 }
    const start = (prefs.page - 1) * prefs.pageSize + 1
    const end = Math.min(prefs.page * prefs.pageSize, total.value)
    return { start, end }
  })

  const pageRows = computed(() => {
    const p = Math.min(Math.max(1, prefs.page), totalPages.value)
    const start = (p - 1) * prefs.pageSize
    return filtered.value.slice(start, start + prefs.pageSize)
  })

  watch(
    () => [prefs.search, prefs.pageSize, total.value],
    () => {
      if (prefs.page > totalPages.value) prefs.page = totalPages.value
    },
  )

  async function refresh() {
    loading.value = true
    try {
      const data = await api.get<{ ok?: boolean; accounts?: BossWebAccount[] }>('/api/accounts')
      accounts.value = Array.isArray(data.accounts) ? data.accounts : []
      revealed.value = {}
    } finally {
      loading.value = false
    }
  }

  async function revealSecrets(alias: string): Promise<RevealedSecrets> {
    if (revealed.value[alias]) return revealed.value[alias]
    const data = await api.get<RevealedSecrets & { ok?: boolean }>(
      `/api/accounts/${encodeURIComponent(alias)}/reveal`,
    )
    const hit: RevealedSecrets = {
      alias: data.alias || alias,
      username: data.username || '',
      password: data.password || '',
    }
    revealed.value = { ...revealed.value, [alias]: hit }
    return hit
  }

  function hideSecrets(alias: string) {
    const next = { ...revealed.value }
    delete next[alias]
    revealed.value = next
  }

  function isRevealed(alias: string) {
    return !!revealed.value[alias]
  }

  function passwordDisplay(row: BossWebAccount) {
    if (revealed.value[row.alias]?.password) return revealed.value[row.alias].password
    if (!row.secretSet || !row.passwordHash) return '—'
    return row.passwordHash
  }

  function onPageChange(page: number) {
    if (page < 1 || page > totalPages.value) return
    prefs.page = page
  }

  function onPageSizeChange(size: number) {
    prefs.pageSize = size
    prefs.page = 1
    savePrefs()
  }

  return {
    loading,
    accounts,
    prefs,
    filtered,
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
    savePrefs,
  }
}
