<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useMessage, useDialog } from 'naive-ui'
import ConnectChannelModal from '@/components/antler/ConnectChannelModal.vue'
import { useAntlerChannels } from '@/composables/useAntlerChannels'

const {
  available,
  loading,
  gatewayUp,
  viewMode,
  filterExpanded,
  prefs,
  filterCount,
  allRows,
  pageRows,
  total,
  totalPages,
  pageInfo,
  providerOptions,
  agentOptions,
  routeAgentOptions,
  PAGE_SIZES,
  savePrefs,
  setView,
  toggleSort,
  sortMark,
  clearFilters,
  refresh,
  setRoute,
  renameChannel,
  removeChannel,
} = useAntlerChannels()
const message = useMessage()
const dialog = useDialog()
const connectOpen = ref(false)

onMounted(() => refresh().catch(() => message.error('Could not load channels')))

async function onRouteChange(provider: string, account: string, agentId: string) {
  try {
    await setRoute(provider, account, agentId)
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Route update failed')
  }
}

async function onEditName(provider: string, account: string, name: string) {
  try {
    await renameChannel(provider, account, name)
  } catch (e) {
    message.error(e instanceof Error ? e.message : 'Rename failed')
  }
}

function onRemove(provider: string, account: string) {
  const m = allRows.value.find((r) => r.provider === provider && r.account === account)
  dialog.warning({
    title: 'Disconnect channel',
    content: `Disconnect ${m?.meta.label || provider} (${account})?`,
    positiveText: 'Disconnect',
    negativeText: 'Cancel',
    onPositiveClick: async () => {
      try {
        await removeChannel(provider, account)
        message.success('Channel disconnected')
      } catch (e) {
        message.error(e instanceof Error ? e.message : 'Disconnect failed')
      }
    },
  })
}

function onPageChange(page: number) {
  if (page < 1 || page > totalPages.value) return
  prefs.page = page
}

function onPageSizeChange(size: number) {
  prefs.pageSize = size
  prefs.page = 1
  savePrefs()
}
</script>

