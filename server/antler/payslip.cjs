const billing = require('./billing');
const ecsSubscriptions = require('./ecs-subscriptions');
const { periodToRangeMs, previousCalendarMonth } = require('./period-sg.cjs');

const PAGE_SIZES = [10, 20, 50, 100, 200];

function normalizePageSize(n) {
  const size = Number(n) || 20;
  return PAGE_SIZES.includes(size) ? size : 20;
}

function sortEntries(entries, sortBy = 'at', sortOrder = 'descend') {
  const keys = ['at', 'type', 'amount', 'balanceAfter', 'reason', 'agentName'];
  const key = keys.includes(sortBy) ? sortBy : 'at';
  const dir = sortOrder === 'ascend' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const av = key === 'agentName' ? a.agentName || a.departmentId || '' : a[key];
    const bv = key === 'agentName' ? b.agentName || b.departmentId || '' : b[key];
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
  });
}

function mapLocalEntry(row) {
  return {
    id: row.id,
    at: row.at,
    type: row.type === 'sync' ? 'adjustment' : row.type,
    amount: row.amount,
    balanceAfter: row.balanceAfter,
    reason: row.reason || row.type,
    period: null,
    subscriptionId: row.subscriptionId || null,
    departmentId: row.departmentId || null,
    agentName: row.agentName || null,
    source: 'local',
  };
}

function listLocalLedger(period) {
  const { startMs, endMs } = periodToRangeMs(period);
  const all = billing.listLedger(10000).filter((r) => r.at >= startMs && r.at <= endMs);
  const entries = all.map(mapLocalEntry);
  const totalDebit = entries.filter((e) => e.type === 'debit').reduce((s, e) => s + e.amount, 0);
  const totalCredit = entries.filter((e) => e.type === 'credit').reduce((s, e) => s + e.amount, 0);
  const chron = [...entries].sort((a, b) => b.at - a.at);
  const openingBalance =
    chron.length > 0
      ? chron[chron.length - 1].balanceAfter +
        (chron[chron.length - 1].type === 'debit'
          ? chron[chron.length - 1].amount
          : -chron[chron.length - 1].amount)
      : billing.getBalance();
  const closingBalance = chron.length ? chron[0].balanceAfter : openingBalance;
  return {
    period,
    openingBalance,
    closingBalance,
    totalDebit,
    totalCredit,
    totalEntries: entries.length,
    entries,
    source: 'local',
  };
}

function paginateLedger(base, { page = 1, pageSize = 20, sortBy = 'at', sortOrder = 'descend' } = {}) {
  const size = normalizePageSize(pageSize);
  const p = Math.max(1, Number(page) || 1);
  const sorted = sortEntries(base.entries, sortBy, sortOrder);
  const start = (p - 1) * size;
  return {
    ...base,
    page: p,
    pageSize: size,
    totalEntries: sorted.length,
    entries: sorted.slice(start, start + size),
    sortBy,
    sortOrder,
  };
}

async function fetchEcsLedger({ ecsToken, officeId, period, page, pageSize, sortBy, sortOrder }) {
  const qs = new URLSearchParams({
    officeId,
    period,
    page: String(page || 1),
    pageSize: String(pageSize || 20),
    sortBy: sortBy || 'at',
    sortOrder: sortOrder === 'ascend' ? 'ascend' : 'descend',
  });
  const result = await ecsSubscriptions.ecsFetch(`/api/credits/ledger?${qs}`, { ecsToken });
  if (!result.ok) return null;
  return {
    ...result,
    entries: (result.entries || []).map((e) => ({ ...e, source: 'ecs' })),
    source: 'ecs',
  };
}

async function getPayslip({
  ecsToken,
  officeId,
  period,
  page = 1,
  pageSize = 20,
  sortBy = 'at',
  sortOrder = 'descend',
} = {}) {
  const p = period || previousCalendarMonth();
  const size = normalizePageSize(pageSize);
  if (ecsToken && officeId) {
    const ecs = await fetchEcsLedger({
      ecsToken,
      officeId,
      period: p,
      page,
      pageSize: size,
      sortBy,
      sortOrder,
    });
    if (ecs) return ecs;
  }
  return paginateLedger(listLocalLedger(p), { page, pageSize: size, sortBy, sortOrder });
}

async function exportPayslip({ ecsToken, officeId, period }) {
  const p = period || previousCalendarMonth();
  if (ecsToken && officeId) {
    const ecs = await fetchEcsLedger({
      ecsToken,
      officeId,
      period: p,
      page: 1,
      pageSize: 'all',
      sortBy: 'at',
      sortOrder: 'descend',
    });
    if (ecs) return ecs;
  }
  return listLocalLedger(p);
}

module.exports = {
  getPayslip,
  exportPayslip,
  listLocalLedger,
  PAGE_SIZES,
};
