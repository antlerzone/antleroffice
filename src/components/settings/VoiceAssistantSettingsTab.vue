<script setup lang="ts">
import { NCollapse, NCollapseItem } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import VoiceSetupWizard from '@/components/settings/VoiceSetupWizard.vue'
import SummonSettingsTab from '@/components/settings/SummonSettingsTab.vue'
import VoiceSettingsTab from '@/components/settings/VoiceSettingsTab.vue'
import PersonaSettingsTab from '@/components/settings/PersonaSettingsTab.vue'
import RealtimeSettingsSection from '@/components/settings/RealtimeSettingsSection.vue'
import DailyStandupSettingsTab from '@/components/settings/DailyStandupSettingsTab.vue'
import CooHeartbeatSettingsTab from '@/components/settings/CooHeartbeatSettingsTab.vue'

withDefaults(defineProps<{ cardClass?: string }>(), { cardClass: '' })
const { t } = useI18n()
</script>

<template>
  <div class="voice-assistant-settings">
    <VoiceSetupWizard />

    <PersonaSettingsTab section="core" :card-class="cardClass" />
    <SummonSettingsTab section="core" :card-class="cardClass" />
    <VoiceSettingsTab section="core" :card-class="cardClass" />

    <NCollapse class="voice-advanced-collapse">
      <NCollapseItem
        :title="t('pages.settings.voiceAssistant.merged.advancedTitle')"
        name="advanced"
      >
        <NCollapse class="voice-advanced-nested">
          <NCollapseItem
            :title="t('pages.settings.voiceAssistant.merged.personaAdvanced')"
            name="persona-advanced"
          >
            <PersonaSettingsTab section="advanced" :card-class="cardClass" />
          </NCollapseItem>

          <NCollapseItem
            :title="t('pages.settings.voiceAssistant.merged.summonAdvanced')"
            name="summon-advanced"
          >
            <SummonSettingsTab section="advanced" :card-class="cardClass" />
          </NCollapseItem>

          <NCollapseItem
            :title="t('pages.settings.voiceAssistant.merged.voiceAdvanced')"
            name="voice-advanced"
          >
            <VoiceSettingsTab section="advanced" :card-class="cardClass" />
          </NCollapseItem>

          <NCollapseItem
            :title="t('pages.settings.voiceAssistant.merged.realtimeAdvanced')"
            name="realtime"
          >
            <RealtimeSettingsSection bare :card-class="cardClass" />
          </NCollapseItem>

          <NCollapseItem
            :title="t('pages.settings.voiceAssistant.merged.standupAdvanced')"
            name="standup"
          >
            <DailyStandupSettingsTab :card-class="cardClass" />
          </NCollapseItem>

          <NCollapseItem
            :title="t('pages.settings.voiceAssistant.merged.cooAdvanced')"
            name="coo"
          >
            <CooHeartbeatSettingsTab :card-class="cardClass" />
          </NCollapseItem>
        </NCollapse>
      </NCollapseItem>
    </NCollapse>
  </div>
</template>

<style scoped>
.voice-assistant-settings :deep(.office-settings-card) {
  margin-top: 16px;
}
.voice-advanced-collapse {
  margin-top: 20px;
}
.voice-advanced-nested {
  margin-top: 4px;
}
</style>
