// WhatsApp channel = boss instruction inbox only (self-chat).
// After linking, only messages from the linked number to itself reach OpenClaw.
// All other numbers and groups are ignored.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function configPath() {
  return path.join(os.homedir(), '.openclaw', 'openclaw.json');
}

function whatsappCredsPath(accountId = 'default') {
  const id = normalizeAccountId(accountId);
  return path.join(os.homedir(), '.openclaw', 'credentials', 'whatsapp', id, 'creds.json');
}

function normalizeAccountId(account) {
  const s = String(account || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'default';
}

function stripBom(s) {
  return String(s).replace(/^\uFEFF/, '');
}

function readJsonFile(filePath) {
  return JSON.parse(stripBom(fs.readFileSync(filePath, 'utf8')));
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function formatWhatsAppPhone(jid) {
  if (!jid) return null;
  const s = String(jid);
  const m = s.match(/^(\d{8,15})/);
  if (m) return `+${m[1]}`;
  const bare = s.split('@')[0].split(':')[0];
  return /^\d+$/.test(bare) ? `+${bare}` : bare || null;
}

/** Build allowFrom entries OpenClaw may match for the linked WhatsApp JID. */
function whatsappAllowFromVariants(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return [];

  const variants = new Set();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return [];

  function add(num) {
    const d = String(num).replace(/\D/g, '');
    if (!d || d.length < 8) return;
    variants.add(`+${d}`);
    variants.add(d);
    variants.add(`${d}@s.whatsapp.net`);
  }

  add(digits);

  // Local MY/SG style: 0123456789 → 60123456789
  if (digits.startsWith('0') && digits.length >= 9 && digits.length <= 12) {
    add(`60${digits.slice(1)}`);
    add(`65${digits.slice(1)}`);
  }

  return [...variants];
}

function writeWhatsAppAccountConfig(wa, accountId, patch) {
  const id = normalizeAccountId(accountId);
  if (wa.accounts?.[id]) {
    wa.accounts[id] = { ...wa.accounts[id], ...patch };
    return;
  }
  if (id === 'default' && (!wa.accounts || Object.keys(wa.accounts).length === 0)) {
    Object.assign(wa, patch);
    return;
  }
  wa.accounts = wa.accounts || {};
  wa.accounts[id] = { ...(wa.accounts[id] || {}), ...patch };
}

function buildInstructionModePatch(accountId = 'default', { phone: phoneHint, existingAllowFrom = [] } = {}) {
  const phone = phoneHint || linkedPhoneForAccount(accountId);
  const allowFrom = Array.isArray(existingAllowFrom) ? existingAllowFrom.filter(Boolean) : [];
  const selfAllowFrom = phone ? whatsappAllowFromVariants(phone) : [];
  const nextAllowFrom = [...new Set([...allowFrom, ...selfAllowFrom])];

  // Fail closed while the linked phone is not available yet. This prevents
  // OpenClaw's default WhatsApp pairing policy from replying to outside DMs.
  if (!nextAllowFrom.length) {
    return {
      instructionMode: true,
      dmPolicy: 'disabled',
      allowFrom: [],
      groupPolicy: 'disabled',
      groupAllowFrom: [],
      instructionRepairPending: true,
    };
  }

  return {
    instructionMode: true,
    dmPolicy: 'allowlist',
    allowFrom: nextAllowFrom,
    groupPolicy: 'disabled',
    groupAllowFrom: [],
    instructionRepairPending: false,
  };
}

function repairWhatsAppInstructionAccount(acct = {}, accountId = 'default') {
  if (!acct.instructionMode) return acct;
  const patch = buildInstructionModePatch(accountId, {
    existingAllowFrom: acct.allowFrom,
  });
  return {
    ...acct,
    ...patch,
  };
}

function repairWhatsAppChannelConfig(wa = {}) {
  const next = { ...wa };

  if (next.instructionMode) {
    Object.assign(next, repairWhatsAppInstructionAccount(next, 'default'));
  }

  if (next.accounts && typeof next.accounts === 'object') {
    next.accounts = { ...next.accounts };
    for (const [id, acct] of Object.entries(next.accounts)) {
      next.accounts[id] = acct?.instructionMode
        ? repairWhatsAppInstructionAccount(acct, id)
        : acct;
    }
  }

  return next;
}

function linkedPhoneForAccount(accountId = 'default') {
  const account = normalizeAccountId(accountId);
  try {
    const phone = formatWhatsAppPhone(readJsonFile(whatsappCredsPath(account))?.me?.id);
    if (phone) return phone;
  } catch {
    /* creds not ready */
  }
  return null;
}

function instructionModeFromConfig(accountId = 'default') {
  try {
    const cfg = readJsonFile(configPath());
    const wa = cfg?.channels?.whatsapp;
    if (!wa) return { enabled: false, allowFrom: [], phone: null };
    const id = normalizeAccountId(accountId);
    const acct = wa.accounts?.[id] || (id === 'default' ? wa : null);
    if (!acct?.instructionMode) return { enabled: false, allowFrom: [], phone: linkedPhoneForAccount(id) };
    return {
      enabled: true,
      allowFrom: Array.isArray(acct.allowFrom) ? acct.allowFrom : [],
      phone: linkedPhoneForAccount(id),
    };
  } catch {
    return { enabled: false, allowFrom: [], phone: null };
  }
}

function applyWhatsAppInstructionMode(accountId = 'default', { phone: phoneHint } = {}) {
  const account = normalizeAccountId(accountId);
  const phone = phoneHint || linkedPhoneForAccount(account);
  if (!phone) return { ok: false, error: 'WhatsApp phone not available yet — link the account first.' };

  const allowFrom = whatsappAllowFromVariants(phone);
  if (!allowFrom.length) return { ok: false, error: 'Could not derive allowlist from linked phone.' };

  const cfgPath = configPath();
  if (!fs.existsSync(cfgPath)) return { ok: false, error: 'OpenClaw config not found.' };

  const cfg = readJsonFile(cfgPath);
  cfg.channels = cfg.channels || {};
  cfg.channels.whatsapp = cfg.channels.whatsapp || {};
  const before = JSON.stringify(cfg.channels.whatsapp);

  writeWhatsAppAccountConfig(
    cfg.channels.whatsapp,
    account,
    buildInstructionModePatch(account, {
      phone,
      existingAllowFrom: allowFrom,
    }),
  );

  cfg.channels.whatsapp = repairWhatsAppChannelConfig(cfg.channels.whatsapp);
  const after = JSON.stringify(cfg.channels.whatsapp);

  if (before !== after) writeJsonFile(cfgPath, cfg);

  return {
    ok: true,
    account,
    phone,
    allowFrom,
    instructionMode: true,
    changed: before !== after,
    hint: 'Only self-chat messages from this number become instructions. Other numbers are ignored.',
  };
}

module.exports = {
  whatsappAllowFromVariants,
  repairWhatsAppInstructionAccount,
  repairWhatsAppChannelConfig,
  linkedPhoneForAccount,
  instructionModeFromConfig,
  applyWhatsAppInstructionMode,
  normalizeAccountId,
};
