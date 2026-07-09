<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import {
  NCard,
  NForm,
  NFormItem,
  NInput,
  NButton,
  NTag,
  NSpace,
  NSpin,
  NSelect,
  NSwitch,
  useMessage,
} from 'naive-ui'
import {
  pollDevCliInstallLog,
  fetchCursorInstalled,
  fetchCodexInstalled,
  fetchClaudeInstalled,
} from '@/lib/dev-cli-install'

defineProps<{ cardClass?: string }>()

type DevAgent = {
  id: string
  name: string
  devEngine: string
  devScope: { canWrite: boolean; canReview: boolean }
}

const message = useMessage()
const loading = ref(true)
const installingCursor = ref(false)
const installingCodex = ref(false)
const installingClaude = ref(false)
const saving = ref(false)

const cursorInstalled = ref(false)
const cursorVersion = ref('')
const cursorApiKeySet = ref(false)
const cursorApiKey = ref('')
const codexInstalled = ref(false)
const codexVersion = ref('')
const codexApiKeySet = ref(false)
const codexAuthReady = ref(false)
const codexApiKey = ref('')
const claudeInstalled = ref(false)
const claudeVersion = ref('')
const claudeApiKeySet = ref(false)
const claudeApiKey = ref('')
const cursorApiKeyMasked = ref('')
const codexApiKeyMasked = ref('')
const claudeApiKeyMasked = ref('')

const projectRootOverride = ref('')
const ctoSshEnabled = ref(false)
const ctoServerHost = ref('')
const ctoServerUser = ref('')
const installLog = ref('')

const devAgents = ref<DevAgent[]>([])
const writerAgentId = ref<string | null>(null)
const reviewerAgentIds = ref<string[]>([])

const writerOptions = computed(() =>
  devAgents.value
    .filter(() => true)
    .map((a) => ({ label: `${a.name} (${a.devEngine})`, value: a.id })),
)

const reviewerOptions = computed(() =>
  devAgents.value
    .filter((a) => a.devScope.canReview)
    .map((a) => ({ label: `${a.name} (${a.devEngine})`, value: a.id })),
)

async function loadDevAgents() {
  try {
    const res = await fetch('/api/dev/agents')
    const data = await res.json()
    if (res.ok && data.ok) {
      devAgents.value = data.agents || []
      writerAgentId.value = data.devTeam?.writerAgentId || null
      reviewerAgentIds.value = Array.isArray(data.devTeam?.reviewerAgentIds)
        ? data.devTeam.reviewerAgentIds
        : []
    }
  } catch {
    /* non-fatal */
  }
}

async function loadStatus() {
  loading.value = true
  try {
    const [toolsRes, settingsRes] = await Promise.all([
      fetch('/api/dev/tools/status'),
      fetch('/api/dev/settings'),
    ])
    const tools = await toolsRes.json()
    if (toolsRes.ok && tools.ok) {
      cursorInstalled.value = !!tools.cursor?.installed
      cursorVersion.value = tools.cursor?.version || ''
      cursorApiKeySet.value = !!tools.cursor?.apiKeySet
      codexInstalled.value = !!tools.codex?.installed
      codexVersion.value = tools.codex?.version || ''
      codexApiKeySet.value = !!tools.codex?.apiKeySet
      codexAuthReady.value = !!tools.codex?.authReady
      claudeInstalled.value = !!tools.claude?.installed
      claudeVersion.value = tools.claude?.version || ''
      claudeApiKeySet.value = !!tools.claude?.apiKeySet
    }
    const settings = await settingsRes.json()
    if (settingsRes.ok && settings.ok) {
      projectRootOverride.value = settings.dev?.projectRootOverride || ''
      ctoSshEnabled.value = !!settings.dev?.serverAccess?.sshEnabled
      ctoServerHost.value = settings.dev?.serverAccess?.host || ''
      ctoServerUser.value = settings.dev?.serverAccess?.user || ''
      cursorApiKeySet.value = !!settings.dev?.cursorApiKeySet
      codexApiKeySet.value = !!settings.dev?.codexApiKeySet
      claudeApiKeySet.value = !!settings.dev?.claudeApiKeySet
      cursorApiKeyMasked.value = settings.dev?.cursorApiKeyMasked || ''
      codexApiKeyMasked.value = settings.dev?.codexApiKeyMasked || ''
      claudeApiKeyMasked.value = settings.dev?.claudeApiKeyMasked || ''
      codexAuthReady.value = !!settings.dev?.codexAuthReady
      cursorApiKey.value = ''
      codexApiKey.value = ''
      claudeApiKey.value = ''
    }
    await loadDevAgents()
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Could not load dev tools status')
  } finally {
    loading.value = false
  }
}

