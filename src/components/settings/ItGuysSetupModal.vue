<script setup lang="ts">
import { ref, watch } from 'vue'
import { NModal, NForm, NFormItem, NInput, NButton, NSpace, useMessage } from 'naive-ui'

const props = defineProps<{
  show: boolean
  agentName?: string
  needCursorKey?: boolean
  needCodexKey?: boolean
  needClaudeKey?: boolean
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  saved: []
  skip: []
}>()

const message = useMessage()
const saving = ref(false)
const cursorApiKey = ref('')
const codexApiKey = ref('')
const claudeApiKey = ref('')

watch(
  () => props.show,
  (open) => {
    if (open) {
      cursorApiKey.value = ''
      codexApiKey.value = ''
      claudeApiKey.value = ''
    }
  },
)

function close() {
  emit('update:show', false)
}

async function save() {
  const body: Record<string, string> = {}
  const cKey = cursorApiKey.value.trim()
  const dKey = codexApiKey.value.trim()
  const clKey = claudeApiKey.value.trim()
  if (props.needCursorKey && !cKey) {
    message.warning('请填写 Cursor API Key')
    return
  }
  if (props.needCodexKey && !dKey) {
    message.warning('请填写 Codex / OpenAI API Key')
    return
  }
  if (props.needClaudeKey && !clKey) {
    message.warning('请填写 Claude API Key')
    return
  }
  if (cKey) body.cursorApiKey = cKey
  if (dKey) body.codexApiKey = dKey
  if (clKey) body.claudeApiKey = clKey
  if (!Object.keys(body).length) {
    close()
    emit('skip')
    return
  }

  saving.value = true
  try {
    const res = await fetch('/api/dev/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || 'Save failed')
    if (dKey && data.codexLogin && !data.codexLogin.ok) {
      message.warning(`Key 已保存，Codex 登录待确认：${data.codexLogin.error || 'unknown'}`)
    } else {
      message.success('开发凭证已保存')
    }
    close()
    emit('saved')
  } catch (e) {
    message.error(e instanceof Error ? e.message : '保存失败')
  } finally {
    saving.value = false
  }
}

function onSkip() {
  close()
  emit('skip')
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :title="`${agentName || 'Developer'} — 配置开发凭证`"
    style="max-width: 520px"
    :mask-closable="false"
    @update:show="emit('update:show', $event)"
  >
    <p class="hint sm setup-intro">
      和 Facebook 发帖前需要您登录一样，开发流水线写代码/审核前需要您提供自己的 API Key。
      凭证只保存在本机，不会上传到服务器。
    </p>

    <NForm label-placement="top">
      <NFormItem v-if="needCursorKey" label="Cursor API Key" :show-feedback="false">
        <NInput
          v-model:value="cursorApiKey"
          type="password"
          show-password-on="click"
          placeholder="从 cursor.com/dashboard 获取"
        />
      </NFormItem>
      <NFormItem v-if="needClaudeKey" label="Claude API Key" :show-feedback="false">
        <NInput
          v-model:value="claudeApiKey"
          type="password"
          show-password-on="click"
          placeholder="从 console.anthropic.com 获取"
        />
      </NFormItem>
      <NFormItem v-if="needCodexKey" label="Codex / OpenAI API Key" :show-feedback="false">
        <NInput
          v-model:value="codexApiKey"
          type="password"
          show-password-on="click"
          placeholder="从 platform.openai.com/api-keys 获取"
        />
      </NFormItem>
    </NForm>

    <p class="hint sm">
      稍后可在 <strong>Settings → Dev tools</strong> 修改。不用放在 Account &amp; Password（那是网站登录账号）。
    </p>

    <template #footer>
      <NSpace justify="end">
        <NButton @click="onSkip">稍后配置</NButton>
        <NButton type="primary" :loading="saving" @click="save">保存并启用</NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.setup-intro {
  margin: 0 0 16px;
  line-height: 1.5;
}
</style>
