const fs = require('node:fs');
const path = require('node:path');

const PROD_ECS_DEFAULTS = {
  ECS_BASE_URL: 'https://office.antlerzone.com',
  ECS_AUTH_URL: 'https://office.antlerzone.com',
  VITE_OFFICE_WEB_URL: 'https://office.antlerzone.com',
};

const PACKAGED_ENV_DEFAULTS = {
  PORT: '3020',
  DEV_PORT: '3300',
  OPENCLAW_WS_URL: 'ws://127.0.0.1:18789',
  LOG_LEVEL: 'INFO',
  ...PROD_ECS_DEFAULTS,
};

function parseEnvFile(content) {
  const result = {};
  for (const line of String(content || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function stringifyEnvFile(data) {
  const lines = [];
  for (const [key, value] of Object.entries(data)) {
    const v = value == null ? '' : String(value);
    const escaped =
      v.includes('\n') || v.includes('"') || v.includes("'")
        ? `"${v.replace(/"/g, '\\"')}"`
        : v;
    lines.push(`${key}=${escaped}`);
  }
  return `${lines.join('\n')}\n`;
}

function isPackagedRuntime() {
  if (process.env.ANTLEROFFICE_PACKAGED === '1') return true;
  const exe = path.basename(process.execPath || '').toLowerCase();
  return exe.includes('antleroffice') && !exe.includes('node');
}

function ensurePackagedEcsEnv(envPath) {
  const packaged = isPackagedRuntime();
  const exists = fs.existsSync(envPath);
  const current = exists ? parseEnvFile(fs.readFileSync(envPath, 'utf8')) : {};

  if (!packaged && exists) {
    return { updated: false, packaged: false, reason: 'dev-env-exists' };
  }

  const merged = { ...(packaged && !exists ? PACKAGED_ENV_DEFAULTS : {}), ...current };
  let changed = !exists;

  const fill = packaged ? PACKAGED_ENV_DEFAULTS : PROD_ECS_DEFAULTS;
  for (const [key, value] of Object.entries(fill)) {
    if (!String(merged[key] || '').trim()) {
      merged[key] = value;
      changed = true;
    }
  }

  // Heal stale ECS endpoints in packaged apps. Older installs wrote
  // ECS_BASE_URL=api.antlerzone.com (a dead host); on update we must FORCE the
  // current PROD endpoints, otherwise the app connects to nothing and silently
  // falls back to the empty local catalog (Disconnected + no NPCs).
  if (packaged) {
    for (const [key, value] of Object.entries(PROD_ECS_DEFAULTS)) {
      if (merged[key] !== value) {
        merged[key] = value;
        changed = true;
      }
    }
  }

  // ALWAYS load the merged values into process.env — even when the .env file
  // is already up to date. (Previously this only ran on first write, so every
  // later launch of the packaged app started with no ECS_BASE_URL and fell
  // back to the empty local catalog.)
  for (const [key, value] of Object.entries(merged)) {
    if (!process.env[key]) process.env[key] = value;
  }
  // Force the healed PROD endpoints into process.env even if a stale value was
  // inherited from the parent environment.
  if (packaged) {
    for (const [key, value] of Object.entries(PROD_ECS_DEFAULTS)) {
      process.env[key] = value;
    }
  }

  if (!changed) {
    return { updated: false, packaged, reason: 'already-configured' };
  }

  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, stringifyEnvFile(merged), 'utf8');

  return { updated: true, packaged, keys: Object.keys(fill).filter((k) => merged[k]) };
}

function syncStoreAuthFromEnv() {
  const base = String(process.env.ECS_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return false;
  try {
    const store = require('./store');
    const ecssync = require('./ecs-sync');
    const settings = store.readSettings();
    const nextAuth = { ...(settings.auth || {}), baseUrl: base };
    if (settings.auth?.baseUrl === base && settings.sync?.enabled !== false) {
      ecssync.refresh();
      return true;
    }
    store.writeSettings({
      ...settings,
      auth: nextAuth,
      sync: { ...(settings.sync || {}), enabled: true, intervalMs: 0 },
    });
    ecssync.refresh();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  ensurePackagedEcsEnv,
  syncStoreAuthFromEnv,
  isPackagedRuntime,
  PROD_ECS_DEFAULTS,
};
