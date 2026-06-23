<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, watch } from 'vue'
import {
  NCard,
  NSpace,
  NAlert,
  NTag,
  NTooltip,
  NSwitch,
  NDivider,
  NText,
  NInput,
  NButton,
  NSpin,
  NIcon,
  NUpload,
  NRadioGroup,
  NRadio,
  NList,
  NListItem,
  NThing,
  NModal,
  NSelect,
  useMessage,
  useDialog,
  type UploadFileInfo,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  MicOutline,
  StopOutline,
  VolumeHighOutline,
  TrashOutline,
  CloudUploadOutline,
  CreateOutline,
  DownloadOutline,
} from '@vicons/ionicons5'
import { useAntlerApi } from '@/composables/useAntlerApi'
import { useVoiceSettings } from '@/composables/useVoiceSettings'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import { useVoiceInput } from '@/composables/useVoiceInput'
import { useVoiceOutput } from '@/composables/useVoiceOutput'
import { profileLang, inferLangFromText, langMismatchForTexts, sharesOpening, scriptForLang, previewForLang, defaultRecordLang, VOICE_CLONE_MAX_SCRIPT_CHARS, VOICE_CLONE_MAX_RECORD_SEC, type VoiceCloneLang } from '@/constants/voiceClone'
import VoiceBugConsole from '@/components/settings/VoiceBugConsole.vue'

withDefaults(
  defineProps<{
    cardClass?: string
  }>(),
  { cardClass: '' },
)

const { t, locale } = useI18n()
const message = useMessage()
const dialog = useDialog()
const api = useAntlerApi()

const {
  localSettings,
  profiles,
  serverActiveProfileId,
  status,
  loading,
  refreshProfiles,
  refreshStatus,
  retryVoiceSetup,
  uploadProfile,
  updateProfile,
  setActiveProfile,
  deleteProfile,
} = useVoiceSettings()
const { settings: assistantSettings } = useVoiceAssistantSettings()

const { isRecording, isTranscribing, startRecording, stopRecording } = useVoiceInput()
const { speak, stop, isPlaying, isLoading, isSynthesizing, engine } = useVoiceOutput()

const profileName = ref('My voice')
const recordLang = ref<VoiceCloneLang>(defaultRecordLang(locale.value))
/** Single script: read this when recording; must match what is spoken in the audio. */
const refScript = ref(scriptForLang(recordLang.value))
const previewLang = ref<VoiceCloneLang>('zh')
const previewText = ref(previewForLang('zh'))
const recordLangOptions = computed(() => [
  { label: t('pages.settings.voiceClone.langZh'), value: 'zh' as const },
  { label: t('pages.settings.voiceClone.langEn'), value: 'en' as const },
])
const recordingForProfile = ref(false)
const recordSeconds = ref(0)
let recordTimer: ReturnType<typeof setInterval> | null = null
let recordedBlob: Blob | null = null
let statusPollTimer: ReturnType<typeof setInterval> | null = null

const setupPhase = computed(() => status.value?.setup?.phase || 'idle')
const setupMessage = computed(() => status.value?.setup?.message || '')
const setupInProgress = computed(() =>
  ['finding_python', 'creating_venv', 'installing_deps', 'starting'].includes(setupPhase.value),
)
const setupFailed = computed(() => setupPhase.value === 'error')

const activeId = computed({
  get: () => serverActiveProfileId.value || localSettings.value.activeProfileId || '',
  set: (v: string) => {
    const id = v || null
    if (id === (serverActiveProfileId.value || localSettings.value.activeProfileId)) return
    localSettings.value.activeProfileId = id
    serverActiveProfileId.value = id
    void setActiveProfile(id)
  },
})

const gpuMeetsRequirements = computed(() => status.value?.gpu?.meetsRequirements === true)
const synthesizingHintText = computed(() =>
  gpuMeetsRequirements.value
    ? t('pages.settings.voiceClone.synthesizingHintGpu')
    : t('pages.settings.voiceClone.synthesizingHint'),
)
const ttsAvailable = computed(() => status.value?.tts?.available === true)
const altTtsRunning = computed(() => status.value?.altTts?.available === true || ttsAvailable.value)
const sttAvailable = computed(() => {
  if (status.value?.stt?.available === true) return true
  const va = assistantSettings.value.voiceApi
  if (va.sttKeyAvailable || va.openclawOpenAiKeyConfigured) return true
  if (va.sttApiKey?.trim() || va.hasSttKey) return true
  return !!assistantSettings.value.realtime.openaiApiKey?.trim()
})

