<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { NModal, NButton, useMessage } from 'naive-ui'
import { useAntlerApi } from '@/composables/useAntlerApi'

type ScheduleFreq = 'all' | 'daily' | 'weekly' | 'monthly' | 'yearly'

interface CronSchedule {
  kind?: string
  everyMs?: number
  expr?: string
  at?: number | string
}

interface CronJob {
  id: string
  name?: string
  agentId?: string
  enabled?: boolean
  schedule?: CronSchedule
  scheduleLabel?: string
  nextRunLabel?: string
  payload?: { message?: string; text?: string }
}

interface Agent {
  id: string
  name: string
  openclawAgentId?: string | null
}

const FREQ_KEY = 'antleroffice.scheduleFreq'

const api = useAntlerApi()
const message = useMessage()

const jobs = ref<CronJob[]>([])
const agents = ref<Agent[]>([])
const available = ref(true)
const loading = ref(false)
const addOpen = ref(false)
const addBusy = ref(false)
const addError = ref('')
const search = ref('')
const freqFilter = ref<ScheduleFreq>(
  (localStorage.getItem(FREQ_KEY) as ScheduleFreq) || 'all',
)

const form = ref({
  name: '',
  message: '',
  agentId: 'main',
  repeat: '1d',
  cron: '0 9 * * *',
})

function agentLabel(job: CronJob) {
  const id = job.agentId || 'main'
  if (id === 'main' || id === 'coo') return 'COO · OpenClaw'
  const hit = agents.value.find((a) => a.openclawAgentId === id || a.id === id)
  return hit?.name || id
}

function jobMessage(job: CronJob) {
  return job.payload?.message || job.payload?.text || ''
}

function classifyCronExpr(expr: string): Exclude<ScheduleFreq, 'all'> | 'other' {
  const parts = expr.trim().split(/\s+/)
  if (parts.length < 5) return 'other'
  const dom = parts[2]
  const month = parts[3]
  const dow = parts[4]
  if (month !== '*') return 'yearly'
  if (dow !== '*') return 'weekly'
  if (dom !== '*') return 'monthly'
  return 'daily'
}

function scheduleFrequency(job: CronJob): Exclude<ScheduleFreq, 'all'> | 'other' {
  const s = job.schedule
  if (s?.kind === 'every' && s.everyMs) {
    const day = 86400000
    const ms = s.everyMs
    if (ms <= day * 1.5) return 'daily'
    if (ms <= day * 8) return 'weekly'
    if (ms <= day * 35) return 'monthly'
    if (ms <= day * 400) return 'yearly'
    return 'other'
  }
  if (s?.kind === 'cron' && s.expr) return classifyCronExpr(s.expr)
  const label = (job.scheduleLabel || '').toLowerCase()
  if (/every\s+\d+m|every\s+\d+h/.test(label)) return 'daily'
  if (label.includes('every 1d') || label.includes('every 24')) return 'daily'
  return 'other'
}

function frequencyLabel(job: CronJob) {
  const f = scheduleFrequency(job)
  if (f === 'daily') return 'Daily'
  if (f === 'weekly') return 'Weekly'
  if (f === 'monthly') return 'Monthly'
  if (f === 'yearly') return 'Yearly'
  return 'Other'
}

function setFreqFilter(next: ScheduleFreq) {
  freqFilter.value = next
  localStorage.setItem(FREQ_KEY, next)
}

const filteredJobs = computed(() => {
  const q = search.value.trim().toLowerCase()
  return jobs.value.filter((j) => {
    const freq = scheduleFrequency(j)
    if (freqFilter.value !== 'all' && freq !== freqFilter.value) return false
    if (!q) return true
    const hay = [
      j.name,
      jobMessage(j),
      agentLabel(j),
      j.scheduleLabel,
      frequencyLabel(j),
    ]
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  })
})

function ocAgentOptions() {
  const opts = [{ label: 'COO · OpenClaw (main)', value: 'main' }]
  for (const a of agents.value) {
    if (a.openclawAgentId) {
      opts.push({ label: a.name, value: a.openclawAgentId })
    }
  }
  return opts
}

