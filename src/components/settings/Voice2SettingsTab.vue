<script setup lang="ts">
// Voice v2 设置：唤醒词、一直听开关、音色、模型、TTS 供应商。本地保存。
import { computed, ref } from 'vue'
import { NCard, NForm, NFormItem, NInput, NSwitch, NSelect, NText, NSpace, NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useVoice2Settings, type Voice2TtsProvider } from '@/composables/useVoice2Settings'
import { useOfficeProfile } from '@/composables/useOfficeProfile'

defineProps<{ cardClass?: string }>()

const { t } = useI18n()
const { settings } = useVoice2Settings()

function addRow(arr: string[]) { arr.push('') }
function removeRow(arr: string[], i: number) { arr.splice(i, 1) }

const wakeBusy = ref(false)
async function applyWakeWord() {
  wakeBusy.value = true
  try {
    await fetch('/api/voice2/wake-word', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phrases: settings.wakePhrases }),
    })
  } catch { /* 推送失败忽略 */ } finally {
    wakeBusy.value = false
  }
}

const genBusy = ref(false)
async function generateGreeting() {
  genBusy.value = true
  try {
    const { bossDisplayName, load } = useOfficeProfile()
    if (!bossDisplayName.value) await load().catch(() => {})
    const r = await fetch('/api/voice2/generate-greeting', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ soul: settings.soul, bossName: bossDisplayName.value || '' }),
    })
    const d = await r.json()
    if (d.ok && d.greeting) settings.greeting = d.greeting
  } catch { /* 生成失败就不动 */ } finally {
    genBusy.value = false
  }
}

