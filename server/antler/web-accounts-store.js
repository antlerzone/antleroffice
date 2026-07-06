// Web login accounts — encrypted local vault. Agents see alias + metadata only.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDataDir } = require('./store');
const secretCrypto = require('./secret-crypto');

const FILE = 'web-accounts.json';
const ALIAS_RE = /^[a-z][a-z0-9_]{1,63}$/;
const STATUSES = new Set(['active', 'inactive']);
const SENSITIVE_FIELDS = ['username', 'password', 'otpSecret', 'cookie'];

function dataPath() {
  return path.join(getDataDir(), FILE);
}

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(dataPath(), 'utf8'));
    return Array.isArray(data.accounts) ? data.accounts : [];
  } catch {
    return [];
  }
}

function writeAll(accounts) {
  const dir = getDataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dataPath(), JSON.stringify({ accounts }, null, 2), 'utf8');
}

function normalizeAlias(alias) {
  return String(alias || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[^a-z]+/, '');
}

function validateAlias(alias) {
  const a = normalizeAlias(alias);
  if (!ALIAS_RE.test(a)) {
    throw new Error('alias must be lowercase letters, digits, underscores (2–64 chars, start with letter)');
  }
  return a;
}

function resolveDisplayName(body = {}) {
  const name = String(body.displayName || body.display_name || body.label || '').trim();
  if (!name) throw new Error('display name is required');
  return name;
}

function encryptField(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (secretCrypto.isEncrypted(text)) return text;
  return secretCrypto.encrypt(text);
}

function decryptField(value) {
  const raw = String(value ?? '');
  if (!raw) return '';
  if (!secretCrypto.isEncrypted(raw)) return raw;
  return secretCrypto.decrypt(raw);
}

function fieldIsSet(value) {
  return !!String(value ?? '').trim();
}

function maskUsername(username) {
  const u = String(username || '').trim();
  if (!u) return '';
  if (u.length <= 2) return '*'.repeat(u.length);
  const at = u.indexOf('@');
  if (at > 1) {
    return `${u[0]}${'*'.repeat(Math.min(at - 1, 6))}${u.slice(at)}`;
  }
  return `${u[0]}${'*'.repeat(Math.min(u.length - 1, 6))}${u.slice(-1)}`;
}

function normalizeRecord(raw = {}) {
  const allowedActions = Array.isArray(raw.allowedActions)
    ? raw.allowedActions.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const status = STATUSES.has(raw.status) ? raw.status : 'active';
  return {
    id: raw.id || `acc-${Date.now().toString(36)}`,
    alias: raw.alias,
    displayName: typeof raw.displayName === 'string' ? raw.displayName.trim() : '',
    website: typeof raw.website === 'string' ? raw.website.trim() : '',
    websiteUrl: typeof raw.websiteUrl === 'string' ? raw.websiteUrl.trim() : '',
    username: typeof raw.username === 'string' ? raw.username : '',
    password: typeof raw.password === 'string' ? raw.password : '',
    otpSecret: typeof raw.otpSecret === 'string' ? raw.otpSecret : '',
    cookie: typeof raw.cookie === 'string' ? raw.cookie : '',
    browserProfile: typeof raw.browserProfile === 'string' ? raw.browserProfile.trim() : '',
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '',
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    status,
    allowedActions,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  };
}

function passwordFingerprint(encryptedValue) {
  if (!fieldIsSet(encryptedValue)) return '';
  return crypto.createHash('sha256').update(String(encryptedValue)).digest('hex').slice(0, 16);
}