const activeProfile = computed(() => profiles.value.find((p) => p.id === activeId.value) || null)
const needsRefText = computed(() => Boolean(activeProfile.value && !activeProfile.value.refText))
const previewBusy = computed(() => isSynthesizing.value || (isLoading.value && !isPlaying.value))
const lastPlayedEngine = ref<'kokoro' | 'edgetts' | 'webspeech' | null>(null)
const playingRefId = ref<string | null>(null)
const cloningProfileId = ref<string | null>(null)
const isDownloading = ref(false)
const showEditScript = ref(false)
const editingProfile = ref<{ id: string; name: string } | null>(null)
const editProfileName = ref('')
const editScriptText = ref('')
let refAudioEl: HTMLAudioElement | null = null
let refObjectUrl: string | null = null

function findProfileIdForLang(lang: VoiceCloneLang): string | null {
  const matching = profiles.value.filter((p) => profileLang(p) === lang && p.refText)
  if (!matching.length) return null
  if (matching.some((p) => p.id === activeId.value)) return activeId.value
  return [...matching].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id || null
}

function langLabel(lang: VoiceCloneLang | null | undefined) {
  if (lang === 'zh') return t('pages.settings.voiceClone.langZh')
  if (lang === 'en') return t('pages.settings.voiceClone.langEn')
  return ''
}

const refTextLangMismatch = computed(() => {
  const ref = activeProfile.value?.refText || ''
  return langMismatchForTexts(ref, previewText.value)
})

watch(recordLang, (lang) => {
  refScript.value = scriptForLang(lang)
})

let syncingLang = false

watch(previewLang, (lang) => {
  if (syncingLang) return
  syncingLang = true
  const profileId = findProfileIdForLang(lang)
  const done = () => {
    syncingLang = false
  }
  if (profileId && profileId !== activeId.value) {
    void setActiveProfile(profileId).finally(done)
  } else {
    done()
  }
})

watch(activeId, (id) => {
  if (syncingLang) return
  const p = profiles.value.find((x) => x.id === id)
  const lang = p ? profileLang(p) : null
  if (lang && lang !== previewLang.value) {
    syncingLang = true
    previewLang.value = lang
    syncingLang = false
  }
})

const statusBadges = computed(() => {
  type BadgeType = 'success' | 'warning' | 'info' | 'error'
  const items: { key: string; type: BadgeType; label: string; tip: string }[] = [
    {
      key: 'hint',
      type: 'info',
      label: t('pages.settings.voiceClone.badgeGuide'),
      tip: t('pages.settings.voiceClone.hint'),
    },
  ]

  if (apiDown.value) {
    items.push({
      key: 'api',
      type: 'error',
      label: t('pages.settings.voiceClone.badgeApi'),
      tip: t('pages.settings.voiceClone.devWrongPort'),
    })
  }

  const gpu = status.value?.gpu
  if (gpu) {
    items.push({
      key: 'gpu',
      type: gpu.meetsRequirements ? 'success' : 'warning',
      label: t('pages.settings.voiceClone.badgeGpu'),
      tip: gpu.meetsRequirements
        ? t('pages.settings.voiceClone.gpuOk', { vram: gpu.vramMb ?? '?' })
        : t('pages.settings.voiceClone.gpuLow', { reason: gpu.reason || '' }),
    })
  }

  items.push({
    key: 'tts',
    type: altTtsRunning.value ? 'success' : setupInProgress.value ? 'info' : 'warning',
    label: 'EdgeTTS',
    tip: altTtsRunning.value
      ? t('pages.settings.voiceClone.cosyReady')
      : setupMessage.value || t('pages.settings.voiceClone.cosyPending'),
  })

  items.push({
    key: 'stt',
    type: sttAvailable.value ? 'success' : 'info',
    label: t('pages.settings.voiceClone.badgeStt'),
    tip: sttAvailable.value
      ? t('pages.settings.voiceClone.sttReady')
      : t('pages.settings.voiceClone.sttPending'),
  })

  return items
})

