<script setup lang="ts">
import { onMounted } from 'vue'
import { NAlert } from 'naive-ui'
import { useOfficeShareStore } from '@/stores/officeShare'

const officeShare = useOfficeShareStore()

onMounted(() => {
  void officeShare.refresh()
})
</script>

<template>
  <NAlert
    v-if="officeShare.isMemberClient"
    type="info"
    :bordered="false"
    style="margin: 0 16px 8px; border-radius: 8px"
  >
    Viewing shared office at <strong>{{ officeShare.share?.hostUrl }}</strong> (read-only).
    Hire and MCP changes require the host.
  </NAlert>
</template>