async function pollInstallLog() {
  installLog.value = (
    await pollDevCliInstallLog(120, 2000, (_installing, lines) => {
      installLog.value = lines.join('\n')
    })
  ).join('\n')
  cursorInstalled.value = await fetchCursorInstalled()
  codexInstalled.value = await fetchCodexInstalled()
  claudeInstalled.value = await fetchClaudeInstalled()
  await loadStatus()
}

async function installCli(name: 'cursor' | 'codex' | 'claude') {
  const flags = { cursor: installingCursor, codex: installingCodex, claude: installingClaude }
  flags[name].value = true
  installLog.value = ''
  try {
    const res = await fetch('/api/onboard/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'Install failed to start')
    message.info(`Installing ${name} CLI…`)
    await pollInstallLog()
    message.success(`${name} CLI installed (or verify in the terminal)`)
  } catch (e) {
    message.error(e instanceof Error ? e.message : `${name} install failed`)
  } finally {
    flags[name].value = false
  }
}

async function saveDevSettings() {
  saving.value = true
  try {
    const body: Record<string, unknown> = {
      projectRootOverride: projectRootOverride.value.trim() || null,
      devTeam: {
        writerAgentId: writerAgentId.value,
        reviewerAgentIds: reviewerAgentIds.value,
      },
      serverAccess: {
        sshEnabled: ctoSshEnabled.value,
        host: ctoServerHost.value.trim(),
        user: ctoServerUser.value.trim(),
      },
    }
    const key = cursorApiKey.value.trim()
    if (key) body.cursorApiKey = key
    const codexKey = codexApiKey.value.trim()
    if (codexKey) body.codexApiKey = codexKey
    const claudeKey = claudeApiKey.value.trim()
    if (claudeKey) body.claudeApiKey = claudeKey

    const res = await fetch('/api/dev/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || 'Save failed')
    cursorApiKey.value = ''
    codexApiKey.value = ''
    claudeApiKey.value = ''
    cursorApiKeySet.value = !!data.dev?.cursorApiKeySet
    codexApiKeySet.value = !!data.dev?.codexApiKeySet
    claudeApiKeySet.value = !!data.dev?.claudeApiKeySet
    codexAuthReady.value = !!data.dev?.codexAuthReady
    if (codexKey && data.codexLogin && !data.codexLogin.ok) {
      message.warning(`Codex key saved, but CLI login not confirmed: ${data.codexLogin.error || 'unknown'}`)
    } else {
      message.success('Dev settings saved')
    }
    await loadDevAgents()
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Could not save')
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void loadStatus()
  void loadDevAgents()
})
</script>

<template>
  <NSpin :show="loading">
    <NCard title="Developer tools" :class="cardClass">
      <p class="hint sm">
        Hire <strong>Cursor / Claude / Codex Developer</strong> NPCs, then configure CLIs, API keys, and
        <strong>Dev Team</strong> (Writer + Reviewer chain). Each user stores credentials locally.
      </p>

      <NSpace vertical size="large" style="margin-top: 16px">
        <div>
          <div class="row-label">Dev Team</div>
          <NForm label-placement="top" style="max-width: 560px">
            <NFormItem label="Writer" :show-feedback="false">
              <NSelect
                v-model:value="writerAgentId"
                :options="writerOptions"
                clearable
                placeholder="Select developer who writes code"
              />
            </NFormItem>
            <NFormItem label="Reviewer(s) — sequential" :show-feedback="false">
              <NSelect
                v-model:value="reviewerAgentIds"
                :options="reviewerOptions"
                multiple
                clearable
                placeholder="Select one or more reviewers (solo hire = self-review)"
              />
            </NFormItem>
            <p v-if="!devAgents.length" class="hint sm">Hire at least one Developer NPC from the marketplace.</p>
          </NForm>
        </div>

        <div>
          <div class="row-label">CTO server access (SSH / ECS)</div>
          <p class="hint sm" style="margin-top: 0">
            Off by default. Only the CTO can reach the server; when enabled, every CTO action still needs your approval.
            IT Engineer and Reviewer never touch the server.
          </p>
          <NSpace align="center" style="margin: 8px 0">
            <NSwitch v-model:value="ctoSshEnabled" />
            <span class="hint sm">{{ ctoSshEnabled ? 'SSH enabled (still approved per action)' : 'Locked (CTO has no server access)' }}</span>
          </NSpace>
          <NForm v-if="ctoSshEnabled" label-placement="top" style="max-width: 560px">
            <NFormItem label="Server host" :show-feedback="false">
              <NInput v-model:value="ctoServerHost" placeholder="e.g. 10.0.0.5 or your-ecs-host" />
            </NFormItem>
            <NFormItem label="Login user" :show-feedback="false">
              <NInput v-model:value="ctoServerUser" placeholder="e.g. root / ec2-user" />
            </NFormItem>
          </NForm>
        </div>

        <div>
          <div class="row-label">Cursor CLI</div>
          <NSpace align="center">
            <NTag :type="cursorInstalled ? 'success' : 'warning'">
              {{ cursorInstalled ? 'Installed' : 'Not installed' }}
            </NTag>
            <NTag :type="cursorApiKeySet ? 'success' : 'warning'">
              {{ cursorApiKeySet ? 'API key set' : 'API key missing' }}
            </NTag>
            <span v-if="cursorVersion" class="hint sm mono">{{ cursorVersion }}</span>
            <NButton v-if="!cursorInstalled" size="small" type="primary" :loading="installingCursor" @click="installCli('cursor')">
              Install Cursor CLI
            </NButton>
          </NSpace>
        </div>

        <div>
          <div class="row-label">Claude CLI</div>
          <NSpace align="center">
            <NTag :type="claudeInstalled ? 'success' : 'warning'">
              {{ claudeInstalled ? 'Installed' : 'Not installed' }}
            </NTag>
            <NTag :type="claudeApiKeySet ? 'success' : 'warning'">
              {{ claudeApiKeySet ? 'API key set' : 'API key missing' }}
            </NTag>
            <span v-if="claudeVersion" class="hint sm mono">{{ claudeVersion }}</span>
            <NButton v-if="!claudeInstalled" size="small" type="primary" :loading="installingClaude" @click="installCli('claude')">
              Install Claude CLI
            </NButton>
          </NSpace>
        </div>

        <div>
          <div class="row-label">Codex CLI</div>
          <NSpace align="center">
            <NTag :type="codexInstalled ? 'success' : 'warning'">
              {{ codexInstalled ? 'Installed' : 'Not installed' }}
            </NTag>
            <NTag :type="codexAuthReady ? 'success' : 'warning'">
              {{ codexAuthReady ? 'Auth ready' : 'Auth missing' }}
            </NTag>
            <span v-if="codexVersion" class="hint sm mono">{{ codexVersion }}</span>
            <NButton v-if="!codexInstalled" size="small" type="primary" :loading="installingCodex" @click="installCli('codex')">
              Install Codex CLI
            </NButton>
          </NSpace>
          <pre v-if="installLog" class="install-log">{{ installLog }}</pre>
        </div>

        <NForm label-placement="top" style="max-width: 560px">
          <p class="hint sm" style="margin: 0 0 8px">
            Provider API keys live in <strong>Models → Quick provider setup</strong>. The dev CLIs
            pick them up automatically — no need to re-enter them here.
          </p>
          <NFormItem v-if="false" label="Cursor API key" :show-feedback="false">
            <NInput v-model:value="cursorApiKey" type="password" show-password-on="click" :placeholder="cursorApiKeySet ? cursorApiKeyMasked : 'cursor.com/dashboard'" />
          </NFormItem>
          <NFormItem v-if="false" label="Claude API key" :show-feedback="false">
            <NInput v-model:value="claudeApiKey" type="password" show-password-on="click" :placeholder="claudeApiKeySet ? claudeApiKeyMasked : 'console.anthropic.com'" />
          </NFormItem>
          <NFormItem v-if="false" label="Codex / OpenAI API key" :show-feedback="false">
            <NInput v-model:value="codexApiKey" type="password" show-password-on="click" :placeholder="codexApiKeySet ? codexApiKeyMasked : 'platform.openai.com/api-keys'" />
          </NFormItem>
          <NFormItem label="Project path override (optional)" :show-feedback="false">
            <NInput v-model:value="projectRootOverride" placeholder="Leave empty to auto-detect from OpenClaw" />
          </NFormItem>
          <NButton type="primary" :loading="saving" @click="saveDevSettings">Save dev settings</NButton>
        </NForm>
      </NSpace>
    </NCard>
  </NSpin>
</template>

<style scoped>
.row-label {
  font-weight: 600;
  margin-bottom: 8px;
}
.mono {
  font-family: ui-monospace, monospace;
}
.install-log {
  margin-top: 8px;
  padding: 8px;
  font-size: 11px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  max-height: 120px;
  overflow: auto;
}
</style>