<template>
  <div class="antler-v1-root channels-page">
    <div class="view-head">
      <h1 class="view-title">Channels</h1>
    </div>
    <p class="hint channels-intro">
      The office <strong>instruction inbox</strong>: reach your team from outside (WhatsApp, Telegram, …).
      <strong>WhatsApp uses instruction mode</strong> — only <em>message yourself</em> on the linked number becomes
      a task; other numbers and groups never reach OpenClaw.
    </p>

    <div v-if="!available && !loading" class="hint warn-box">
      OpenClaw isn't available yet. Connect OpenClaw and add model keys under Models first.
    </div>

    <template v-else>
      <div class="channels-status">
        <span v-if="gatewayUp" class="pill ok">Live delivery</span>
        <span v-else class="pill warn">Starting…</span>
        <span class="channels-note">
          {{
            gatewayUp
              ? 'Self-chat instructions reach your routed agent. Customer DMs are blocked on WhatsApp.'
              : 'Connection engine is starting — messages will deliver shortly.'
          }}
        </span>
      </div>

      <div class="channels-toolbar">
        <h2 class="section-title">Connected channels</h2>
        <div class="inline">
          <div class="seg">
            <button
              type="button"
              class="seg-btn"
              :class="{ active: viewMode === 'list' }"
              title="List view"
              @click="setView('list')"
            >
              ≣ List
            </button>
            <button
              type="button"
              class="seg-btn"
              :class="{ active: viewMode === 'grid' }"
              title="Grid view"
              @click="setView('grid')"
            >
              ▦ Grid
            </button>
          </div>
          <button type="button" class="btn" @click="connectOpen = true">+ Connect channel</button>
        </div>
      </div>

      <div v-show="viewMode === 'list' && allRows.length" class="channels-list-bar">
        <input
          v-model="prefs.search"
          type="search"
          class="channels-search"
          placeholder="Search name, phone, account…"
          autocomplete="off"
          @input="prefs.page = 1"
        />
        <button
          type="button"
          class="btn ghost channels-filter-btn"
          :class="{ active: filterExpanded, 'has-filters': filterCount > 0 }"
          @click="filterExpanded = !filterExpanded"
        >
          {{ filterCount ? `Filter (${filterCount})` : 'Filter' }}
        </button>
      </div>

      <div
        v-show="viewMode === 'list' && filterExpanded"
        class="channels-filter-panel is-open"
      >
        <div class="channels-filter-fields">
          <div class="channels-filter-item">
            <label class="channels-filter-label">Channel</label>
            <select v-model="prefs.filterProvider" class="channels-filter" @change="prefs.page = 1; savePrefs()">
              <option value="">All channels</option>
              <option v-for="p in providerOptions" :key="p.value" :value="p.value">{{ p.label }}</option>
            </select>
          </div>
          <div class="channels-filter-item">
            <label class="channels-filter-label">Talks to</label>
            <select v-model="prefs.filterAgent" class="channels-filter" @change="prefs.page = 1; savePrefs()">
              <option value="">All Talks to</option>
              <option v-for="a in agentOptions" :key="a.value" :value="a.value">{{ a.label }}</option>
            </select>
          </div>
        </div>
        <button type="button" class="btn ghost sm" @click="clearFilters()">Clear filters</button>
      </div>

      <p v-if="loading" class="hint">Loading channels…</p>

      <p v-else-if="!allRows.length" class="hint">
        No channels connected yet. Click <strong>Connect channel</strong> to add one. The usual setup is one channel
        routed to your COO (and CEO when hired), who delegates to the team.
      </p>

      <p v-else-if="!pageRows.length" class="hint">
        No channels match your search or filters.
        <button type="button" class="btn ghost sm" @click="clearFilters()">Clear filters</button>
      </p>

      <!-- List view -->
      <div
        v-else-if="viewMode === 'list'"
        class="market-grid list"
      >
        <div class="channels-table-wrap">
          <table class="channels-table">
            <thead>
              <tr>
                <th class="sortable" @click="toggleSort('provider')">Channel{{ sortMark('provider') }}</th>
                <th class="sortable" @click="toggleSort('name')">Name{{ sortMark('name') }}</th>
                <th class="sortable" @click="toggleSort('contact')">Contact{{ sortMark('contact') }}</th>
                <th class="sortable" @click="toggleSort('status')">Status{{ sortMark('status') }}</th>
                <th class="sortable" @click="toggleSort('agent')">Talks to{{ sortMark('agent') }}</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in pageRows" :key="`${r.provider}-${r.account}`">
                <td>
                  <div class="ch-td-channel">
                    <span class="channel-tag">{{ r.meta.tag }}</span>
                    <span>{{ r.meta.label }}</span>
                  </div>
                </td>
                <td>
                  <strong>{{ r.title }}</strong>
                  <div v-if="!r.phone && r.account !== 'default' && !r.name" class="ch-td-sub">{{ r.account }}</div>
                </td>
                <td class="ch-td-contact">
                  {{ r.contact || '—' }}
                  <span v-if="r.instructionMode" class="pill ok sm ch-instruction-pill">Self only</span>
                </td>
                <td><span class="pill" :class="r.pillClass">{{ r.pillText }}</span></td>
                <td>
                  <select
                    class="ch-td-route"
                    :value="r.agentId"
                    @change="onRouteChange(r.provider, r.account, ($event.target as HTMLSelectElement).value)"
                  >
                    <option
                      v-for="a in routeAgentOptions"
                      :key="a.value"
                      :value="a.value"
                    >
                      {{ a.label }}
                    </option>
                  </select>
                </td>
                <td class="ch-td-actions">
                  <button
                    type="button"
                    class="btn ghost sm"
                    @click="onEditName(r.provider, r.account, r.name || '')"
                  >
                    Edit name
                  </button>
                  <button
                    type="button"
                    class="btn ghost sm danger"
                    @click="onRemove(r.provider, r.account)"
                  >
                    Disconnect
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Grid view -->
      <div v-else class="market-grid">
        <div v-for="r in allRows" :key="`${r.provider}-${r.account}`" class="market-card channel-card">
          <div class="channel-head">
            <span class="channel-tag">{{ r.meta.tag }}</span>
            <div>
              <h3>{{ r.title }}</h3>
              <span v-if="r.phone || (r.name && r.account !== 'default')" class="channel-acct channel-phone">
                {{ [r.phone, r.name && r.account !== 'default' ? r.account : ''].filter(Boolean).join(' · ') }}
              </span>
              <span v-else-if="!r.name && r.account !== 'default'" class="channel-acct channel-phone">{{ r.account }}</span>
            </div>
          </div>
          <span class="pill" :class="r.pillClass">{{ r.pillText }}</span>
          <span v-if="r.instructionMode" class="pill ok sm ch-instruction-pill">Self-chat only</span>
          <label class="channel-route">
            <span>Talks to</span>
            <select
              :value="r.agentId"
              @change="onRouteChange(r.provider, r.account, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="a in routeAgentOptions" :key="a.value" :value="a.value">{{ a.label }}</option>
            </select>
          </label>
          <div class="channel-actions">
            <button type="button" class="btn ghost" @click="onEditName(r.provider, r.account, r.name || '')">
              Edit name
            </button>
            <button type="button" class="btn ghost danger" @click="onRemove(r.provider, r.account)">
              Disconnect
            </button>
          </div>
        </div>
      </div>

      <div
        v-if="viewMode === 'list' && total"
        class="channels-list-footer channels-pagination"
      >
        <span class="channels-page-info">
          Showing {{ pageInfo.start }}–{{ pageInfo.end }} of {{ total }}
        </span>
        <div class="channels-page-btns">
          <button type="button" class="btn ghost sm" :disabled="prefs.page <= 1" @click="onPageChange(prefs.page - 1)">
            Prev
          </button>
          <button
            v-for="p in Math.min(totalPages, 5)"
            :key="p"
            type="button"
            class="btn ghost sm"
            :class="{ active: p === prefs.page }"
            :disabled="p === prefs.page"
            @click="onPageChange(p)"
          >
            {{ p }}
          </button>
          <button
            type="button"
            class="btn ghost sm"
            :disabled="prefs.page >= totalPages"
            @click="onPageChange(prefs.page + 1)"
          >
            Next
          </button>
        </div>
        <label class="channels-page-size">
          Show
          <select :value="prefs.pageSize" @change="onPageSizeChange(Number(($event.target as HTMLSelectElement).value))">
            <option v-for="n in PAGE_SIZES" :key="n" :value="n">{{ n }}</option>
          </select>
          per page
        </label>
      </div>
    </template>

    <ConnectChannelModal v-model:show="connectOpen" @connected="refresh()" />
  </div>
</template>

<style scoped>
.channels-page {
  padding-bottom: 24px;
}
.view-head {
  margin-bottom: 4px;
}
.view-title {
  margin: 0;
  font-size: 24px;
}
.channels-intro {
  margin: 0 0 12px;
}
.ch-instruction-pill {
  display: inline-block;
  margin-left: 6px;
  vertical-align: middle;
}
.pill.sm {
  font-size: 10px;
  padding: 2px 6px;
}
.warn-box {
  padding: 12px;
  border-radius: 8px;
  border: 1px solid rgba(240, 180, 60, 0.35);
  background: rgba(240, 180, 60, 0.08);
}
.inline {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.seg {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}
.seg-btn {
  background: transparent;
  border: none;
  color: var(--text);
  padding: 6px 12px;
  cursor: pointer;
  font-size: 13px;
}
.seg-btn.active {
  background: rgba(70, 209, 96, 0.15);
  color: var(--accent-2);
}
.btn.danger {
  color: #f08080;
  border-color: rgba(240, 128, 128, 0.35);
}
.btn.sm {
  font-size: 12px;
  padding: 4px 10px;
}
.sortable {
  cursor: pointer;
  user-select: none;
}
</style>