watch(locale, (v) => {
  if (!refScript.value.trim()) {
    recordLang.value = defaultRecordLang(v)
    refScript.value = scriptForLang(recordLang.value)
  }
})

async function handleUpload({ file }: { file: UploadFileInfo }) {
  const raw = file.file
  if (!raw) return
  const script = refScript.value.trim()
  if (!script) {
    message.warning(t('pages.settings.voiceClone.refTextRequired'))
    return
  }
  if (script.length > VOICE_CLONE_MAX_SCRIPT_CHARS) {
    message.warning(t('pages.settings.voiceClone.scriptTooLong', { max: VOICE_CLONE_MAX_SCRIPT_CHARS }))
    return
  }
  try {
    await uploadProfile(raw, profileName.value.trim() || 'My voice', undefined, script, recordLang.value)
    message.success(t('pages.settings.voiceClone.uploadSuccess'))
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.settings.voiceClone.uploadFailed'))
  }
}

async function toggleRecordProfile() {
  if (recordingForProfile.value) {
    recordedBlob = await stopRecording()
    recordingForProfile.value = false
    if (recordTimer) {
      clearInterval(recordTimer)
      recordTimer = null
    }
    if (!recordedBlob || recordSeconds.value < 3) {
      message.warning(t('pages.settings.voiceClone.recordTooShort'))
      recordedBlob = null
      return
    }
    const script = refScript.value.trim()
    if (script.length > VOICE_CLONE_MAX_SCRIPT_CHARS) {
      message.warning(t('pages.settings.voiceClone.scriptTooLong', { max: VOICE_CLONE_MAX_SCRIPT_CHARS }))
      recordedBlob = null
      return
    }
    try {
      const file = new File([recordedBlob], 'recording.webm', { type: recordedBlob.type })
      await uploadProfile(
        file,
        profileName.value.trim() || 'My voice',
        recordSeconds.value,
        script,
        recordLang.value,
      )
      message.success(t('pages.settings.voiceClone.recordSuccess'))
      recordedBlob = null
    } catch (e) {
      message.error(e instanceof Error ? e.message : t('pages.settings.voiceClone.uploadFailed'))
    }
    return
  }

  recordSeconds.value = 0
  recordedBlob = null
  await startRecording()
  recordingForProfile.value = true
  recordTimer = setInterval(() => {
    recordSeconds.value += 1
    if (recordSeconds.value >= VOICE_CLONE_MAX_RECORD_SEC) void toggleRecordProfile()
  }, 1000)
}

async function handlePreview() {
  const profileId = findProfileIdForLang(previewLang.value) || activeId.value
  await playProfileClone(profileId)
}

function stopRefAudio() {
  if (refAudioEl) {
    refAudioEl.pause()
    refAudioEl.src = ''
    refAudioEl = null
  }
  if (refObjectUrl) {
    URL.revokeObjectURL(refObjectUrl)
    refObjectUrl = null
  }
  playingRefId.value = null
}

async function playProfileRef(profileId: string) {
  if (playingRefId.value === profileId) {
    stopRefAudio()
    return
  }
  stopRefAudio()
  stop()
  playingRefId.value = profileId
  try {
    const blob = await api.getBlob(`/api/voice/profiles/${profileId}/ref`)
    refObjectUrl = URL.createObjectURL(blob)
    refAudioEl = new Audio(refObjectUrl)
    refAudioEl.onended = () => stopRefAudio()
    refAudioEl.onerror = () => {
      message.error(t('pages.settings.voiceClone.playRefFailed'))
      stopRefAudio()
    }
    await refAudioEl.play()
  } catch (e) {
    playingRefId.value = null
    message.error(e instanceof Error ? e.message : t('pages.settings.voiceClone.playRefFailed'))
  }
}

