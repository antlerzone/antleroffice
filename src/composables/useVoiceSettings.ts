import { computed, ref } from 'vue'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'

export interface VoiceProfile {
  id: string
  name: string
  refFile: string
  refText?: string | null
  lang?: 'zh' | 'en' | null
  mimeType?: string | null
  durationSec?: number | null
  createdAt: number
  updatedAt: number
}

export interface VoiceStatus {
  ok: boolean
  gpu?: {
    meetsRequirements: boolean
    vramMb: number | null
    minVramMb: number
    reason?: string
  }
  setup?: {
    phase: string
    message?: string
    error?: string | null
  }
  stt?: { available: boolean; engine: string }
  tts?: {
    available: boolean
    engine: string
    sidecarRunning?: boolean
    gpuReady?: boolean
    gpuRequired?: boolean
  }
}

interface VoiceLocalSettings {
  useCloneVoice: boolean
  activeProfileId: string | null
}

const profiles = ref<VoiceProfile[]>([])
const serverActiveProfileId = ref<string | null>(null)
const status = ref<VoiceStatus | null>(null)
const loading = ref(false)
const localActiveId = ref<string | null>(null)

export function useVoiceSettings() {
  const api = useAntlerApi()
  const { settings: assistantSettings, updateVoice } = useVoiceAssistantSettings()

  const localSettings = computed<VoiceLocalSettings>({
    get: () => ({
      useCloneVoice: assistantSettings.value.voice.useCloneVoice,
      activeProfileId: localActiveId.value ?? serverActiveProfileId.value,
    }),
    set: (v) => {
      updateVoice({ useCloneVoice: v.useCloneVoice })
      localActiveId.value = v.activeProfileId
    },
  })

  async function refreshProfiles() {
    loading.value = true
    try {
      const res = await api.get<{
        ok: boolean
        profiles: VoiceProfile[]
        activeProfileId: string | null
      }>('/api/voice/profiles')
      profiles.value = res.profiles || []
      serverActiveProfileId.value = res.activeProfileId
      if (res.activeProfileId) {
        localActiveId.value = res.activeProfileId
      }
    } finally {
      loading.value = false
    }
  }

  async function refreshStatus() {
    try {
      status.value = await api.get<VoiceStatus>('/api/voice/status')
    } catch (e) {
      status.value = null
      throw e
    }
  }

  async function startVoiceSetup() {
    await api.send('POST', '/api/voice/setup/start', {})
    await refreshStatus()
  }

  async function retryVoiceSetup() {
    await api.send('POST', '/api/voice/setup/retry', {})
    await refreshStatus()
  }

  async function uploadProfile(
    file: File,
    name: string,
    durationSec?: number,
    refText?: string,
    lang?: 'zh' | 'en',
  ) {
    const form = new FormData()
    form.append('audio', file, file.name)
    form.append('name', name)
    if (durationSec != null) form.append('durationSec', String(durationSec))
    if (refText?.trim()) form.append('refText', refText.trim())
    if (lang) form.append('lang', lang)
    const res = await api.sendForm<{ ok: boolean; profile: VoiceProfile }>(
      'POST',
      '/api/voice/profiles',
      form,
      { timeoutMs: 120000 },
    )
    await refreshProfiles()
    return res.profile
  }

  async function setActiveProfile(profileId: string | null) {
    localActiveId.value = profileId
    serverActiveProfileId.value = profileId
    await api.send('PATCH', '/api/voice/profiles/active', { profileId })
    await refreshProfiles()
  }

  async function deleteProfile(profileId: string) {
    await api.send('DELETE', `/api/voice/profiles/${profileId}`, {})
    await refreshProfiles()
  }

  async function updateProfile(profileId: string, patch: { name?: string; refText?: string }) {
    const body: { name?: string; refText?: string } = {}
    if (patch.name != null) body.name = patch.name.trim()
    if (patch.refText != null) body.refText = patch.refText.trim()
    await api.send('PATCH', `/api/voice/profiles/${profileId}`, body)
    await refreshProfiles()
  }

  async function updateProfileRefText(profileId: string, refText: string) {
    await updateProfile(profileId, { refText })
  }

  return {
    localSettings,
    profiles,
    serverActiveProfileId,
    status,
    loading,
    refreshProfiles,
    refreshStatus,
    startVoiceSetup,
    retryVoiceSetup,
    uploadProfile,
    updateProfileRefText,
    updateProfile,
    setActiveProfile,
    deleteProfile,
  }
}
