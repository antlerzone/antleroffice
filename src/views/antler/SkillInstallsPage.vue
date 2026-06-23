<script setup lang="ts">
/**
 * SkillInstallsPage — SaaS Admin view of all skill/MCP installations.
 *
 * Shows:
 *   - Summary tab: top installed skills (grouped by name + source)
 *   - Detail tab:  every individual install event
 *
 * Accessed at /app/skill-installs (hidden from nav, direct URL or Settings link)
 */
import { computed, onMounted, ref } from 'vue'
import {
  NButton,
  NDataTable,
  NTag,
  NSpace,
  NTabs,
  NTabPane,
  NStatistic,
  NEmpty,
  useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { useAntlerApi } from '@/composables/useAntlerApi'

const api = useAntlerApi()
const message = useMessage()

// ── Data ─────────────────────────────────────────────────────────────────────

interface InstallEntry {
  id: string
  skillName: string
  skillId: string | null
  source: string
  sourceUrl: string | null
  npcTemplateId: string | null
  npcName: string | null
  tenantId: string
  triggeredBy: string
  status: 'installed' | 'failed' | 'skipped'
  errorMessage: string | null
  installedAt: string
}

interface SummaryEntry {
  skillName: string
  skillId: string | null
  source: string
  sourceUrl: string | null
  installCount: number
  failCount: number
  npcTemplates: string[]
  lastInstalledAt: string | null
}

const entries = ref<InstallEntry[]>([])
const summary = ref<SummaryEntry[]>([])
const loading = ref(false)
const activeTab = ref<'summary' | 'detail'>('summary')

const totalInstalls = computed(() => entries.value.filter((e) => e.status === 'installed').length)
const totalFailed = computed(() => entries.value.filter((e) => e.status === 'failed').length)
const uniqueSkills = computed(() => new Set(entries.value.map((e) => e.skillName)).size)

async function load() {
  loading.value = true
  try {
    const [detailRes, summaryRes] = await Promise.all([
      api.get<{ ok: boolean; entries: InstallEntry[] }>('/api/admin/skill-installs?limit=200'),
      api.get<{ ok: boolean; summary: SummaryEntry[] }>('/api/admin/skill-installs/summary'),
    ])
    entries.value = detailRes.entries || []
    summary.value = summaryRes.summary || []
  } catch (e) {
    message.error(e instanceof Error ? e.message : '加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(load)

// ── Source badge ──────────────────────────────────────────────────────────────

const SOURCE_LABELS: Record<string, string> = {
  'antleroffice-store': 'AntlerOffice',
  'openclaw-registry': 'OpenClaw',
  'github': 'GitHub',
  'npc-onboarding': '入职引导',
  'manual': '手动',
}

const SOURCE_TYPES: Record<string, 'success' | 'info' | 'warning' | 'default'> = {
  'antleroffice-store': 'success',
  'openclaw-registry': 'info',
  'github': 'warning',
  'npc-onboarding': 'success',
  'manual': 'default',
}

// ── Summary columns ───────────────────────────────────────────────────────────

const summaryColumns: DataTableColumns<SummaryEntry> = [
  {
    title: 'Skill 名称',
    key: 'skillName',
    render: (row) => row.skillName,
    sorter: (a, b) => a.skillName.localeCompare(b.skillName),
  },
  {
    title: '来源',
    key: 'source',
    width: 130,
    render: (row) => h(
      NTag,
      { type: SOURCE_TYPES[row.source] || 'default', size: 'small', bordered: false },
      { default: () => SOURCE_LABELS[row.source] || row.source },
    ),
  },
  {
    title: '安装次数',
    key: 'installCount',
    width: 100,
    sorter: (a, b) => b.installCount - a.installCount,
    defaultSortOrder: 'descend',
  },
  {
    title: '失败次数',
    key: 'failCount',
    width: 90,
    render: (row) => row.failCount > 0
      ? h(NTag, { type: 'error', size: 'small', bordered: false }, { default: () => String(row.failCount) })
      : '—',
  },
  {
    title: '相关 NPC',
    key: 'npcTemplates',
    render: (row) => row.npcTemplates.join(', ') || '—',
  },
  {
    title: '最近安装',
    key: 'lastInstalledAt',
    width: 160,
    render: (row) => row.lastInstalledAt
      ? new Date(row.lastInstalledAt).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
      : '—',
  },
  {
    title: '操作',
    key: 'actions',
    width: 130,
    render: (row) => h(
      NButton,
      {
        size: 'small',
        type: 'primary',
        ghost: true,
        onClick: () => promoteToDefault(row),
      },
      { default: () => '加入默认配置' },
    ),
  },
]

// ── Detail columns ────────────────────────────────────────────────────────────

const detailColumns: DataTableColumns<InstallEntry> = [
  {
    title: 'Skill',
    key: 'skillName',
    render: (row) => row.skillName,
  },
  {
    title: '来源',
    key: 'source',
    width: 120,
    render: (row) => h(
      NTag,
      { type: SOURCE_TYPES[row.source] || 'default', size: 'small', bordered: false },
      { default: () => SOURCE_LABELS[row.source] || row.source },
    ),
  },
  {
    title: 'NPC',
    key: 'npcName',
    width: 120,
    render: (row) => row.npcName || row.npcTemplateId || '—',
  },
  {
    title: '触发方',
    key: 'triggeredBy',
    width: 90,
    render: (row) => row.triggeredBy === 'coo-auto' ? '🤖 COO' : '👤 用户',
  },
  {
    title: '状态',
    key: 'status',
    width: 80,
    render: (row) => {
      const map = { installed: ['success', '成功'], failed: ['error', '失败'], skipped: ['default', '跳过'] } as const
      const [type, label] = map[row.status] ?? ['default', row.status]
      return h(NTag, { type, size: 'small', bordered: false }, { default: () => label })
    },
  },
  {
    title: '用户',
    key: 'tenantId',
    width: 120,
    render: (row) => row.tenantId || 'local',
  },
  {
    title: '时间',
    key: 'installedAt',
    width: 150,
    render: (row) => new Date(row.installedAt).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }),
    sorter: (a, b) => new Date(b.installedAt).getTime() - new Date(a.installedAt).getTime(),
    defaultSortOrder: 'descend',
  },
]

// ── Actions ───────────────────────────────────────────────────────────────────

function promoteToDefault(row: SummaryEntry) {
  // Phase 2: will write to npc-onboarding-configs.ts or catalog.json
  message.info(`"${row.skillName}" 标记为待加入默认配置 — 请手动更新 npc-onboarding-configs.ts`)
}

// ── h() import ───────────────────────────────────────────────────────────────
import { h } from 'vue'
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>Skill 安装记录</h1>
        <p class="subtitle">监控用户安装了哪些工具 — 热门 Skill 可以加入 NPC 默认配置</p>
      </div>
      <NButton :loading="loading" @click="load">刷新</NButton>
    </div>

    <!-- Stats row -->
    <div class="stats-row">
      <div class="stat-card">
        <NStatistic label="累计安装" :value="totalInstalls" />
      </div>
      <div class="stat-card">
        <NStatistic label="独立 Skill" :value="uniqueSkills" />
      </div>
      <div class="stat-card">
        <NStatistic label="安装失败" :value="totalFailed" />
      </div>
    </div>

    <!-- Tabs -->
    <NTabs v-model:value="activeTab" type="line" animated>
      <NTabPane name="summary" tab="📊 热度排行">
        <NDataTable
          v-if="summary.length"
          :columns="summaryColumns"
          :data="summary"
          :loading="loading"
          :pagination="{ pageSize: 20 }"
          size="small"
          striped
        />
        <NEmpty v-else-if="!loading" description="还没有安装记录" />
      </NTabPane>

      <NTabPane name="detail" tab="📋 详细记录">
        <NDataTable
          v-if="entries.length"
          :columns="detailColumns"
          :data="entries"
          :loading="loading"
          :pagination="{ pageSize: 30 }"
          size="small"
          striped
        />
        <NEmpty v-else-if="!loading" description="还没有安装记录" />
      </NTabPane>
    </NTabs>

    <!-- Webhook config hint -->
    <div class="webhook-hint">
      <span>💡 设置环境变量 <code>ANTLER_ADMIN_WEBHOOK_URL</code> 可将每次安装推送到你的 SaaS 后台</span>
    </div>
  </div>
</template>

<style scoped>
.page {
  max-width: 1100px;
  margin: 0 auto;
  padding: 24px 20px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

h1 { margin: 0; font-size: 22px; font-weight: 700; }
.subtitle { margin: 4px 0 0; opacity: 0.6; font-size: 13px; }

.stats-row {
  display: flex;
  gap: 16px;
}
.stat-card {
  flex: 1;
  background: var(--n-color, #fff);
  border: 1px solid var(--n-border-color, #eee);
  border-radius: 10px;
  padding: 16px 20px;
}

.webhook-hint {
  padding: 10px 14px;
  background: rgba(75, 158, 255, 0.06);
  border: 1px solid rgba(75, 158, 255, 0.2);
  border-radius: 8px;
  font-size: 12px;
  opacity: 0.8;
}
code {
  background: rgba(0, 0, 0, 0.08);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 11px;
}
</style>
