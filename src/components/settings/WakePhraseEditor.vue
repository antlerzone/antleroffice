<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import {
  NSpace,
  NText,
  NInput,
  NButton,
  NCheckbox,
  NCheckboxGroup,
  NTag,
  NIcon,
  NSpin,
  NModal,
  useMessage,
} from 'naive-ui'
import { MicOutline, StopOutline, VolumeHighOutline } from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'
import { useVoiceAssistantSettings } from '@/composables/useVoiceAssistantSettings'
import { useVoiceInput } from '@/composables/useVoiceInput'
import { useAntlerApi } from '@/composables/useAntlerApi'
import {
  BUILTIN_WAKE_PHRASES,
  dedupeWakePhrases,
  isBuiltinWakePhrase,
  mergeWakePhrase,
  normalizeWakePhrase,
  splitWakePhrases,
} from '@/constants/voiceAssistant'

const props = withDefaults(
  defineProps<{
    disabled?: boolean
  }>(),
  { disabled: false },
)

const { t } = useI18n()
const message = useMessage()
const api = useAntlerApi()
const { settings, updateSummon } = useVoiceAssistantSettings()
const { isRecording, isTranscribing, startRecording, stopRecording, transcribeBlob } = useVoiceInput()

const draftPhrase = ref('')
const showRecordModal = ref(false)
const recordedPhrase = ref('')
const recordedBlob = ref<Blob | null>(null)
const savingClip = ref(false)
const playingClipId = ref<string | null>(null)
let previewAudio: HTMLAudioElement | null = null

const phraseOptions = computed(() =>
  BUILTIN_WAKE_PHRASES.map((p) => ({ label: p, value: p })),
)

const builtinSelected = computed({
  get: () => splitWakePhrases(settings.value.summon.wakePhrases).builtin,
  set: (next: string[]) => {
    const custom = splitWakePhrases(settings.value.summon.wakePhrases).custom
    updateSummon({ wakePhrases: dedupeWakePhrases([...next, ...custom]) })
  },
})

const customPhrases = computed(() => splitWakePhrases(settings.value.summon.wakePhrases).custom)

const clipByPhrase = computed(() => {
  const map = new Map<string, string>()
  for (const [phrase, clipId] of Object.entries(settings.value.summon.wakePhraseClips || {})) {
    if (phrase && clipId) map.set(phrase.toLowerCase(), clipId)
  }
  return map
})

function setWakePhrases(next: string[]) {
  updateSummon({ wakePhrases: dedupeWakePhrases(next) })
}

function addDraftPhrase() {
  const phrase = normalizeWakePhrase(draftPhrase.value)
  if (!phrase) {
    message.warning(t('pages.settings.voiceAssistant.summon.wakePhraseEmpty'))
    return
  }
  const before = settings.value.summon.wakePhrases.length
  const merged = mergeWakePhrase(settings.value.summon.wakePhrases, phrase)
  if (merged.length === before) {
    message.info(t('pages.settings.voiceAssistant.summon.wakePhraseDuplicate'))
    return
  }
  setWakePhrases(merged)
  draftPhrase.value = ''
  message.success(t('pages.settings.voiceAssistant.summon.wakePhraseAdded'))
}

function removeCustomPhrase(phrase: string) {
  const next = settings.value.summon.wakePhrases.filter(
    (p) => p.toLowerCase() !== phrase.toLowerCase(),
  )
  const clips = { ...(settings.value.summon.wakePhraseClips || {}) }
  const clipId = clips[phrase]
  delete clips[phrase]
  updateSummon({ wakePhrases: next, wakePhraseClips: clips })
  if (clipId) void api.send('DELETE', `/api/voice/wake-clips/${clipId}`).catch(() => {})
}

async function startWakeRecord() {
  if (props.disabled || isTranscribing.value) return
  recordedPhrase.value = ''
  recordedBlob.value = null
  try {
    await startRecording()
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.settings.voiceClone.micFailed'))
  }
}

async function finishWakeRecord() {
  if (!isRecording.value) return
  const blob = await stopRecording()
  if (!blob) {
    message.warning(t('pages.settings.voiceAssistant.summon.recordTooShort'))
    return
  }
  try {
    const text = await transcribeBlob(blob)
    recordedPhrase.value = normalizeWakePhrase(text)
    recordedBlob.value = blob
    showRecordModal.value = true
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.settings.voiceClone.micFailed'))
  }
}

async function onConfirmRecorded() {
  await confirmRecordedPhrase()
  return false
}

function onReRecord() {
  showRecordModal.value = false
  void startWakeRecord()
  return false
}

async function confirmRecordedPhrase() {
  const phrase = normalizeWakePhrase(recordedPhrase.value)
  if (!phrase) {
    message.warning(t('pages.settings.voiceAssistant.summon.wakePhraseEmpty'))
    return
  }
  savingClip.value = true
  try {
    let clipId: string | undefined
    if (recordedBlob.value) {
      const form = new FormData()
      form.append('phrase', phrase)
      form.append('audio', recordedBlob.value, 'wake-phrase.webm')
      const res = await api.sendForm<{ ok: boolean; clip?: { id: string } }>(
        'POST',
        '/api/voice/wake-clips',
        form,
        { timeoutMs: 120000 },
      )
      clipId = res.clip?.id
    }
    const merged = mergeWakePhrase(settings.value.summon.wakePhrases, phrase)
    const clips = { ...(settings.value.summon.wakePhraseClips || {}) }
    if (clipId) clips[phrase] = clipId
    updateSummon({ wakePhrases: merged, wakePhraseClips: clips })
    showRecordModal.value = false
    recordedBlob.value = null
    message.success(t('pages.settings.voiceAssistant.summon.wakePhraseAdded'))
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.settings.voiceAssistant.summon.recordSaveFailed'))
  } finally {
    savingClip.value = false
  }
}

