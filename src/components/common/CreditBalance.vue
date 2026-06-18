<script setup lang="ts">
import { computed, h, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { NDropdown, NTag, NIcon, type DropdownOption } from 'naive-ui'
import { AddOutline, ReceiptOutline, WalletOutline } from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'
import { useBossStore } from '@/stores/boss'
import { buildOfficeAddCreditUrl } from '@/lib/office-web'
import { openExternalUrl } from '@/lib/desktop-shell'

const bossStore = useBossStore()
const router = useRouter()
const { t } = useI18n()

const REFRESH_MS = 60_000
let refreshTimer: ReturnType<typeof setInterval> | null = null

const balance = computed(() => bossStore.session?.creditBalance ?? null)

const balanceLabel = computed(() => {
  if (balance.value === null) return '—'
  const formatted = balance.value.toLocaleString()
  return t('components.creditBalance.label', { balance: formatted })
})

function menuIcon(component: typeof WalletOutline) {
  return () => h(NIcon, { component, size: 16 })
}

const menuOptions = computed<DropdownOption[]>(() => [
  {
    label: t('components.creditBalance.addCredit'),
    key: 'add-credit',
    icon: menuIcon(AddOutline),
  },
  {
    label: t('components.creditBalance.viewPayslip'),
    key: 'view-payslip',
    icon: menuIcon(ReceiptOutline),
  },
])

async function refreshBalance() {
  if (!bossStore.token) return
  await bossStore.heartbeat().catch(() => bossStore.refreshSession().catch(() => false))
}

function handleMenuSelect(key: string | number) {
  if (key === 'add-credit') {
    openExternalUrl(buildOfficeAddCreditUrl())
    return
  }
  if (key === 'view-payslip') {
    void router.push({ name: 'Payslip' })
  }
}

onMounted(() => {
  void refreshBalance()
  refreshTimer = setInterval(() => {
    void refreshBalance()
  }, REFRESH_MS)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

<template>
  <div v-if="bossStore.isLoggedIn" class="credit-balance-wrap">
    <NDropdown
      trigger="click"
      placement="bottom-end"
      :options="menuOptions"
      @select="handleMenuSelect"
    >
      <div class="credit-balance-trigger">
        <NTag
          size="small"
          round
          :bordered="false"
          class="credit-balance-tag"
        >
          <template #icon>
            <NIcon :component="WalletOutline" />
          </template>
          {{ balanceLabel }}
        </NTag>
      </div>
    </NDropdown>
  </div>
</template>

<style scoped>
.credit-balance-wrap,
.credit-balance-trigger {
  display: inline-flex;
  align-items: center;
  line-height: 1;
}

.credit-balance-wrap :deep(.n-dropdown) {
  display: inline-flex;
  align-items: center;
}

.credit-balance-tag {
  cursor: pointer;
  user-select: none;
  background: rgba(240, 160, 32, 0.12);
  color: var(--text-color-1);
  vertical-align: middle;
}

.credit-balance-tag:hover {
  background: rgba(240, 160, 32, 0.2);
}
</style>
