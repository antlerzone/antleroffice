<script setup lang="ts">
import { computed } from 'vue'
import { NButton } from 'naive-ui'

const props = defineProps<{
  period: string
  label: string
  canGoNext?: boolean
}>()

const emit = defineEmits<{
  prev: []
  next: []
}>()

const nextDisabled = computed(() => props.canGoNext === false)
</script>

<template>
  <div class="month-nav">
    <NButton quaternary circle size="small" aria-label="Previous month" @click="emit('prev')">
      ◀
    </NButton>
    <span class="month-label">{{ label }}</span>
    <NButton
      quaternary
      circle
      size="small"
      aria-label="Next month"
      :disabled="nextDisabled"
      @click="emit('next')"
    >
      ▶
    </NButton>
  </div>
</template>

<style scoped>
.month-nav {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.month-label {
  min-width: 7rem;
  text-align: center;
  font-weight: 600;
  font-size: 1rem;
}
</style>
