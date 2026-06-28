<script setup lang="ts">
import { computed, watch } from 'vue'
import { NIcon, NSpin } from 'naive-ui'
import {
  CheckmarkCircleOutline,
  AlertCircleOutline,
  ChevronUpOutline,
  ChevronDownOutline,
  TimeOutline,
} from '@vicons/ionicons5'
import { useDownloadManager } from '@/composables/useDownloadManager'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const {
  items,
  expanded,
  doneCount,
  totalCount,
  allDone,
  hasAny,
  scheduleDismiss,
  toggleExpanded,
  clearAll,
} = useDownloadManager()

const collapsedLabel = computed(() => {
  if (allDone.value) return t('downloadToast.allDone')
  return t('downloadToast.progress', { done: doneCount.value, total: totalCount.value })
})

watch(allDone, (val) => {
  if (val) scheduleDismiss(4000)
})

function statusIcon(status: string) {
  if (status === 'done') return CheckmarkCircleOutline
  if (status === 'error') return AlertCircleOutline
  if (status === 'pending') return TimeOutline
  return null // active — spinner
}

function statusColor(status: string) {
  if (status === 'done') return 'var(--success-color, #18a058)'
  if (status === 'error') return 'var(--error-color, #d03050)'
  if (status === 'pending') return 'var(--text-color-3, #999)'
  return 'var(--primary-color, #18a058)'
}
</script>

<template>
  <Teleport to="body">
    <Transition name="toast-slide">
      <div v-if="hasAny" class="download-toast">
        <!-- Header row (always visible) -->
        <div class="toast-header" @click="toggleExpanded">
          <div class="toast-header-left">
            <NSpin v-if="!allDone" size="small" class="toast-spinner" />
            <NIcon
              v-else
              :component="CheckmarkCircleOutline"
              size="16"
              style="color: var(--success-color, #18a058); flex-shrink: 0"
            />
            <span class="toast-label">{{ collapsedLabel }}</span>
          </div>
          <div class="toast-header-right">
            <NIcon
              :component="expanded ? ChevronDownOutline : ChevronUpOutline"
              size="14"
              class="toast-chevron"
            />
            <button class="toast-close" @click.stop="clearAll">✕</button>
          </div>
        </div>

        <!-- Expanded item list -->
        <Transition name="toast-expand">
          <div v-if="expanded" class="toast-body">
            <div
              v-for="item in items"
              :key="item.id"
              class="toast-item"
            >
              <div class="toast-item-icon">
                <NSpin v-if="item.status === 'active'" :size="14" />
                <NIcon
                  v-else-if="statusIcon(item.status)"
                  :component="statusIcon(item.status)!"
                  size="14"
                  :style="{ color: statusColor(item.status) }"
                />
              </div>
              <div class="toast-item-text">
                <span class="toast-item-label">{{ item.label }}</span>
                <span v-if="item.detail" class="toast-item-detail">{{ item.detail }}</span>
              </div>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.download-toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 9999;
  min-width: 260px;
  max-width: 360px;
  background: var(--card-color, #fff);
  border: 1px solid var(--border-color, #e0e0e0);
  border-radius: 10px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.14);
  overflow: hidden;
  font-size: 13px;
}

.toast-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  cursor: pointer;
  user-select: none;
  gap: 8px;
}

.toast-header:hover {
  background: var(--hover-color, rgba(0,0,0,0.03));
}

.toast-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.toast-spinner {
  flex-shrink: 0;
}

.toast-label {
  font-weight: 500;
  color: var(--text-color-1, #333);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toast-header-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.toast-chevron {
  color: var(--text-color-3, #999);
}

.toast-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-color-3, #999);
  font-size: 12px;
  padding: 0 2px;
  line-height: 1;
}

.toast-close:hover {
  color: var(--text-color-1, #333);
}

.toast-body {
  border-top: 1px solid var(--border-color, #e0e0e0);
  padding: 8px 0;
  max-height: 240px;
  overflow-y: auto;
}

.toast-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 6px 14px;
}

.toast-item-icon {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 1px;
}

.toast-item-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.toast-item-label {
  font-weight: 500;
  color: var(--text-color-1, #333);
}

.toast-item-detail {
  font-size: 12px;
  color: var(--text-color-3, #888);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Slide-up entrance */
.toast-slide-enter-active,
.toast-slide-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.toast-slide-enter-from,
.toast-slide-leave-to {
  opacity: 0;
  transform: translateY(12px);
}

/* Expand/collapse body */
.toast-expand-enter-active,
.toast-expand-leave-active {
  transition: max-height 0.2s ease, opacity 0.2s ease;
  overflow: hidden;
}
.toast-expand-enter-from,
.toast-expand-leave-to {
  max-height: 0;
  opacity: 0;
}
.toast-expand-enter-to,
.toast-expand-leave-from {
  max-height: 240px;
  opacity: 1;
}
</style>