async function refresh() {
  loading.value = true
  try {
    const [cron, agentsRes] = await Promise.all([
      api.get<{ available?: boolean; jobs?: CronJob[] }>('/api/cron'),
      api.get<{ agents?: Agent[] }>('/api/config/agents'),
    ])
    available.value = cron.available !== false
    jobs.value = cron.jobs || []
    agents.value = agentsRes.agents || []
  } catch (e) {
    available.value = false
    message.error(e instanceof Error ? e.message : 'Could not load schedule')
  } finally {
    loading.value = false
  }
}

async function runJob(id: string) {
  try {
    const r = await api.send<{ ok?: boolean; error?: string }>('POST', `/api/cron/${encodeURIComponent(id)}/run`, {})
    if (r.ok === false) throw new Error(r.error || 'Run failed')
    message.success('Schedule triggered — check Complete Job for the summary.')
    await refresh()
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Run failed')
  }
}

async function toggleJob(id: string, enabled: boolean) {
  try {
    await api.send('POST', `/api/cron/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, {})
    await refresh()
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Update failed')
  }
}

async function deleteJob(id: string) {
  if (!window.confirm('Delete this schedule?')) return
  try {
    const r = await api.send<{ ok?: boolean; error?: string }>('DELETE', `/api/cron/${encodeURIComponent(id)}`)
    if (r.ok === false) throw new Error(r.error || 'Delete failed')
    await refresh()
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Delete failed')
  }
}

async function saveSchedule() {
  addError.value = ''
  const name = form.value.name.trim()
  const msg = form.value.message.trim()
  if (!name || !msg) {
    addError.value = 'Name and instruction are required.'
    return
  }
  addBusy.value = true
  try {
    const body: Record<string, unknown> = {
      name,
      message: msg,
      agentId: form.value.agentId,
      enabled: true,
    }
    if (form.value.repeat === 'cron') body.cron = form.value.cron.trim() || '0 9 * * *'
    else if (form.value.repeat === '30m') body.every = '30m'
    else if (form.value.repeat === '1h') body.every = '1h'
    else if (form.value.repeat === '6h') body.every = '6h'
    else body.every = '1d'
    const r = await api.send<{ ok?: boolean; error?: string }>('POST', '/api/cron', body)
    if (r.ok === false) throw new Error(r.error || 'Could not add schedule')
    addOpen.value = false
    form.value = { name: '', message: '', agentId: 'main', repeat: '1d', cron: '0 9 * * *' }
    message.success('Schedule added')
    await refresh()
  } catch (e) {
    addError.value = e instanceof Error ? e.message : 'Save failed'
  } finally {
    addBusy.value = false
  }
}

onMounted(() => refresh())
</script>

<template>
  <div class="antler-v1-root schedule-page">
    <div class="view-head">
      <h1 class="view-title">Schedule</h1>
      <button type="button" class="btn" @click="addOpen = true">+ Add schedule</button>
    </div>

    <p class="hint">
      Recurring work for your agents — e.g. daily report through COO. Finished runs appear as summaries in Complete Job.
    </p>

    <div v-if="available && (jobs.length || loading)" class="schedule-toolbar">
      <input
        v-model="search"
        type="search"
        class="channels-search schedule-search"
        placeholder="Search schedules, agents, instructions…"
        autocomplete="off"
      />
      <div class="seg schedule-freq-seg">
        <button
          type="button"
          class="seg-btn"
          :class="{ active: freqFilter === 'all' }"
          @click="setFreqFilter('all')"
        >
          All
        </button>
        <button
          type="button"
          class="seg-btn"
          :class="{ active: freqFilter === 'daily' }"
          @click="setFreqFilter('daily')"
        >
          Daily
        </button>
        <button
          type="button"
          class="seg-btn"
          :class="{ active: freqFilter === 'weekly' }"
          @click="setFreqFilter('weekly')"
        >
          Weekly
        </button>
        <button
          type="button"
          class="seg-btn"
          :class="{ active: freqFilter === 'monthly' }"
          @click="setFreqFilter('monthly')"
        >
          Monthly
        </button>
        <button
          type="button"
          class="seg-btn"
          :class="{ active: freqFilter === 'yearly' }"
          @click="setFreqFilter('yearly')"
        >
          Yearly
        </button>
      </div>
    </div>

    <p v-if="loading && !jobs.length" class="hint">Loading schedules…</p>
    <p v-else-if="!available" class="hint">OpenClaw isn't available. Install it in Settings first.</p>
    <p v-else-if="!jobs.length" class="hint">
      No schedules yet. Click <strong>Add schedule</strong> to assign recurring work (e.g. daily report via COO).
    </p>
    <p v-else-if="!filteredJobs.length" class="hint">
      No schedules match your search or filter.
      <button type="button" class="btn ghost sm" @click="search = ''; setFreqFilter('all')">Clear</button>
    </p>

    <div v-else class="schedule-list">
      <div class="agents-table-wrap">
        <table class="agents-table schedule-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Agent</th>
              <th>Frequency</th>
              <th>Schedule</th>
              <th>Next run</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="j in filteredJobs" :key="j.id">
              <td>
                <strong>{{ j.name || 'Untitled' }}</strong>
                <div class="schedule-msg">
                  {{ jobMessage(j).slice(0, 80) }}{{ jobMessage(j).length > 80 ? '…' : '' }}
                </div>
              </td>
              <td>{{ agentLabel(j) }}</td>
              <td><span class="tag">{{ frequencyLabel(j) }}</span></td>
              <td>{{ j.scheduleLabel || '—' }}</td>
              <td>{{ j.nextRunLabel || '—' }}</td>
              <td>
                <span class="pill" :class="{ ok: j.enabled }">{{ j.enabled ? 'On' : 'Off' }}</span>
              </td>
              <td class="schedule-actions">
                <button type="button" class="btn ghost sm" @click="runJob(j.id)">Run now</button>
                <button type="button" class="btn ghost sm" @click="toggleJob(j.id, !j.enabled)">
                  {{ j.enabled ? 'Disable' : 'Enable' }}
                </button>
                <button type="button" class="btn ghost sm danger" @click="deleteJob(j.id)">Delete</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <NModal v-model:show="addOpen" preset="card" title="Add schedule" style="max-width: 520px">
      <p class="hint">Assign recurring work. Most offices route through COO, who delegates to specialists.</p>
      <label class="modal-label">Job name</label>
      <input v-model="form.name" type="text" class="field" placeholder="e.g. Daily report" />
      <label class="modal-label">Agent</label>
      <select v-model="form.agentId" class="field">
        <option v-for="o in ocAgentOptions()" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
      <label class="modal-label">Instruction</label>
      <textarea v-model="form.message" rows="3" class="field" placeholder="What should the agent do each time?" />
      <label class="modal-label">Repeat</label>
      <select v-model="form.repeat" class="field">
        <option value="30m">Every 30 minutes</option>
        <option value="1h">Every hour</option>
        <option value="6h">Every 6 hours</option>
        <option value="1d">Every day</option>
        <option value="cron">Custom cron expression…</option>
      </select>
      <input
        v-if="form.repeat === 'cron'"
        v-model="form.cron"
        type="text"
        class="field"
        placeholder="0 9 * * *  (9am daily)"
      />
      <p v-if="addError" class="modal-error">{{ addError }}</p>
      <template #footer>
        <NButton @click="addOpen = false">Cancel</NButton>
        <NButton type="primary" :loading="addBusy" @click="saveSchedule">Add schedule</NButton>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.schedule-page {
  padding-bottom: 24px;
}
.view-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.view-title {
  margin: 0;
  font-size: 24px;
}
.schedule-msg {
  font-size: 12px;
  color: var(--muted);
  margin-top: 4px;
}
.schedule-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 12px 0 4px;
}
.schedule-search {
  flex: 1;
  min-width: 200px;
  max-width: 420px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text);
  font: inherit;
  font-size: 14px;
}
.schedule-freq-seg {
  flex-shrink: 0;
}
.schedule-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}
.modal-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  margin: 12px 0 6px;
  opacity: 0.85;
}
.field {
  width: 100%;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text);
  font-family: inherit;
  font-size: 14px;
}
.modal-error {
  color: #e88080;
  font-size: 13px;
  margin-top: 10px;
}
.btn.danger {
  color: #f08080;
}
</style>