function validatePreviewClone(profileId: string) {
  const profile = profiles.value.find((p) => p.id === profileId)
  if (!profile) return null
  if (!profile.refText) {
    message.warning(t('pages.settings.voiceClone.rerecordForClone'))
    return null
  }
  if (langMismatchForTexts(profile.refText, previewText.value)) {
    message.warning(t('pages.settings.voiceClone.refTextLangMismatchBlock'))
    return null
  }
  const norm = (s: string) => s.replace(/\s/g, '')
  if (norm(profile.refText) === norm(previewText.value)) {
    message.warning(t('pages.settings.voiceClone.previewSameAsScript'))
    return null
  }
  if (sharesOpening(profile.refText, previewText.value)) {
    message.warning(t('pages.settings.voiceClone.previewSharesOpening'))
    return null
  }
  if (!ttsAvailable.value) {
    message.error(t('pages.settings.voiceClone.cosyNotReady'))
    return null
  }
  return profile
}

function audioExtFromBlob(blob: Blob) {
  const type = blob.type.toLowerCase()
  if (type.includes('wav')) return 'wav'
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3'
  if (type.includes('ogg')) return 'ogg'
  return 'wav'
}

function safeFilenamePart(value: string) {
  return value.replace(/[^\w\u4e00-\u9fff-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'clone'
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

async function playProfileClone(profileId: string) {
  const profile = validatePreviewClone(profileId)
  if (!profile) return

  if (isPlaying.value || previewBusy.value) {
    if (cloningProfileId.value === profileId) {
      stop()
      cloningProfileId.value = null
    }
    return
  }

  cloningProfileId.value = profileId
  try {
    message.info(t('pages.settings.voiceClone.synthStarting', { text: previewText.value.slice(0, 40) }))
    await speak(previewText.value, { profileId })
    lastPlayedEngine.value = engine.value
    if (engine.value === 'edgetts' || engine.value === 'kokoro') {
      message.success(t('pages.settings.voiceClone.previewCloneDone'))
    } else {
      message.warning(t('pages.settings.voiceClone.previewNotClone'))
    }
  } catch (e) {
    console.error('[VoiceCloneSettingsCard] profile clone error:', e)
    message.error(e instanceof Error ? e.message : t('pages.settings.voiceClone.previewFailed'))
  } finally {
    cloningProfileId.value = null
  }
}

async function downloadProfileClone(profileId: string) {
  const profile = validatePreviewClone(profileId)
  if (!profile || isDownloading.value || previewBusy.value) return

  isDownloading.value = true
  try {
    message.info(t('pages.settings.voiceClone.synthStarting', { text: previewText.value.slice(0, 40) }))
    const result = await api.postBlob(
      '/api/voice/synthesize',
      {
        text: previewText.value.trim(),
        profileId,
        engine: 'edgetts',
      },
      { timeoutMs: 120000 },
    )
    if (!('blob' in result)) {
      throw new Error('error' in result ? result.error : t('pages.settings.voiceClone.downloadFailed'))
    }
    if (result.engine && result.engine !== 'edgetts' && result.engine !== 'kokoro') {
      message.warning(t('pages.settings.voiceClone.previewNotClone'))
      return
    }
    const ext = audioExtFromBlob(result.blob)
    const filename = `${safeFilenamePart(profile.name)}-${safeFilenamePart(previewText.value)}.${ext}`
    downloadBlob(result.blob, filename)
    message.success(t('pages.settings.voiceClone.downloadSuccess'))
  } catch (e) {
    console.error('[VoiceCloneSettingsCard] profile clone download error:', e)
    message.error(e instanceof Error ? e.message : t('pages.settings.voiceClone.downloadFailed'))
  } finally {
    isDownloading.value = false
  }
}

async function handleDownload() {
  const profileId = findProfileIdForLang(previewLang.value) || activeId.value
  await downloadProfileClone(profileId)
}

function openEditScript(p: { id: string; name: string; refText?: string | null }) {
  editingProfile.value = { id: p.id, name: p.name }
  editProfileName.value = p.name
  editScriptText.value = p.refText || ''
  showEditScript.value = true
}

async function saveEditScript() {
  if (!editingProfile.value) return false
  const name = editProfileName.value.trim()
  if (!name) {
    message.warning(t('pages.settings.voiceClone.editNameRequired'))
    return false
  }
  const text = editScriptText.value.trim()
  if (!text) {
    message.warning(t('pages.settings.voiceClone.refTextRequired'))
    return false
  }
  try {
    await updateProfile(editingProfile.value.id, { name, refText: text })
    if (activeId.value === editingProfile.value.id && langMismatchForTexts(text, previewText.value)) {
      previewText.value = previewForLang(inferLangFromText(text))
      previewLang.value = inferLangFromText(text)
    }
    message.success(t('pages.settings.voiceClone.editProfileSuccess'))
    showEditScript.value = false
    editingProfile.value = null
    return true
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.settings.voiceClone.editProfileFailed'))
    return false
  }
}

function confirmDelete(id: string, name: string) {
  dialog.warning({
    title: t('pages.settings.voiceClone.deleteTitle'),
    content: t('pages.settings.voiceClone.deleteConfirm', { name }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await deleteProfile(id)
        message.success(t('pages.settings.voiceClone.deleteSuccess'))
      } catch (e) {
        message.error(e instanceof Error ? e.message : t('pages.settings.voiceClone.deleteFailed'))
      }
    },
  })
}

function syncStatusPoll() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer)
    statusPollTimer = null
  }
  if (setupInProgress.value || (!altTtsRunning.value && !setupFailed.value)) {
    statusPollTimer = setInterval(() => {
      void refreshStatus()
    }, 3000)
  }
}

