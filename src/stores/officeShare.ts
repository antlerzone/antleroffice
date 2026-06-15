import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface ShareInfo {
  enabled: boolean
  officeId: string | null
  inviteCode: string | null
  hostUrl: string | null
  memberToken: string | null
  role: string | null
}

export const useOfficeShareStore = defineStore('officeShare', () => {
  const share = ref<ShareInfo | null>(null)
  let loaded = false

  const isMemberClient = computed(
    () => !!share.value?.enabled && share.value.role === 'member' && !!share.value.hostUrl,
  )

  const isHost = computed(() => !!share.value?.enabled && share.value.role === 'owner')

  async function refresh() {
    try {
      const data = await fetch('/api/office/share/info').then((r) => r.json())
      share.value = data.share || null
    } catch {
      share.value = null
    }
    loaded = true
    return share.value
  }

  async function ensureLoaded() {
    if (!loaded) await refresh()
    return share.value
  }

  return { share, isMemberClient, isHost, refresh, ensureLoaded }
})