const voiceOptions = ['cedar', 'marin', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse']
  .map((v) => ({ label: v, value: v }))

const ttsOptions = computed<{ label: string; value: Voice2TtsProvider }[]>(() => [
  { label: t('voice2.settings.providerOpenai'), value: 'openai' },
  { label: t('voice2.settings.providerEleven'), value: 'elevenlabs' },
  { label: t('voice2.settings.providerFish'), value: 'fish' },
])

const isExternal = computed(() => settings.ttsProvider !== 'openai')
</script>

<template>
  <NSpace vertical :size="16">
    <NCard :title="t('voice2.settings.assistantTitle')" :class="cardClass" size="small">
      <NForm label-placement="left" :label-width="120">
        <NFormItem :label="t('voice2.settings.soul')">
          <NSpace vertical :size="4" style="width:100%">
            <NInput
              v-model:value="settings.soul"
              type="textarea"
              :autosize="{ minRows: 3, maxRows: 8 }"
              :placeholder="t('voice2.settings.soulPlaceholder')"
            />
            <NText depth="3" style="font-size:12px">{{ t('voice2.settings.soulHint') }}</NText>
          </NSpace>
        </NFormItem>

        <NFormItem :label="t('voice2.settings.greeting')">
          <NSpace vertical :size="4" style="width:100%">
            <NSpace :size="8" :wrap="false" align="center" style="width:100%">
              <NInput v-model:value="settings.greeting" :placeholder="t('voice2.settings.greetingPlaceholder')" />
              <NButton :loading="genBusy" @click="generateGreeting">{{ t('voice2.settings.generate') }}</NButton>
            </NSpace>
            <NText depth="3" style="font-size:12px">{{ t('voice2.settings.greetingHint') }}</NText>
          </NSpace>
        </NFormItem>

        <NFormItem :label="t('voice2.settings.sleepPhrases')">
          <NSpace vertical :size="6" style="width:100%">
            <NSpace v-for="(_, i) in settings.sleepPhrases" :key="i" :size="8" :wrap="false" align="center" style="width:100%">
              <NInput v-model:value="settings.sleepPhrases[i]" :placeholder="t('voice2.settings.sleepPhrasesPlaceholder')" />
              <NButton quaternary circle :title="t('voice2.settings.removeRow')" @click="removeRow(settings.sleepPhrases, i)">🗑️</NButton>
            </NSpace>
            <NButton dashed size="small" @click="addRow(settings.sleepPhrases)">＋ {{ t('voice2.settings.addRow') }}</NButton>
            <NText depth="3" style="font-size:12px">{{ t('voice2.settings.sleepPhrasesHint') }}</NText>
          </NSpace>
        </NFormItem>

        <NFormItem :label="t('voice2.settings.sleepReply')">
          <NSpace vertical :size="4" style="width:100%">
            <NInput v-model:value="settings.sleepReply" :placeholder="t('voice2.settings.sleepReplyPlaceholder')" />
            <NText depth="3" style="font-size:12px">{{ t('voice2.settings.sleepReplyHint') }}</NText>
          </NSpace>
        </NFormItem>

        <NFormItem :label="t('voice2.settings.alwaysListen')">
          <NSpace vertical :size="4" style="width:100%">
            <NSwitch v-model:value="settings.localWake" />
            <NText depth="3" style="font-size:12px">{{ t('voice2.settings.alwaysListenHint') }}</NText>
          </NSpace>
        </NFormItem>

        <NFormItem :label="t('voice2.settings.wakePhrase')">
          <NSpace vertical :size="6" style="width:100%">
            <NSpace v-for="(_, i) in settings.wakePhrases" :key="i" :size="8" :wrap="false" align="center" style="width:100%">
              <NInput v-model:value="settings.wakePhrases[i]" placeholder="邓紫棋" />
              <NButton
                quaternary circle
                :disabled="settings.wakePhrases.length <= 1"
                :title="t('voice2.settings.removeRow')"
                @click="removeRow(settings.wakePhrases, i)"
              >🗑️</NButton>
            </NSpace>
            <NSpace :size="8">
              <NButton dashed size="small" @click="addRow(settings.wakePhrases)">＋ {{ t('voice2.settings.addRow') }}</NButton>
              <NButton size="small" type="primary" :loading="wakeBusy" @click="applyWakeWord">{{ t('voice2.settings.applyWake') }}</NButton>
            </NSpace>
            <NText depth="3" style="font-size:12px">{{ t('voice2.settings.wakePhraseHint') }}</NText>
          </NSpace>
        </NFormItem>

        <NFormItem :label="t('voice2.settings.model')">
          <NInput v-model:value="settings.model" placeholder="gpt-realtime" />
        </NFormItem>
      </NForm>
    </NCard>

    <NCard :title="t('voice2.settings.ttsTitle')" :class="cardClass" size="small">
      <NForm label-placement="left" :label-width="120">
        <NFormItem :label="t('voice2.settings.provider')">
          <NSelect v-model:value="settings.ttsProvider" :options="ttsOptions" style="max-width:280px" />
        </NFormItem>

        <NFormItem v-if="settings.ttsProvider === 'openai'" :label="t('voice2.settings.voice')">
          <NSelect v-model:value="settings.voice" :options="voiceOptions" style="max-width:280px" />
        </NFormItem>

        <NFormItem v-if="settings.ttsProvider === 'elevenlabs'" :label="t('voice2.settings.elevenKey')">
          <NInput v-model:value="settings.elevenLabsKey" type="password" show-password-on="click" placeholder="el_..." />
        </NFormItem>
        <NFormItem v-if="settings.ttsProvider === 'elevenlabs'" :label="t('voice2.settings.elevenVoiceId')">
          <NInput v-model:value="settings.elevenVoiceId" placeholder="e.g. 21m00Tcm4TlvDq8ikWAM" />
        </NFormItem>

        <NFormItem v-if="settings.ttsProvider === 'fish'" :label="t('voice2.settings.fishKey')">
          <NInput v-model:value="settings.fishKey" type="password" show-password-on="click" placeholder="fish_..." />
        </NFormItem>
        <NFormItem v-if="settings.ttsProvider === 'fish'" :label="t('voice2.settings.fishVoiceId')">
          <NInput v-model:value="settings.fishVoiceId" placeholder="Fish referenceId" />
        </NFormItem>

        <NText v-if="isExternal" depth="3" style="font-size:12px">{{ t('voice2.settings.externalHint') }}</NText>
      </NForm>
    </NCard>

    <NCard :class="cardClass" size="small">
      <NText depth="3" style="font-size:12px">{{ t('voice2.settings.keyNote') }}</NText>
    </NCard>
  </NSpace>
</template>
