// Persistent credit balance + payroll ledger (mock billing until ECS backend is wired).

const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');

const DEFAULT_BALANCE = 1000;
const MAX_LEDGER = 500;

function billingPath() {
  return path.join(getDataDir(), 'billing.json');
}

function readBilling() {
  try {
    const raw = JSON.parse(fs.readFileSync(billingPath(), 'utf8'));
    return {
      creditBalance: typeof raw.creditBalance === 'number' ? raw.creditBalance : DEFAULT_BALANCE,
      currency: raw.currency || 'credits',
      ledger: Array.isArray(raw.ledger) ? raw.ledger : [],
    };
  } catch {
    return { creditBalance: DEFAULT_BALANCE, currency: 'credits', ledger: [] };
  }
}

function writeBilling(data) {
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(billingPath(), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

function pushLedger(data, entry) {
  data.ledger.unshift({
    id: `pay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
    ...entry,
  });
  if (data.ledger.length > MAX_LEDGER) data.ledger.length = MAX_LEDGER;
}

function getBalance() {
  return readBilling().creditBalance;
}

function getCurrency() {
  return readBilling().currency;
}

function deductCredits(amount, meta = {}) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid deduction amount.');
  const data = readBilling();
  if (data.creditBalance < n) {
    const err = new Error('Insufficient credits.');
    err.code = 'INSUFFICIENT_CREDITS';
    err.balance = data.creditBalance;
    err.required = n;
    throw err;
  }
  data.creditBalance -= n;
  pushLedger(data, { type: 'debit', amount: n, balanceAfter: data.creditBalance, ...meta });
  writeBilling(data);
  return { balance: data.creditBalance, currency: data.currency };
}

function addCredits(amount, meta = {}) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid credit amount.');
  const data = readBilling();
  data.creditBalance += n;
  pushLedger(data, { type: 'credit', amount: n, balanceAfter: data.creditBalance, ...meta });
  writeBilling(data);
  return { balance: data.creditBalance, currency: data.currency };
}

function listLedger(limit = 50) {
  return readBilling().ledger.slice(0, limit);
}

function setBalance(balance, meta = {}) {
  const n = Number(balance);
  if (!Number.isFinite(n) || n < 0) throw new Error('Invalid balance.');
  const data = readBilling();
  data.creditBalance = n;
  pushLedger(data, { type: 'sync', amount: 0, balanceAfter: n, ...meta });
  writeBilling(data);
  return { balance: data.creditBalance, currency: data.currency };
}

module.exports = {
  getBalance,
  getCurrency,
  deductCredits,
  addCredits,
  setBalance,
  listLedger,
  DEFAULT_BALANCE,
};
