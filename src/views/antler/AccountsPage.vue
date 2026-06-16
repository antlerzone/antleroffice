<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NIcon, useMessage } from 'naive-ui'
import { EyeOutline, EyeOffOutline } from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'
import { useWebAccounts, type BossWebAccount } from '@/composables/useWebAccounts'

const { t } = useI18n()
const message = useMessage()

const {
  loading,
  prefs,
  pageRows,
  total,
  totalPages,
  pageInfo,
  PAGE_SIZES,
  revealed,
  refresh,
  revealSecrets,
  hideSecrets,
  isRevealed,
  passwordDisplay,
  onPageChange,
  onPageSizeChange,
} = useWebAccounts()

const revealing = ref<string | null>(null)

function revealedUsername(row: BossWebAccount) {
  return revealed.value[row.alias]?.username || row.username
}

async function togglePassword(row: BossWebAccount) {
  if (isRevealed(row.alias)) {
    hideSecrets(row.alias)
    return
  }
  revealing.value = row.alias
  try {
    await revealSecrets(row.alias)
  } catch {
    message.error(t('accounts.revealFailed'))
  } finally {
    revealing.value = null
  }
}

onMounted(() => {
  refresh().catch(() => message.error(t('accounts.loadFailed')))
})
</script>

<template>
  <div class="antler-v1-root accounts-page">
    <div class="view-head">
      <h1 class="view-title">{{ t('accounts.title') }}</h1>
    </div>
    <p class="hint accounts-intro">
      {{ t('accounts.viewOnlyIntro') }}
    </p>
    <p class="hint accounts-coo-hint">
      {{ t('accounts.cooHint') }}
    </p>

    <div v-if="!loading" class="accounts-list-bar">
      <input
        v-model="prefs.search"
        type="search"
        class="accounts-search"
        :placeholder="t('accounts.searchPlaceholder')"
        autocomplete="off"
        @input="prefs.page = 1"
      />
    </div>

    <p v-if="loading" class="hint">{{ t('accounts.loading') }}</p>

    <p v-else-if="!total" class="hint">
      {{ prefs.search ? t('accounts.noMatch') : t('accounts.empty') }}
    </p>

    <template v-else>
      <div class="accounts-sheet-wrap">
        <table class="channels-table accounts-sheet">
          <thead>
            <tr>
              <th class="col-num">#</th>
              <th>{{ t('accounts.colLabel') }}</th>
              <th>{{ t('accounts.colUsername') }}</th>
              <th>{{ t('accounts.colPassword') }}</th>
              <th>{{ t('accounts.colAlias') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in pageRows" :key="row.alias">
              <td class="col-num">{{ (prefs.page - 1) * prefs.pageSize + index + 1 }}</td>
              <td>{{ row.displayName }}</td>
              <td>{{ row.username }}</td>
              <td class="col-password">
                <code class="password-text" :class="{ revealed: isRevealed(row.alias) }">
                  {{ passwordDisplay(row) }}
                </code>
                <button
                  v-if="row.secretSet"
                  type="button"
                  class="btn icon-btn"
                  :title="isRevealed(row.alias) ? t('accounts.hidePassword') : t('accounts.showPassword')"
                  :disabled="revealing === row.alias"
                  @click="togglePassword(row)"
                >
                  <NIcon :size="18">
                    <component :is="isRevealed(row.alias) ? EyeOffOutline : EyeOutline" />
                  </NIcon>
                </button>
              </td>
              <td><code>{{ row.alias }}</code></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="channels-list-footer channels-pagination accounts-pagination">
        <span class="channels-page-info">
          {{ t('accounts.pageInfo', { start: pageInfo.start, end: pageInfo.end, total }) }}
        </span>
        <div class="channels-page-btns">
          <button
            type="button"
            class="btn ghost sm"
            :disabled="prefs.page <= 1"
            @click="onPageChange(prefs.page - 1)"
          >
            {{ t('accounts.prev') }}
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
            {{ t('accounts.next') }}
          </button>
        </div>
        <label class="channels-page-size">
          {{ t('accounts.show') }}
          <select
            :value="prefs.pageSize"
            @change="onPageSizeChange(Number(($event.target as HTMLSelectElement).value))"
          >
            <option v-for="n in PAGE_SIZES" :key="n" :value="n">{{ n }}</option>
          </select>
          {{ t('accounts.perPage') }}
        </label>
      </div>
    </template>
  </div>
</template>

<style scoped>
.accounts-page {
  padding-bottom: 24px;
}

.accounts-intro,
.accounts-coo-hint {
  max-width: 640px;
  margin-bottom: 8px;
}

.accounts-coo-hint {
  opacity: 0.85;
  margin-bottom: 16px;
}

.accounts-list-bar {
  margin-bottom: 12px;
}

.accounts-search {
  width: min(420px, 100%);
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-color, #333);
  background: var(--input-bg, #1a1a1a);
  color: inherit;
}

.accounts-sheet-wrap {
  overflow-x: auto;
  margin-bottom: 8px;
}

.accounts-sheet {
  width: 100%;
  min-width: 560px;
}

.col-num {
  width: 48px;
  text-align: center;
  opacity: 0.7;
}

.col-password {
  display: flex;
  align-items: center;
  gap: 8px;
}

.password-text {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  letter-spacing: 0.02em;
  opacity: 0.85;
}

.password-text.revealed {
  opacity: 1;
  font-size: 13px;
}

.icon-btn {
  padding: 4px 6px;
  min-width: 0;
  line-height: 0;
}

.accounts-pagination {
  margin-top: 12px;
}
</style>