async function handleRetrySetup() {
  try {
    await retryVoiceSetup()
    message.info(t('pages.settings.voiceClone.setupRetrying'))
    syncStatusPoll()
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.settings.voiceClone.setupFailed'))
  }
}

const apiDown = ref(false)

async function loadVoicePanel() {
  apiDown.value = false
  try {
    await refreshProfiles()
    await refreshStatus()
  } catch {
    apiDown.value = true
  }
  syncStatusPoll()
}

watch([setupInProgress, altTtsRunning, setupFailed], () => syncStatusPoll())

onMounted(() => {
  void loadVoicePanel()
})

onUnmounted(() => {
  if (statusPollTimer) clearInterval(statusPollTimer)
  stopRefAudio()
})
</script>

<template>
  <NCard :title="t('pages.settings.voiceClone.title')" :class="cardClass">
    <NSpin :show="loading">
      <NSpace vertical :size="16">
        <div class="voice-clone-badges">
          <NSpace :size="8" align="center" wrap>
            <NTooltip
              v-for="badge in statusBadges"
              :key="badge.key"
              trigger="hover"
              :show-arrow="true"
            >
              <template #trigger>
                <NTag
                  :type="badge.type"
                  size="small"
                  round
                  :bordered="false"
                  class="voice-clone-badge"
                >
                  {{ badge.label }}
                </NTag>
              </template>
              <span class="voice-clone-badge-tip">{{ badge.tip }}</span>
            </NTooltip>
            <NButton
              v-if="setupFailed && gpuMeetsRequirements"
              size="tiny"
              type="primary"
              @click="handleRetrySetup"
            >
              {{ t('pages.settings.voiceClone.setupRetry') }}
            </NButton>
            <NSpin v-if="setupInProgress" size="small" />
          </NSpace>
        </div>

        <NDivider style="margin: 0" />

        <div>
          <NText strong style="display: block; margin-bottom: 8px">
            {{ t('pages.settings.voiceClone.addProfile') }}
          </NText>
          <NInput
            v-model:value="profileName"
            :placeholder="t('pages.settings.voiceClone.namePlaceholder')"
            style="max-width: 320px; margin-bottom: 12px"
          />
          <NSpace align="center" :size="12" style="margin-bottom: 12px">
            <NText strong>{{ t('pages.settings.voiceClone.recordLangLabel') }}</NText>
            <NSelect
              v-model:value="recordLang"
              :options="recordLangOptions"
              style="width: 160px"
            />
          </NSpace>
          <NText strong style="display: block; margin-bottom: 6px">
            {{ t('pages.settings.voiceClone.recordScriptLabel') }}
          </NText>
          <NInput
            v-model:value="refScript"
            type="textarea"
            :placeholder="t('pages.settings.voiceClone.refTextPlaceholder')"
            :maxlength="VOICE_CLONE_MAX_SCRIPT_CHARS"
            show-count
            style="max-width: 480px; margin-bottom: 12px"
            :autosize="{ minRows: 2, maxRows: 4 }"
          />
          <NText depth="3" style="font-size: 13px; display: block; margin-bottom: 12px">
            {{ t('pages.settings.voiceClone.recordWorkflowHint') }}
          </NText>
          <NSpace :size="12">
            <NUpload :show-file-list="false" accept="audio/*" @change="handleUpload">
              <NButton>
                <template #icon><NIcon :component="CloudUploadOutline" /></template>
                {{ t('pages.settings.voiceClone.upload') }}
              </NButton>
            </NUpload>
            <NButton
              :type="recordingForProfile ? 'error' : 'default'"
              @click="toggleRecordProfile"
            >
              <template #icon>
                <NIcon :component="recordingForProfile ? StopOutline : MicOutline" />
              </template>
              {{
                recordingForProfile
                  ? t('pages.settings.voiceClone.stopRecord', { sec: recordSeconds })
                  : t('pages.settings.voiceClone.record')
              }}
            </NButton>
          </NSpace>
          <NText depth="3" style="font-size: 13px; display: block; margin-top: 8px">
            {{ t('pages.settings.voiceClone.recordHint') }}
          </NText>
        </div>

        <NDivider style="margin: 0" />

        <div v-if="profiles.length">
          <NText strong style="display: block; margin-bottom: 8px">
            {{ t('pages.settings.voiceClone.profiles') }}
          </NText>
          <NRadioGroup v-model:value="activeId" style="width: 100%">
            <NList bordered>
              <NListItem v-for="p in profiles" :key="p.id">
                <NThing>
                  <template #header>
                    <NRadio :value="p.id">
                      {{ p.name }}
                      <NText v-if="profileLang(p)" depth="3" style="font-size: 12px; margin-left: 6px">
                        · {{ langLabel(profileLang(p)) }}
                      </NText>
                    </NRadio>
                  </template>
                  <template #description>
                    <NText depth="3" style="font-size: 12px; display: block">
                      {{ new Date(p.createdAt).toLocaleString() }}
                      <span v-if="p.durationSec"> · {{ Math.round(p.durationSec) }}s</span>
                      <span v-if="p.refText"> · {{ t('pages.settings.voiceClone.hasRefText') }}</span>
                      <span v-else> · {{ t('pages.settings.voiceClone.missingRefText') }}</span>
                    </NText>
                    <NText
                      v-if="p.refText"
                      depth="3"
                      style="font-size: 12px; display: block; margin-top: 4px; max-width: 420px"
                    >
                      {{ t('pages.settings.voiceClone.savedScriptLabel') }}：「{{ p.refText }}」
                    </NText>
                  </template>
                  <template #action>
                    <NSpace :size="8" align="center">
                      <NButton
                        quaternary
                        size="small"
                        :type="playingRefId === p.id ? 'error' : 'default'"
                        @click="playProfileRef(p.id)"
                      >
                        {{ playingRefId === p.id ? t('pages.settings.tts.stop') : t('pages.settings.voiceClone.playRef') }}
                      </NButton>
                      <NButton
                        quaternary
                        size="small"
                        :title="t('pages.settings.voiceClone.editProfile')"
                        @click="openEditScript(p)"
                      >
                        <template #icon><NIcon :component="CreateOutline" /></template>
                      </NButton>
                      <NButton quaternary type="error" size="small" @click="confirmDelete(p.id, p.name)">
                        <template #icon><NIcon :component="TrashOutline" /></template>
                      </NButton>
                    </NSpace>
                  </template>
                </NThing>
              </NListItem>
            </NList>
          </NRadioGroup>
        </div>
        <NText v-else depth="3">{{ t('pages.settings.voiceClone.noProfiles') }}</NText>

        <NDivider style="margin: 0" />

        <NAlert v-if="needsRefText" type="warning" :bordered="false">
          {{ t('pages.settings.voiceClone.rerecordForClone') }}
        </NAlert>

        <NAlert v-if="refTextLangMismatch" type="warning" :bordered="false">
          {{ t('pages.settings.voiceClone.refTextLangMismatch') }}
        </NAlert>

        <div>
          <NSpace align="center" :size="12" style="margin-bottom: 8px">
            <NText strong>{{ t('pages.settings.voiceClone.preview') }}</NText>
            <NSelect
              v-model:value="previewLang"
              :options="recordLangOptions"
              style="width: 160px"
            />
          </NSpace>
          <NAlert type="info" :bordered="false" style="margin-bottom: 8px">
            {{ t('pages.settings.voiceClone.previewDifferentHint') }}
          </NAlert>
          <NText depth="3" style="font-size: 12px; display: block; margin-bottom: 8px">
            {{ t('pages.settings.voiceClone.cloneQualityHint') }}
          </NText>
          <NSpace :size="12" align="center" style="max-width: 520px">
            <NInput
              v-model:value="previewText"
              :placeholder="t('pages.settings.voiceClone.previewPlaceholder')"
              style="flex: 1"
            />
            <NButton
              :type="isPlaying || previewBusy ? 'error' : 'primary'"
              :loading="previewBusy && !isPlaying"
              :disabled="isTranscribing || needsRefText || !findProfileIdForLang(previewLang) || isDownloading"
              @click="handlePreview"
            >
              <template #icon>
                <NIcon :component="isPlaying || isLoading ? StopOutline : VolumeHighOutline" />
              </template>
              {{ isPlaying ? t('pages.settings.tts.stop') : t('pages.settings.voiceClone.playClone') }}
            </NButton>
            <NButton
              :loading="isDownloading"
              :disabled="isTranscribing || needsRefText || !findProfileIdForLang(previewLang) || previewBusy || isPlaying"
              @click="handleDownload"
            >
              <template #icon><NIcon :component="DownloadOutline" /></template>
              {{ t('pages.settings.voiceClone.download') }}
            </NButton>
          </NSpace>
          <NText v-if="isSynthesizing" depth="3" style="font-size: 13px; display: block; margin-top: 8px">
            {{ synthesizingHintText }}
          </NText>
          <NText v-if="lastPlayedEngine === 'edgetts' || lastPlayedEngine === 'kokoro'" depth="3" style="font-size: 12px; display: block; margin-top: 8px">
            {{ t('pages.settings.voiceClone.lastEngineClone') }}
          </NText>
          <NText
            v-else-if="lastPlayedEngine === 'webspeech'"
            depth="3"
            style="font-size: 12px; display: block; margin-top: 8px; color: var(--warning-color, #f0a020)"
          >
            {{ t('pages.settings.voiceClone.lastEngineSystem') }}
          </NText>
          <NText v-else-if="!ttsAvailable" depth="3" style="font-size: 13px; display: block; margin-top: 8px">
            {{ t('pages.settings.voiceClone.previewFallbackHint') }}
          </NText>
        </div>

        <VoiceBugConsole :auto-refresh="previewBusy || setupInProgress" />
      </NSpace>
    </NSpin>

    <NModal
      v-model:show="showEditScript"
      preset="dialog"
      :title="t('pages.settings.voiceClone.editProfileTitle')"
      :positive-text="t('common.save')"
      :negative-text="t('common.cancel')"
      @positive-click="saveEditScript"
    >
      <NSpace vertical :size="12" style="width: 100%">
        <div>
          <NText strong style="display: block; margin-bottom: 6px">
            {{ t('pages.settings.voiceClone.editProfileName') }}
          </NText>
          <NInput
            v-model:value="editProfileName"
            :placeholder="t('pages.settings.voiceClone.namePlaceholder')"
          />
        </div>
        <div>
          <NText strong style="display: block; margin-bottom: 6px">
            {{ t('pages.settings.voiceClone.savedScriptLabel') }}
          </NText>
          <NText depth="3" style="font-size: 13px; display: block; margin-bottom: 8px">
            {{ t('pages.settings.voiceClone.editScriptHint') }}
          </NText>
          <NInput
            v-model:value="editScriptText"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 5 }"
            :placeholder="t('pages.settings.voiceClone.refTextPlaceholder')"
          />
        </div>
      </NSpace>
    </NModal>
  </NCard>
</template>

<style scoped>
.voice-clone-badges {
  margin-bottom: 4px;
}

.voice-clone-badge {
  cursor: default;
  user-select: none;
}

.voice-clone-badge-tip {
  display: inline-block;
  max-width: 360px;
  line-height: 1.45;
  font-size: 13px;
}
</style>
