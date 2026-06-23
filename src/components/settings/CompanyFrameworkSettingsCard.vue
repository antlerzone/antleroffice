<script setup lang="ts">
import { computed } from 'vue'
import { NCard, NSwitch, NText, NButton, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import { useOfficeProfile } from '@/composables/useOfficeProfile'
import { useAiSetupStore } from '@/stores/aiSetup'

withDefaults(defineProps<{ cardClass?: string }>(), { cardClass: '' })

const { t } = useI18n()
const message = useMessage()
const aiSetup = useAiSetupStore()
const {
  frameworkEnabled,
  productName,
  productSummary,
  inScopeText,
  outOfScopeText,
  futurePlanText,
  primaryRepo,
  frameworkConfigured,
  save,
} = useOfficeProfile()

async function toggleEnabled() {
  try {
    await save({})
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.settings.saveFailed'))
  }
}

const rows = computed(() => [
  { label: t('pages.settings.companyFramework.productName'), value: productName.value },
  { label: t('pages.settings.companyFramework.productSummary'), value: productSummary.value },
  { label: t('pages.settings.companyFramework.inScope'), value: inScopeText.value },
  { label: t('pages.settings.companyFramework.outOfScope'), value: outOfScopeText.value },
  { label: t('pages.settings.companyFramework.futurePlan'), value: futurePlanText.value },
  { label: t('pages.settings.companyFramework.primaryRepo'), value: primaryRepo.value },
].filter(r => r.value?.trim()))
</script>

<template>
  <NCard :title="t('pages.settings.companyFramework.title')" :class="cardClass">
    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px">
      <NSwitch v-model:value="frameworkEnabled" @update:value="toggleEnabled" />
      <NText>{{ t('pages.settings.companyFramework.enabled') }}</NText>
      <NTag v-if="frameworkConfigured" type="success" size="small">Configured</NTag>
      <NTag v-else type="warning" size="small">Not configured</NTag>
    </div>

    <div v-if="rows.length" class="framework-display">
      <div v-for="row in rows" :key="row.label" class="framework-row">
        <NText depth="3" class="framework-label">{{ row.label }}</NText>
        <NText class="framework-value">{{ row.value }}</NText>
      </div>
    </div>
    <div v-else style="margin-bottom: 12px">
      <NText depth="3">{{ t('pages.settings.companyFramework.missingHint') }}</NText>
    </div>

    <div class="framework-hint-box">
      <NText depth="3" style="font-size: 12px">
        💬 To update, chat with COO — e.g. "Update our company profile: we build X for Y audience."
      </NText>
      <NButton
        size="small"
        secondary
        style="margin-top: 8px"
        @click="aiSetup.open()"
      >
        Re-run onboarding wizard
      </NButton>
    </div>
  </NCard>
</template>

<style scoped>
.framework-display {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-bottom: 16px;
  max-width: 640px;
}
.framework-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.framework-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.framework-value {
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.6;
}
.framework-hint-box {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 10px 14px;
  border-radius: 6px;
  background: var(--n-color-embedded, rgba(128,128,128,0.06));
  border: 1px solid var(--n-border-color, rgba(128,128,128,0.2));
  margin-top: 4px;
}
</style>