async function playClip(phrase: string) {
  const clipId = clipByPhrase.value.get(phrase.toLowerCase())
  if (!clipId) return
  try {
    if (previewAudio) {
      previewAudio.pause()
      previewAudio = null
    }
    const res = await fetch(`/api/voice/wake-clips/${clipId}/audio`)
    if (!res.ok) throw new Error('clip missing')
    const blob = await res.blob()
    playingClipId.value = clipId
    previewAudio = new Audio(URL.createObjectURL(blob))
    previewAudio.onended = () => {
      playingClipId.value = null
    }
    await previewAudio.play()
  } catch {
    playingClipId.value = null
    message.warning(t('pages.settings.voiceAssistant.summon.clipPlayFailed'))
  }
}

onUnmounted(() => {
  if (previewAudio) {
    previewAudio.pause()
    previewAudio = null
  }
  if (isRecording.value) void stopRecording()
})
</script>

<template>
  <div class="wake-phrase-editor">
    <NText strong>{{ t('pages.settings.voiceAssistant.summon.wakePhrases') }}</NText>
    <NText depth="3" style="display: block; font-size: 13px; margin-top: 4px">
      {{ t('pages.settings.voiceAssistant.summon.wakePhrasesHint') }}
    </NText>

    <NText depth="2" style="display: block; margin-top: 12px; font-size: 13px">
      {{ t('pages.settings.voiceAssistant.summon.builtinPhrases') }}
    </NText>
    <NCheckboxGroup v-model:value="builtinSelected" :disabled="disabled" style="margin-top: 8px">
      <NSpace>
        <NCheckbox v-for="opt in phraseOptions" :key="opt.value" :value="opt.value" :label="opt.label" />
      </NSpace>
    </NCheckboxGroup>

    <NText depth="2" style="display: block; margin-top: 16px; font-size: 13px">
      {{ t('pages.settings.voiceAssistant.summon.customPhrases') }}
    </NText>

    <NSpace v-if="customPhrases.length" wrap style="margin-top: 8px">
      <NTag
        v-for="phrase in customPhrases"
        :key="phrase"
        closable
        :disabled="disabled"
        @close="removeCustomPhrase(phrase)"
      >
        <NSpace :size="4" align="center">
          <span>{{ phrase }}</span>
          <NButton
            v-if="clipByPhrase.has(phrase.toLowerCase())"
            text
            size="tiny"
            :disabled="disabled"
            @click.stop="playClip(phrase)"
          >
            <NIcon :component="VolumeHighOutline" />
          </NButton>
        </NSpace>
      </NTag>
    </NSpace>
    <NText v-else depth="3" style="display: block; margin-top: 8px; font-size: 13px">
      {{ t('pages.settings.voiceAssistant.summon.noCustomPhrases') }}
    </NText>

    <NSpace align="center" style="margin-top: 12px" wrap>
      <NInput
        v-model:value="draftPhrase"
        :disabled="disabled"
        :placeholder="t('pages.settings.voiceAssistant.summon.wakePhrasePlaceholder')"
        style="width: min(360px, 100%)"
        @keyup.enter="addDraftPhrase"
      />
      <NButton :disabled="disabled" @click="addDraftPhrase">
        {{ t('pages.settings.voiceAssistant.summon.addWakePhrase') }}
      </NButton>
      <NSpin :show="isTranscribing" size="small">
        <NButton
          :type="isRecording ? 'error' : 'default'"
          :disabled="disabled || isTranscribing"
          @click="isRecording ? finishWakeRecord() : startWakeRecord()"
        >
          <template #icon>
            <NIcon :component="isRecording ? StopOutline : MicOutline" />
          </template>
          {{
            isRecording
              ? t('pages.settings.voiceAssistant.summon.stopRecordWake')
              : t('pages.settings.voiceAssistant.summon.recordWakePhrase')
          }}
        </NButton>
      </NSpin>
    </NSpace>
    <NText depth="3" style="display: block; font-size: 12px; margin-top: 6px">
      {{ t('pages.settings.voiceAssistant.summon.recordWakeHint') }}
    </NText>

    <NModal
      v-model:show="showRecordModal"
      preset="dialog"
      :title="t('pages.settings.voiceAssistant.summon.confirmRecordedPhrase')"
      :positive-text="t('pages.settings.voiceAssistant.summon.confirmAdd')"
      :negative-text="t('pages.settings.voiceAssistant.summon.reRecord')"
      :loading="savingClip"
      @positive-click="onConfirmRecorded"
      @negative-click="onReRecord"
    >
      <NInput
        v-model:value="recordedPhrase"
        :placeholder="t('pages.settings.voiceAssistant.summon.wakePhrasePlaceholder')"
      />
    </NModal>
  </div>
</template>
