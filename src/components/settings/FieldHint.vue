<script setup lang="ts">
import { NTooltip } from 'naive-ui'

defineProps<{ text: string }>()
</script>

<template>
  <NTooltip trigger="hover" placement="top" :style="{ maxWidth: '300px' }">
    <template #trigger>
      <span
        style="cursor: help; opacity: 0.5; font-size: 13px; margin-left: 4px; user-select: none"
        >&#9432;</span
      >
    </template>
    {{ text }}
  </NTooltip>
</template>
