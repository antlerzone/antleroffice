<script setup lang="ts">
import { computed } from 'vue'
import { NCard, NForm, NFormItem, NInput, NSwitch, NText, NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import { useOfficeProfile } from '@/composables/useOfficeProfile'

withDefaults(defineProps<{ cardClass?: string }>(), { cardClass: '' })

const { t } = useI18n()
const message = useMessage()
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

async function onSaveFramework() {
  try {
    await save({})
    message.success(t('pages.settings.saveSuccess'))
  } catch (e) {
    message.error(e instanceof Error ? e.message : t('pages.settings.saveFailed'))
  }
}

const statusHint = computed(() =>
  frameworkConfigured.value
    ? t('pages.settings.companyFramework.configuredHint')
    : t('pages.settings.companyFramework.missingHint'),
)
</script>

<template>
  <NCard :title="t('pages.settings.companyFramework.title')" :class="cardClass">
    <NText depth="3" style="display: block; margin-bottom: 12px">
      {{ t('pages.settings.companyFramework.intro') }}
    </NText>
    <NForm label-placement="top" style="max-width: 640px">
      <NFormItem :show-label="false">
        <NSwitch v-model:value="frameworkEnabled" />
        <NText style="margin-left: 8px">{{ t('pages.settings.companyFramework.enabled') }}</NText>
      </NFormItem>
      <NFormItem :label="t('pages.settings.companyFramework.productName')" :show-feedback="false">
        <NInput
          v-model:value="productName"
          maxlength="120"
          :placeholder="t('pages.settings.companyFramework.productNamePlaceholder')"
        />
      </NFormItem>
      <NFormItem :label="t('pages.settings.companyFramework.productSummary')" :show-feedback="false">
        <NInput
          v-model:value="productSummary"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 8 }"
          :placeholder="t('pages.settings.companyFramework.productSummaryPlaceholder')"
        />
      </NFormItem>
      <NFormItem :label="t('pages.settings.companyFramework.inScope')" :show-feedback="false">
        <NInput
          v-model:value="inScopeText"
          type="textarea"
          :autosize="{ minRows: 4, maxRows: 10 }"
          :placeholder="t('pages.settings.companyFramework.inScopePlaceholder')"
        />
      </NFormItem>
      <NFormItem :label="t('pages.settings.companyFramework.outOfScope')" :show-feedback="false">
        <NInput
          v-model:value="outOfScopeText"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 8 }"
          :placeholder="t('pages.settings.companyFramework.outOfScopePlaceholder')"
        />
      </NFormItem>
      <NFormItem :label="t('pages.settings.companyFramework.futurePlan')" :show-feedback="false">
        <NInput
          v-model:value="futurePlanText"
          type="textarea"
          :autosize="{ minRows: 4, maxRows: 12 }"
          :placeholder="t('pages.settings.companyFramework.futurePlanPlaceholder')"
        />
      </NFormItem>
      <NFormItem :label="t('pages.settings.companyFramework.primaryRepo')" :show-feedback="false">
        <NInput
          v-model:value="primaryRepo"
          maxlength="500"
          :placeholder="t('pages.settings.companyFramework.primaryRepoPlaceholder')"
        />
      </NFormItem>
      <NFormItem :show-label="false">
        <NButton type="primary" @click="onSaveFramework">{{ t('pages.settings.save') }}</NButton>
      </NFormItem>
    </NForm>
    <p class="hint sm" :class="{ 'hint-warn': !frameworkConfigured }">{{ statusHint }}</p>
  </NCard>
</template>

<style scoped>
.hint-warn {
  color: #e8a838;
}
</style>