function redactAccount(record) {
  if (!record) return null;
  const usernameDecrypted = fieldIsSet(record.username) ? decryptField(record.username) : '';
  return {
    id: record.id,
    alias: record.alias,
    displayName: record.displayName,
    website: record.website,
    websiteUrl: record.websiteUrl,
    usernameMasked: maskUsername(usernameDecrypted),
    secretSet: fieldIsSet(record.password),
    cookieSet: fieldIsSet(record.cookie),
    otpSet: fieldIsSet(record.otpSecret),
    browserProfile: record.browserProfile || null,
    sessionId: record.sessionId || null,
    status: record.status,
    allowedActions: record.allowedActions || [],
    notesSet: !!String(record.notes || '').trim(),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Boss UI list — full username, password as hash fingerprint only. */
function redactAccountForBoss(record) {
  if (!record) return null;
  const usernameDecrypted = fieldIsSet(record.username) ? decryptField(record.username) : '';
  return {
    id: record.id,
    alias: record.alias,
    displayName: record.displayName || record.alias,
    username: usernameDecrypted,
    passwordHash: passwordFingerprint(record.password),
    secretSet: fieldIsSet(record.password),
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function revealAccount(alias) {
  const a = validateAlias(alias);
  const hit = readAll().find((x) => x.alias === a);
  if (!hit) return null;
  return {
    alias: hit.alias,
    username: fieldIsSet(hit.username) ? decryptField(hit.username) : '',
    password: fieldIsSet(hit.password) ? decryptField(hit.password) : '',
  };
}

function resolveAgentAccount(alias) {
  const a = validateAlias(alias);
  const hit = readAll().find((x) => x.alias === a);
  if (!hit) return null;
  return {
    alias: hit.alias,
    display_name: hit.displayName || hit.alias,
    website: hit.website || '',
    allowed_actions: hit.allowedActions || [],
    browser_profile: hit.browserProfile || null,
    session_id: hit.sessionId || null,
    status: hit.status,
  };
}

function listAgentAccounts() {
  return readAll()
    .filter((a) => a.status === 'active')
    .map((a) => ({
      alias: a.alias,
      display_name: a.displayName || a.alias,
      website: a.website || '',
      allowed_actions: a.allowedActions || [],
      status: a.status,
    }));
}

function resolveInternalAccount(alias) {
  const a = validateAlias(alias);
  const hit = readAll().find((x) => x.alias === a);
  if (!hit) return null;
  return {
    ...hit,
    username: fieldIsSet(hit.username) ? decryptField(hit.username) : '',
    password: fieldIsSet(hit.password) ? decryptField(hit.password) : '',
    otpSecret: fieldIsSet(hit.otpSecret) ? decryptField(hit.otpSecret) : '',
    cookie: fieldIsSet(hit.cookie) ? decryptField(hit.cookie) : '',
  };
}

function listAccounts() {
  return readAll().map(redactAccount);
}

function listAccountsForBoss() {
  return readAll().map(redactAccountForBoss);
}

function getAccountByAlias(alias) {
  const a = validateAlias(alias);
  const hit = readAll().find((x) => x.alias === a);
  return hit ? redactAccountForBoss(hit) : null;
}

function uniqueAlias(base, accounts) {
  let candidate = normalizeAlias(base) || 'account';
  if (!ALIAS_RE.test(candidate)) candidate = 'account';
  const used = new Set(accounts.map((a) => a.alias));
  if (!used.has(candidate)) return candidate;
  for (let n = 2; n < 1000; n++) {
    const next = normalizeAlias(`${candidate}_${n}`);
    if (next && ALIAS_RE.test(next) && !used.has(next)) return next;
  }
  return `account_${Date.now().toString(36)}`;
}

function nextAccountAlias(accounts) {
  const used = new Set(accounts.map((a) => a.alias));
  for (let n = 1; n < 10000; n++) {
    const c = `account_${n}`;
    if (!used.has(c)) return c;
  }
  return `account_${Date.now().toString(36)}`;
}

function inferAlias(body, accounts) {
  // 多公司：显式 alias 也去重，避免两家用同软件(如两家 Bukku=alias 'bukku')撞名覆盖 → bukku / bukku_2 / bukku_3...
  if (body.alias) return uniqueAlias(validateAlias(body.alias), accounts);
  const label = String(body.displayName || body.label || '').trim();
  if (label) {
    const fromLabel = normalizeAlias(label);
    if (fromLabel.length >= 2) return uniqueAlias(fromLabel.slice(0, 40), accounts);
  }
  const user = String(body.username || '').trim();
  const fromUser = normalizeAlias((user.split('@')[0] || '').slice(0, 40));
  if (fromUser.length >= 2) return uniqueAlias(fromUser, accounts);
  return nextAccountAlias(accounts);
}

function createAccount(body = {}) {
  const accounts = readAll();
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '').trim();
  const displayName = resolveDisplayName(body);
  if (!username) throw new Error('username is required');
  if (!password) throw new Error('password is required');

  const alias = inferAlias(body, accounts);

  const record = normalizeRecord({
    alias,
    displayName,
    username: encryptField(username),
    password: encryptField(password),
    otpSecret: encryptField(body.otpSecret),
    cookie: encryptField(body.cookie),
    website: body.website,
    websiteUrl: body.websiteUrl,
    browserProfile: body.browserProfile,
    sessionId: body.sessionId,
    notes: body.notes,
    status: body.status,
    allowedActions: body.allowedActions,
  });

  accounts.push(record);
  writeAll(accounts);
  return redactAccount(record);
}

/** COO / MCP: save username + password + display name; alias optional (auto-generated). */
function saveAccount(body = {}) {
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '').trim();
  const displayName = resolveDisplayName(body);
  if (!username) throw new Error('username is required');
  if (!password) throw new Error('password is required');

  const aliasRaw = String(body.alias || '').trim();
  if (aliasRaw) {
    const alias = validateAlias(aliasRaw);
    const existing = readAll().find((x) => x.alias === alias);
    if (existing) {
      return updateAccount(alias, {
        username,
        password,
        displayName,
      });
    }
  }

  return createAccount({
    username,
    password,
    displayName,
    alias: aliasRaw || undefined,
  });
}

function updateAccount(alias, body = {}) {
  const a = validateAlias(alias);
  const accounts = readAll();
  const idx = accounts.findIndex((x) => x.alias === a);
  if (idx < 0) throw new Error('account not found');

  const cur = accounts[idx];
  const next = { ...cur, updatedAt: Date.now() };

  if (typeof body.displayName === 'string') {
    const dn = body.displayName.trim();
    if (!dn) throw new Error('display name is required');
    next.displayName = dn;
  } else if (typeof body.label === 'string') {
    const dn = body.label.trim();
    if (!dn) throw new Error('display name is required');
    next.displayName = dn;
  } else if (typeof body.display_name === 'string') {
    const dn = body.display_name.trim();
    if (!dn) throw new Error('display name is required');
    next.displayName = dn;
  }
  if (typeof body.website === 'string') next.website = body.website.trim();
  if (typeof body.websiteUrl === 'string') next.websiteUrl = body.websiteUrl.trim();
  if (typeof body.notes === 'string') next.notes = body.notes;
  if (typeof body.browserProfile === 'string') next.browserProfile = body.browserProfile.trim();
  if (typeof body.sessionId === 'string') next.sessionId = body.sessionId.trim();
  if (STATUSES.has(body.status)) next.status = body.status;
  if (Array.isArray(body.allowedActions)) {
    next.allowedActions = body.allowedActions.map((x) => String(x).trim()).filter(Boolean);
  }

  for (const field of SENSITIVE_FIELDS) {
    if (body[field] === undefined) continue;
    const val = String(body[field] ?? '').trim();
    if (!val) continue;
    next[field] = encryptField(val);
  }

  accounts[idx] = next;
  writeAll(accounts);
  return redactAccount(next);
}

function deleteAccount(alias) {
  const a = validateAlias(alias);
  const accounts = readAll();
  const next = accounts.filter((x) => x.alias !== a);
  if (next.length === accounts.length) throw new Error('account not found');
  writeAll(next);
  return { ok: true };
}

function testAccount(alias) {
  const hit = getAccountByAlias(alias);
  if (!hit) throw new Error('account not found');
  if (hit.status !== 'active') throw new Error('account is not active');
  return { ok: true, alias: hit.alias, status: hit.status };
}

function upsertAccount(accounts, record) {
  const idx = accounts.findIndex((x) => x.alias === record.alias);
  if (idx < 0) return [...accounts, record];
  const next = [...accounts];
  next[idx] = { ...accounts[idx], ...record, updatedAt: Date.now() };
  return next;
}

function formatAgentBlock() {
  const list = listAgentAccounts();
  if (!list.length) return '';
  const lines = list.map((a) => `- ${a.alias} (${a.display_name})`);
  return (
    `Saved web accounts (reference by alias only; never ask for passwords):\n${lines.join('\n')}\n\n` +
    'Tools: `list_web_accounts`, `get_account(alias)`, `save_web_account(username, password, display_name)`. ' +
    'display_name is required (e.g. 妈妈家). When the boss gives credentials in chat, ask for display name if missing, then call save_web_account — never repeat the password in your reply.'
  );
}

/**
 * Import an account captured via browser login (cookie-only; username/password optional).
 * Used by the browser-capture flow where the boss logs in manually.
 */
function importBrowserAccount(body = {}) {
  const accounts = readAll();
  const displayName = resolveDisplayName(body);
  const alias = inferAlias(body, accounts);

  const record = normalizeRecord({
    alias,
    displayName,
    username: encryptField(body.username || ''),
    password: '',
    otpSecret: '',
    cookie: encryptField(body.cookie || ''),
    website: typeof body.website === 'string' ? body.website.trim() : '',
    websiteUrl: typeof body.websiteUrl === 'string' ? body.websiteUrl.trim() : '',
    browserProfile: typeof body.browserProfile === 'string' ? body.browserProfile.trim() : '',
    notes: typeof body.notes === 'string' ? body.notes : '',
    status: 'active',
    allowedActions: Array.isArray(body.allowedActions) ? body.allowedActions : [],
    notes: typeof body.notes === 'string' ? body.notes.trim() : '',
    status: 'active',
  });

  const updated = upsertAccount(accounts, record);
  writeAll(updated);
  return { ok: true, alias: record.alias };
}

module.exports = {
  listAccounts,
  listAccountsForBoss,
  getAccountByAlias,
  revealAccount,
  createAccount,
  saveAccount,
  updateAccount,
  deleteAccount,
  testAccount,
  redactAccount,
  resolveAgentAccount,
  listAgentAccounts,
  resolveInternalAccount,
  formatAgentBlock,
  validateAlias,
  normalizeAlias,
  importBrowserAccount,
};
