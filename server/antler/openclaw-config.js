// Bridge to OpenClaw as the source of truth.
//
// When OpenClaw is installed, AntlerOffice reads/writes its real config
// (~/.openclaw/openclaw.json) and drives it through the `openclaw` CLI:
//   - agents      -> agents.list[] in the config
//   - model/key   -> `openclaw config set` / `openclaw models set`
//   - live office -> `openclaw gateway status`
// When OpenClaw is NOT installed every call degrades gracefully (returns
// { available:false }) and callers fall back to the local demo registry-store.
//
// Nothing here is shown to end users raw; callers turn results into plain UI.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnCmd, spawnHiddenDetached, spawnNodeHidden } = require('./spawn-util');
const debugLog = require('./debug-log');
const store = require('./store');
const channelInstruction = require('./channel-instruction-mode');

function openclawCmd() {
  return (store.readSettings().runtimes?.openclaw?.cmd || 'openclaw').trim() || 'openclaw';
}

function configPath() {
  return path.join(os.homedir(), '.openclaw', 'openclaw.json');
}

// PowerShell Set-Content can write UTF-8 BOM; JSON.parse rejects it.
function stripBom(s) {
  return String(s).replace(/^\uFEFF/, '');
}

function readJsonFile(filePath) {
  return JSON.parse(stripBom(fs.readFileSync(filePath, 'utf8')));
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function normalizeAccountId(account) {
  const s = String(account || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'default';
}

function whatsappCredsPath(accountId = 'default') {
  const id = normalizeAccountId(accountId);
  return path.join(os.homedir(), '.openclaw', 'credentials', 'whatsapp', id, 'creds.json');
}

function isIncompleteWhatsAppCreds(accountId = 'default') {
  try {
    const p = whatsappCredsPath(accountId);
    if (!fs.existsSync(p)) return false;
    const creds = readJsonFile(p);
    return creds.registered === false;
  } catch {
    return false;
  }
}

function isWhatsAppLinked(accountId = 'default') {
  try {
    const p = whatsappCredsPath(accountId);
    if (!fs.existsSync(p)) return false;
    const creds = readJsonFile(p);
    if (creds.registered === false) return false;
    return !!creds.me?.id;
  } catch {
    return false;
  }
}

function removePathSafe(targetPath) {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) return false;
    fs.rmSync(targetPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function removeWhatsAppCredentials(accountId = 'default') {
  const creds = whatsappCredsPath(accountId);
  return removePathSafe(path.dirname(creds));
}

function removeChannelConfigAccount(provider, account = 'default') {
  const ch = String(provider || '').trim().toLowerCase();
  const accountId = normalizeAccountId(account);
  if (!ch || !fs.existsSync(configPath())) return false;

  try {
    const cfg = readJsonFile(configPath());
    const channel = cfg?.channels?.[ch];
    if (!channel) return false;

    let changed = false;
    if (channel.accounts && typeof channel.accounts === 'object' && channel.accounts[accountId]) {
      delete channel.accounts[accountId];
      changed = true;
      if (Object.keys(channel.accounts).length === 0) delete channel.accounts;
    }

    if (accountId === 'default') {
      for (const key of [
        'account',
        'name',
        'phone',
        'linked',
        'connected',
        'instructionMode',
        'dmPolicy',
        'allowFrom',
        'groupPolicy',
        'groupAllowFrom',
        'instructionRepairPending',
      ]) {
        if (Object.prototype.hasOwnProperty.call(channel, key)) {
          delete channel[key];
          changed = true;
        }
      }
    }

    if (Object.keys(channel).length === 0) {
      delete cfg.channels[ch];
      changed = true;
    }

    if (changed) writeJsonFile(configPath(), cfg);
    return changed;
  } catch {
    return false;
  }
}

function accountStatusLineFromBlob(blob = '', provider, accountId = 'default') {
  const id = normalizeAccountId(accountId);
  const prov = String(provider || '').trim();
  if (!prov) return '';
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const provEsc = prov.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // OpenClaw may include display name: "WhatsApp wa-2 (test2): linked, running..."
  const re = new RegExp(`[-–]\\s*${provEsc}\\s+${esc}(?:\\s*\\([^)]*\\))?\\s*:([^\\n]+)`, 'i');
  const m = String(blob).match(re);
  return m ? m[1].trim() : '';
}

function isWhatsAppChannelRunningFromStatus(blob = '', accountId = 'default') {
  const line = accountStatusLineFromBlob(blob, 'whatsapp', accountId);
  const s = line || (normalizeAccountId(accountId) === 'default' ? String(blob) : '');
  if (!s || !/whatsapp/i.test(s)) return false;
  if (/not linked|disconnected|stopped/i.test(s)) return false;
  return /running|connected|inbound/i.test(s) || (/linked/i.test(s) && !/not linked/i.test(s) && !/error:/i.test(s));
}

function whatsappSessionInvalidFromBlob(blob = '', accountId = 'default') {
  const line = accountStatusLineFromBlob(blob, 'whatsapp', accountId);
  const s = line || String(blob);
  if (!/whatsapp/i.test(s) && !line) return false;
  return /401|unauthorized|connection failure|logged out|session.*invalid/i.test(s);
}

function formatWhatsAppPhone(jid) {
  if (!jid) return null;
  const s = String(jid);
  const m = s.match(/^(\d{8,15})/);
  if (m) return `+${m[1]}`;
  const bare = s.split('@')[0].split(':')[0];
  return /^\d+$/.test(bare) ? `+${bare}` : bare || null;
}

function channelAccountNameFromConfig(cfg, provider, accountId) {
  const ch = cfg?.channels?.[provider];
  if (!ch) return null;
  const id = normalizeAccountId(accountId);
  if (ch.accounts?.[id]?.name) return ch.accounts[id].name;
  if (id === 'default' && ch.name) return ch.name;
  return null;
}

async function channelsNextAccountId(provider) {
  const ch = String(provider || '')
    .trim()
    .toLowerCase();
  const list = await channelsList();
  const existing = new Set(
    (list.channels || []).filter((c) => c.provider === ch).map((c) => normalizeAccountId(c.account)),
  );
  if (existing.size === 0 && (ch === 'whatsapp' || ch === 'telegram')) return 'default';
  const prefix = ch === 'whatsapp' ? 'wa' : ch === 'telegram' ? 'tg' : ch.replace(/[^a-z0-9]/g, '').slice(0, 4) || 'ch';
  for (let n = 2; n < 1000; n += 1) {
    const id = `${prefix}-${n}`;
    if (!existing.has(id)) return id;
  }
  return `${prefix}-${Date.now().toString(36)}`;
}

async function channelsRename(provider, account, name) {
  if (!(await isAvailable())) return { ok: false, available: false };
  const ch = String(provider || '')
    .trim()
    .toLowerCase();
  const accountId = normalizeAccountId(account);
  const displayName = String(name || '').trim();
  if (!ch || !displayName) return { ok: false, available: true, error: 'missing provider or name' };
  return channelsAdd(ch, { account: accountId, name: displayName });
}

async function whatsappFinalizeLink(accountId = 'default', name) {
  await channelsEnsureWhatsApp({ account: accountId, name });
  const st = await whatsappLinkStatus({ accountId });
  await finalizeWhatsAppInstructionMode(accountId, { phone: st.phone || undefined });
  await gatewayStart();
}

function repairWhatsAppConfig(wa = {}) {
  const next = channelInstruction.repairWhatsAppChannelConfig({ ...wa });

  if (next.instructionMode) {
    Object.assign(next, channelInstruction.repairWhatsAppInstructionAccount(next, 'default'));
  } else {
    const allowFrom = Array.isArray(next.allowFrom) ? next.allowFrom.filter(Boolean) : [];
    if (next.dmPolicy === 'allowlist' && allowFrom.length === 0) next.dmPolicy = 'pairing';
    if (next.dmPolicy === 'open' && !allowFrom.includes('*')) next.allowFrom = ['*'];
    else next.allowFrom = allowFrom;
    const groupAllowFrom = Array.isArray(next.groupAllowFrom) ? next.groupAllowFrom.filter(Boolean) : [];
    if (next.groupPolicy === 'allowlist' && allowFrom.length === 0 && groupAllowFrom.length === 0) {
      next.groupPolicy = 'open';
    }
  }

  if (next.accounts && typeof next.accounts === 'object') {
    for (const [id, acct] of Object.entries(next.accounts)) {
      next.accounts[id] = acct?.instructionMode
        ? channelInstruction.repairWhatsAppInstructionAccount(acct, id)
        : acct;
    }
  }

  return next;
}

async function finalizeWhatsAppInstructionMode(accountId = 'default', { phone } = {}) {
  const account = normalizeAccountId(accountId);
  const applied = channelInstruction.applyWhatsAppInstructionMode(account, { phone });
  if (!applied.ok) {
    logAction(`whatsapp instruction mode skipped account=${account}`, applied.error || 'unknown');
    return applied;
  }
  logAction(
    `whatsapp instruction mode account=${account}`,
    `self-only allowFrom=${(applied.allowFrom || []).slice(0, 2).join(',')}…`,
  );
  if (!applied.changed) return applied;
  invalidate();
  try {
    await gatewayRestart();
  } catch (e) {
    logAction(`whatsapp instruction mode gateway restart`, e.message || String(e));
  }
  return applied;
}

function repairOpenClawConfig(cfg) {
  const next = { ...cfg };
  next.channels = next.channels || {};
  if (next.channels.whatsapp) {
    const repaired = repairWhatsAppConfig(next.channels.whatsapp);
    if (JSON.stringify(repaired) !== JSON.stringify(next.channels.whatsapp)) {
      next.channels.whatsapp = repaired;
      return { cfg: next, changed: true };
    }
  }
  return { cfg: next, changed: false };
}

function ensureValidOpenClawConfig() {
  const cfgPath = configPath();
  if (!fs.existsSync(cfgPath)) return false;
  const cfg = readJsonFile(cfgPath);
  const { cfg: repaired, changed } = repairOpenClawConfig(cfg);
  if (changed) writeJsonFile(cfgPath, repaired);
  return changed;
}

async function killGatewayPortListener(port = 18789) {
  if (process.platform !== 'win32') return;
  return new Promise((resolve) => {
    const ps = spawnCmd('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$c=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue|Select-Object -First 1;if($c){Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue}`,
    ]);
    ps.on('close', () => resolve());
    ps.on('error', () => resolve());
    setTimeout(resolve, 4000);
  });
}

function openclawGatewayEntry() {
  const roots = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'openclaw', 'dist', 'index.js'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'openclaw', 'dist', 'index.js'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs'),
  ];
  for (const p of roots) if (fs.existsSync(p)) return p;
  return null;
}

function resolveNodeExe() {
  const candidates = [
    'C:\\Program Files\\nodejs\\node.exe',
    path.join(process.env.APPDATA || '', 'npm', 'node.exe'),
    process.execPath,
  ];
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  return process.execPath;
}

async function killAllGatewayProcesses() {
  await killGatewayPortListener(18789);
  if (process.platform !== 'win32') return;
  return new Promise((resolve) => {
    const ps = spawnCmd('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -match 'openclaw.*gateway|gateway\\.cmd|openclaw-gateway') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ]);
    ps.on('close', () => resolve());
    ps.on('error', () => resolve());
    setTimeout(resolve, 5000);
  });
}

async function patchGatewayCmdHidden() {
  if (process.platform !== 'win32') return;
  const stateDir = path.join(os.homedir(), '.openclaw');
  const vbsPath = path.join(stateDir, 'gateway-hidden.vbs');
  const cmdPath = path.join(stateDir, 'gateway.cmd');
  const entry = openclawGatewayEntry();
  const nodeExe = resolveNodeExe();
  if (!entry || !fs.existsSync(cmdPath)) return;
  const q = (p) => `"${String(p).replace(/"/g, '""')}"`;
  const vbs = [
    'Set sh = CreateObject("Wscript.Shell")',
    `cmd = ${q(nodeExe)} & " " & ${q(entry)} & " gateway --port 18789"`,
    'sh.Run cmd, 0, False',
    '',
  ].join('\r\n');
  fs.writeFileSync(vbsPath, vbs, 'utf8');
  const cmd = ['@echo off', 'rem OpenClaw Gateway — hidden background (AntlerOffice)', `wscript.exe //B //Nologo "${vbsPath}"`, ''].join(
    '\r\n',
  );
  try {
    fs.writeFileSync(cmdPath, cmd, 'utf8');
  } catch {
    /* locked */
  }
}

async function removeGatewayScheduledTask() {
  if (process.platform !== 'win32') return;
  await exec(['gateway', 'uninstall', '--json'], { timeoutMs: 15000 });
  return new Promise((resolve) => {
    const ps = spawnCmd('schtasks', ['/Delete', '/TN', 'OpenClaw Gateway', '/F']);
    ps.on('close', () => resolve());
    ps.on('error', () => resolve());
    setTimeout(resolve, 3000);
  });
}

async function gatewayStartHidden() {
  logAction('spawn gateway (hidden background)');
  await patchGatewayCmdHidden();
  const cmdPath = path.join(os.homedir(), '.openclaw', 'gateway.cmd');
  if (process.platform === 'win32' && fs.existsSync(cmdPath)) {
    spawnHiddenDetached('cmd.exe', ['/c', cmdPath]);
    return;
  }
  const entry = openclawGatewayEntry();
  const nodeExe = resolveNodeExe();
  if (entry) spawnNodeHidden(nodeExe, entry, ['gateway', '--port', '18789']);
  else spawnHiddenDetached(openclawCmd(), ['gateway', 'run']);
}

async function waitForGatewayProbe({ attempts = 8, delayMs = 1500 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const probe = await gatewayProbe();
    if (probe.running) return probe;
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return gatewayProbe();
}

async function gatewayStopFully() {
  await exec(['gateway', 'stop', '--json'], { timeoutMs: 30000 });
  await killAllGatewayProcesses();
}

function redactCliArgs(args) {
  const out = [...args];
  for (let i = 0; i < out.length - 1; i += 1) {
    if (['--token', '--password', '--api-key'].includes(out[i])) out[i + 1] = '***';
  }
  return out;
}

function logAction(message, detail) {
  debugLog.logInfo('openclaw-bridge', message, detail);
}

// Run `<openclaw> <args...>` safely (args are escaped, never shell-concatenated).
// Never throws — returns a result object.
function exec(args, { timeoutMs = 15000, input } = {}) {
  const cmd = openclawCmd();
  return new Promise((resolve) => {
    let done = false;
    let child;
    const finish = (result) => {
      debugLog.logCli(cmd, redactCliArgs(args), result);
      resolve(result);
    };
    try {
      child = spawnCmd(cmd, args);
    } catch (e) {
      return finish({ ok: false, code: -1, stdout: '', stderr: '', error: e.message });
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, code: -1, stdout, stderr, error: 'timeout' });
    }, timeoutMs);
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      finish({ ok: false, code: -1, stdout, stderr, error: err.message });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      finish({ ok: code === 0, code, stdout, stderr });
    });
    if (input != null) {
      try {
        child.stdin.write(input);
        child.stdin.end();
      } catch {
        /* ignore */
      }
    }
  });
}

let availCache = { ts: 0, value: null };
async function isAvailable() {
  if (availCache.value !== null && Date.now() - availCache.ts < 10000) return availCache.value;
  const r = await exec(['--version'], { timeoutMs: 6000 });
  // Don't be fooled by the shell's own error text — on Windows a missing command
  // prints "'openclaw' is not recognized…", which literally contains "openclaw".
  const blob = `${r.stdout} ${r.stderr}`;
  const notFound = /not recognized|not found|no such file|cannot find|command not found/i.test(blob);
  const looksReal = r.ok || /\d+\.\d+\.\d+/.test(r.stdout) || /openclaw/i.test(r.stdout);
  const value = !notFound && looksReal;
  availCache = { ts: Date.now(), value };
  return value;
}

function invalidate() {
  availCache = { ts: 0, value: null };
}

// Last real agent run outcome, so the UI can show "connected" vs "key invalid"
// without re-probing (key validity is only truly known once a turn runs).
let health = { ts: 0, lastRunOk: null, authError: false, message: '' };
function noteRun({ ok, error }) {
  const auth = /401|incorrect api key|invalid api key|unauthorized|no auth|missing api key/i.test(error || '');
  health = { ts: Date.now(), lastRunOk: !!ok, authError: !ok && auth, message: ok ? '' : String(error || '').slice(0, 200) };
}
function getHealth() {
  return health;
}

// Cumulative token usage across OpenClaw runs (for the Settings → Usage panel).
let usage = { runs: 0, okRuns: 0, inputTokens: 0, outputTokens: 0, lastModel: '', lastRunAt: 0 };
function noteUsage({ ok, model, lastCallUsage } = {}) {
  usage.runs += 1;
  if (ok) usage.okRuns += 1;
  if (model) usage.lastModel = model;
  if (lastCallUsage) {
    usage.inputTokens += Number(lastCallUsage.input || 0);
    usage.outputTokens += Number(lastCallUsage.output || 0);
  }
  usage.lastRunAt = Date.now();
}
function getUsage() {
  return usage;
}

// Read the raw config. Prefer the CLI's JSON, else read the file directly.
async function getConfig() {
  if (await isAvailable()) {
    const r = await exec(['config', 'get', '--json'], { timeoutMs: 8000 });
    if (r.ok && r.stdout.trim()) {
      try {
        return { available: true, config: JSON.parse(r.stdout) };
      } catch {
        /* fall through to file */
      }
    }
  }
  try {
    const raw = stripBom(fs.readFileSync(configPath(), 'utf8'));
    return { available: true, config: JSON.parse(stripJson5(raw)) };
  } catch {
    return { available: false, config: null };
  }
}

// Lenient json5 -> JSON: drop comments + trailing commas, quote bare keys.
function stripJson5(raw) {
  return String(raw)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
}

// agents.list[] in OpenClaw config = our NPC roster.
async function listAgents() {
  const { available, config } = await getConfig();
  if (!available || !config) return { available: false, agents: [] };
  const list = config?.agents?.list || [];
  return { available: true, agents: Array.isArray(list) ? list : [] };
}

async function setConfig(dotPath, jsonValue) {
  if (!(await isAvailable())) return { ok: false, available: false };
  const r = await exec(['config', 'set', dotPath, JSON.stringify(jsonValue), '--strict-json', '--merge']);
  return { ok: r.ok, available: true, error: r.ok ? undefined : r.stderr || r.error };
}

// Set the OpenAI (or other provider) key + provider allowlist. The secret is
// written straight into ~/.openclaw/openclaw.json via fs — NEVER passed on the
// command line (which would leak it to the shell / process list). Falls back to
// reporting unavailable when OpenClaw isn't installed.
// Store an API key the way THIS OpenClaw build expects: in its auth-profile
// store (~/.openclaw/agents/<id>/agent/auth-profiles.json), via
// `openclaw models auth paste-token`. The key goes over stdin (never argv), so
// it's not exposed in the process list. Overwrites the provider's default
// profile so the configured model can actually authenticate.
// Save a provider API key into OpenClaw's auth store. We write the JSON file
// directly instead of using `models auth paste-token`, because that command is
// an interactive TUI prompt that does NOT reliably consume piped stdin when
// spawned without a TTY — which silently left the OLD key in place. Direct write
// is deterministic and uses the proper "api_key" profile type.
async function setKey(provider, apiKey, { agentId } = {}) {
  if (!(await isAvailable())) return { ok: false, available: false };
  const prov = String(provider || 'openai').trim() || 'openai';
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, available: true, error: 'missing apiKey' };

  // Resolve the per-agent auth store path (status reports it for the active agent).
  let storePath;
  try {
    const st = await modelsStatus();
    storePath = st.status?.auth?.storePath;
  } catch {
    /* fall through to default */
  }
  const id = agentId || store.readSettings().runtimes?.openclaw?.agentId || 'main';
  if (!storePath) storePath = path.join(os.homedir(), '.openclaw', 'agents', id, 'agent', 'auth-profiles.json');

  const pid = `${prov}:default`;
  try {
    // 1) Credential store: official format is `type: api_key` + `key`.
    let data = { version: 1, profiles: {}, lastGood: {}, usageStats: {} };
    try {
      data = readJsonFile(storePath) || data;
    } catch {
      /* new file */
    }
    data.profiles = data.profiles || {};
    data.profiles[pid] = { type: 'api_key', provider: prov, key };
    data.lastGood = data.lastGood || {};
    data.lastGood[prov] = pid;
    if (data.usageStats?.[pid]) data.usageStats[pid] = { errorCount: 0 }; // clear stale failures
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    writeJsonFile(storePath, data);

    // 2) Binding in openclaw.json must agree on the mode, else the agent loader
    //    looks for the wrong credential shape and reports "No API key found".
    try {
      const cfgPath = configPath();
      const cfg = readJsonFile(cfgPath);
      cfg.auth = cfg.auth || {};
      cfg.auth.profiles = cfg.auth.profiles || {};
      cfg.auth.profiles[pid] = { provider: prov, mode: 'api_key' };
      cfg.auth.order = cfg.auth.order || {};
      const order = new Set([pid, ...(cfg.auth.order[prov] || [])]);
      cfg.auth.order[prov] = [...order];
      writeJsonFile(cfgPath, cfg);
    } catch {
      /* config binding best-effort; profile write above is the critical part */
    }

    invalidate();
    return { ok: true, available: true };
  } catch (e) {
    return { ok: false, available: true, error: e.message };
  }
}

async function deleteKey(provider, { profileId, agentId } = {}) {
  if (!(await isAvailable())) return { ok: false, available: false };
  const prov = String(provider || '').trim();
  if (!prov) return { ok: false, available: true, error: 'missing provider' };

  let storePath;
  try {
    const st = await modelsStatus();
    storePath = st.status?.auth?.storePath;
  } catch {
    /* fall through */
  }
  const id = agentId || store.readSettings().runtimes?.openclaw?.agentId || 'main';
  if (!storePath) storePath = path.join(os.homedir(), '.openclaw', 'agents', id, 'agent', 'auth-profiles.json');

  const pid = profileId || `${prov}:default`;
  let removedProfile = false;
  let removedConfigKey = false;

  try {
    let data = { version: 1, profiles: {}, lastGood: {}, usageStats: {} };
    try {
      data = readJsonFile(storePath) || data;
    } catch {
      /* new file */
    }
    data.profiles = data.profiles || {};
    if (data.profiles[pid]) {
      delete data.profiles[pid];
      removedProfile = true;
    }
    if (data.lastGood?.[prov] === pid) delete data.lastGood[prov];
    if (data.usageStats?.[pid]) delete data.usageStats[pid];
    if (removedProfile) writeJsonFile(storePath, data);

    try {
      const cfgPath = configPath();
      const cfg = readJsonFile(cfgPath);
      if (cfg.auth?.profiles?.[pid]) {
        delete cfg.auth.profiles[pid];
        removedConfigKey = true;
      }
      if (cfg.auth?.order?.[prov]) {
        cfg.auth.order[prov] = (cfg.auth.order[prov] || []).filter((entry) => entry !== pid);
        if (cfg.auth.order[prov].length === 0) delete cfg.auth.order[prov];
      }
      const providerCfg = cfg.models?.providers?.[prov];
      if (providerCfg && typeof providerCfg === 'object' && providerCfg.apiKey) {
        delete providerCfg.apiKey;
        removedConfigKey = true;
      }
      if (removedConfigKey || removedProfile) writeJsonFile(cfgPath, cfg);
    } catch {
      /* config cleanup best-effort */
    }

    if (!removedProfile && !removedConfigKey) {
      return { ok: false, available: true, error: 'no key found for provider' };
    }

    invalidate();
    return { ok: true, available: true };
  } catch (e) {
    return { ok: false, available: true, error: e.message };
  }
}

async function setModel(ref) {
  if (!(await isAvailable())) return { ok: false, available: false };
  const r = await exec(['models', 'set', ref]);
  return { ok: r.ok, available: true, error: r.ok ? undefined : r.stderr || r.error };
}

// List models OpenClaw knows. `all:true` returns the full catalog (~hundreds)
// with an `available` flag (true when that provider already has a key); without
// it, only the configured/allowed models are returned.
async function listModels({ all } = {}) {
  if (!(await isAvailable())) return { available: false, models: [] };
  const args = ['models', 'list', '--json'];
  if (all) args.push('--all');
  const r = await exec(args, { timeoutMs: 20000 });
  if (!r.ok && !r.stdout) return { available: true, ok: false, models: [], error: r.stderr || r.error };
  const data = parseLooseJson(r.stdout || '') || {};
  return { available: true, ok: true, models: Array.isArray(data.models) ? data.models : [] };
}

// Slug a display name into an OpenClaw-friendly workspace folder name. OpenClaw
// normalizes the agent id itself, but it requires a --workspace dir up front.
function slugify(name) {
  return (
    String(name || 'agent')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent'
  );
}

// Create a real isolated OpenClaw agent (own workspace + auth + routing). This
// is what backs "hire a new NPC": 1 NPC = 1 OpenClaw agent. Returns the agentId
// OpenClaw assigned (normalized from the name).
async function agentsAdd({ name, model } = {}) {
  if (!(await isAvailable())) return { ok: false, available: false };
  const slug = slugify(name);
  const workspace = path.join(os.homedir(), '.openclaw', 'workspaces', slug);
  const args = ['agents', 'add', String(name || slug), '--non-interactive', '--workspace', workspace, '--json'];
  if (model) args.push('--model', model);
  const r = await exec(args, { timeoutMs: 60000 });
  invalidate();
  const data = parseLooseJson(r.stdout || '') || {};
  if (!data.agentId) return { ok: false, available: true, error: r.stderr || r.error || 'no agentId returned' };
  return { ok: true, available: true, agentId: data.agentId, workspace: data.workspace, agentDir: data.agentDir };
}

async function agentsList() {
  if (!(await isAvailable())) return { available: false, agents: [] };
  const r = await exec(['agents', 'list', '--json'], { timeoutMs: 15000 });
  const data = parseLooseJson(r.stdout || '');
  return { available: true, agents: Array.isArray(data) ? data : data?.agents || [] };
}

async function agentsDelete(id) {
  if (!(await isAvailable())) return { ok: false, available: false };
  const agentId = String(id || '').trim();
  if (!agentId || agentId === 'main') return { ok: false, available: true, error: 'invalid agent id' };
  const r = await exec(['agents', 'delete', agentId, '--force', '--json'], { timeoutMs: 30000 });
  invalidate();
  return { ok: r.ok, available: true, error: r.ok ? undefined : r.stderr || r.error };
}

async function modelsStatus() {
  if (!(await isAvailable())) return { available: false };
  const r = await exec(['models', 'status', '--json'], { timeoutMs: 8000 });
  if (!r.ok) return { available: true, ok: false, error: r.stderr || r.error };
  try {
    return { available: true, ok: true, status: JSON.parse(r.stdout) };
  } catch {
    return { available: true, ok: true, status: { raw: r.stdout.trim() } };
  }
}

async function gatewayStatus() {
  if (!(await isAvailable())) return { available: false, running: false };
  const probe = await gatewayProbe();
  return {
    available: true,
    running: !!probe.running,
    url: probe.url,
    dashboard: probe.dashboard,
    error: probe.error,
    detail: probe.detail,
  };
}

function getGatewayToken() {
  try {
    const cfg = readJsonFile(configPath());
    return cfg.gateway?.auth?.token || process.env.OPENCLAW_GATEWAY_TOKEN || '';
  } catch {
    return '';
  }
}

// Accurate reachability via `gateway probe --json` (needs auth token when configured).
async function gatewayProbe() {
  if (!(await isAvailable())) return { available: false, running: false };
  const args = ['gateway', 'probe', '--json', '--timeout', '8000'];
  const token = getGatewayToken();
  if (token) args.push('--token', token);
  const r = await exec(args, { timeoutMs: 15000 });
  const data = parseLooseJson(r.stdout || '');
  const target = data?.targets?.find((t) => t.active) || data?.targets?.[0];
  const url = target?.url || 'ws://127.0.0.1:18789';
  const rpcOk = !!data?.ok;
  return {
    available: true,
    running: rpcOk,
    ok: rpcOk,
    url,
    dashboard: url.replace(/^ws/, 'http').replace(/\/$/, '') + '/',
    error: target?.connect?.error || data?.error || '',
    detail: data || { raw: (r.stdout || r.stderr || '').trim() },
  };
}

async function gatewayProbeReliable({ attempts = 3, delayMs = 1200 } = {}) {
  let last = await gatewayProbe();
  for (let i = 1; i < attempts && !last.running; i += 1) {
    await new Promise((res) => setTimeout(res, delayMs));
    last = await gatewayProbe();
  }
  return last;
}

async function getChannelsStatusJson() {
  try {
    const r = await exec(['channels', 'status', '--json'], { timeoutMs: 15000 });
    return parseLooseJson(r.stdout || '');
  } catch {
    return null;
  }
}

function whatsappAccountFromStatusJson(data, accountId = 'default') {
  const id = normalizeAccountId(accountId);
  const accounts = data?.channelAccounts?.whatsapp;
  if (Array.isArray(accounts)) {
    const hit = accounts.find((a) => normalizeAccountId(a.accountId) === id);
    if (hit) return hit;
  }
  if (id === 'default' && data?.channels?.whatsapp) {
    return { accountId: 'default', ...data.channels.whatsapp };
  }
  return null;
}

function whatsappLiveFromStatusJson(acct) {
  if (!acct) return false;
  if (acct.connected) return true;
  return !!(acct.linked && acct.running && !acct.lastError);
}

async function whatsappChannelLive(accountId = 'default') {
  const data = await getChannelsStatusJson();
  const acct = whatsappAccountFromStatusJson(data, accountId);
  if (acct) return whatsappLiveFromStatusJson(acct);
  return isWhatsAppChannelRunningFromStatus(await getWhatsAppChannelStatusBlob(), accountId);
}

async function whatsappLinkStatus({ accountId = 'default' } = {}) {
  const account = normalizeAccountId(accountId);
  const credsLinked = isWhatsAppLinked(account);
  const probe = await gatewayProbeReliable({ attempts: 2 });
  const statusJson = await getChannelsStatusJson();
  const acct = whatsappAccountFromStatusJson(statusJson, account);
  const statusBlob = acct ? '' : await getWhatsAppChannelStatusBlob();
  const sessionInvalid = acct?.lastError
    ? /401|unauthorized|connection failure|logged out|session.*invalid/i.test(String(acct.lastError))
    : whatsappSessionInvalidFromBlob(statusBlob, account);
  const channelLive = acct ? whatsappLiveFromStatusJson(acct) : isWhatsAppChannelRunningFromStatus(statusBlob, account);
  const linked = (credsLinked || channelLive || !!(acct?.linked && acct?.connected)) && !sessionInvalid;
  const incomplete = isIncompleteWhatsAppCreds(account) && !channelLive && !acct?.connected;
  const line = accountStatusLineFromBlob(statusBlob, 'whatsapp', account);
  const disconnected =
    (!!line && /disconnected/i.test(line) && !sessionInvalid && !channelLive) ||
    !!(acct && acct.linked && !acct.connected && !acct.running);
  let phone = acct?.self?.e164 || null;
  if (!phone) {
    try {
      phone = formatWhatsAppPhone(readJsonFile(whatsappCredsPath(account))?.me?.id);
    } catch {
      phone = null;
    }
  }
  let instruction = channelInstruction.instructionModeFromConfig(account);
  if (linked && phone && instruction.enabled) {
    await finalizeWhatsAppInstructionMode(account, { phone });
    instruction = channelInstruction.instructionModeFromConfig(account);
  }
  return {
    available: await isAvailable(),
    account,
    linked,
    connected: channelLive,
    incomplete,
    sessionInvalid,
    disconnected,
    gateway: probe.running,
    gatewayError: probe.error || '',
    phone,
    instructionMode: instruction.enabled,
    instructionHint: instruction.enabled
      ? 'Self-chat only — other numbers cannot reach OpenClaw.'
      : null,
  };
}

async function whatsappLinkStatuses() {
  const data = await channelsList();
  const accounts = (data.channels || [])
    .filter((c) => c.provider === 'whatsapp')
    .map((c) => normalizeAccountId(c.account));
  const unique = [...new Set(accounts.length ? accounts : ['default'])];
  const statuses = {};
  for (const account of unique) {
    statuses[account] = await whatsappLinkStatus({ accountId: account });
  }
  return { available: data.available, accounts: statuses };
}

async function gatewayStart() {
  if (!(await isAvailable())) return { ok: false, available: false };
  ensureValidOpenClawConfig();
  const existing = await gatewayProbe();
  if (existing.running) return { ok: true, available: true, action: 'start', probe: existing, hidden: true };
  // Gateway already down — start without heavy stop/uninstall cycle.
  await gatewayStartHidden();
  invalidate();
  const probe = await waitForGatewayProbe({ attempts: 15, delayMs: 2000 });
  return { ok: !!probe.running, available: true, action: 'start', probe, hidden: true };
}

async function gatewayStop() {
  if (!(await isAvailable())) return { ok: false, available: false };
  const r = await exec(['gateway', 'stop', '--json'], { timeoutMs: 30000 });
  const data = parseLooseJson(r.stdout || '');
  await gatewayStopFully();
  invalidate();
  return { ok: !!(r.ok || data?.ok), available: true, action: 'stop', detail: data };
}

async function gatewayRestart({ fullReset = false } = {}) {
  if (!(await isAvailable())) return { ok: false, available: false };
  ensureValidOpenClawConfig();
  await gatewayStopFully();
  if (fullReset) {
    await removeGatewayScheduledTask();
    await new Promise((res) => setTimeout(res, 2000));
  } else {
    await new Promise((res) => setTimeout(res, 1000));
  }
  await gatewayStartHidden();
  invalidate();
  const probe = await waitForGatewayProbe({ attempts: 15, delayMs: 2000 });
  return { ok: !!probe.running, available: true, action: 'restart', probe, hidden: true };
}

function cronJobsPath() {
  return path.join(os.homedir(), '.openclaw', 'cron', 'jobs.json');
}

// ── Cron (agent work schedules via OpenClaw gateway) ───────────────────────
async function cronList() {
  if (!(await isAvailable())) return { available: false, jobs: [], gateway: false };
  const r = await exec(['cron', 'list', '--json', '--all'], { timeoutMs: 15000 });
  const data = parseLooseJson(r.stdout || '');
  if (data && Array.isArray(data.jobs)) {
    return { available: true, jobs: data.jobs, gateway: true, total: data.total ?? data.jobs.length };
  }
  // Gateway down: still show jobs from the on-disk store.
  try {
    const local = readJsonFile(cronJobsPath());
    return { available: true, jobs: local.jobs || [], gateway: false };
  } catch {
    return { available: true, jobs: [], gateway: false, error: (r.stderr || r.error || '').slice(0, 200) };
  }
}

async function cronAdd({ name, message, agentId, every, cron, at, enabled = true } = {}) {
  if (!(await isAvailable())) return { ok: false, available: false };
  const args = ['cron', 'add', '--json'];
  if (name) args.push('--name', String(name));
  if (message) args.push('--message', String(message));
  if (agentId) args.push('--agent', String(agentId));
  if (every) args.push('--every', String(every));
  if (cron) args.push('--cron', String(cron));
  if (at) args.push('--at', String(at));
  if (!enabled) args.push('--disabled');
  const r = await exec(args, { timeoutMs: 30000 });
  const data = parseLooseJson(r.stdout || '');
  if (data?.id) return { ok: true, job: data };
  return { ok: false, available: true, error: (r.stderr || r.error || 'cron add failed — is the gateway running?').slice(0, 300) };
}

async function cronRemove(id) {
  if (!(await isAvailable())) return { ok: false, available: false };
  const jobId = String(id || '').trim();
  if (!jobId) return { ok: false, available: true, error: 'missing job id' };
  const r = await exec(['cron', 'rm', jobId, '--json'], { timeoutMs: 20000 });
  const data = parseLooseJson(r.stdout || '');
  return { ok: !!(r.ok || data?.ok || data?.removed), available: true, error: r.ok ? undefined : (r.stderr || r.error || '').slice(0, 300) };
}

async function cronSetEnabled(id, enabled) {
  if (!(await isAvailable())) return { ok: false, available: false };
  const jobId = String(id || '').trim();
  if (!jobId) return { ok: false, available: true, error: 'missing job id' };
  const cmd = enabled ? 'enable' : 'disable';
  const r = await exec(['cron', cmd, jobId], { timeoutMs: 20000 });
  return { ok: r.ok, available: true, error: r.ok ? undefined : (r.stderr || r.error || '').slice(0, 300) };
}

async function cronRun(id) {
  if (!(await isAvailable())) return { ok: false, available: false };
  const jobId = String(id || '').trim();
  if (!jobId) return { ok: false, available: true, error: 'missing job id' };
  const r = await exec(['cron', 'run', jobId], { timeoutMs: 120000 });
  const data = parseLooseJson(r.stdout || '');
  return { ok: r.ok, available: true, result: data, error: r.ok ? undefined : (r.stderr || r.error || '').slice(0, 300) };
}

function formatSchedule(job) {
  const s = job?.schedule;
  if (!s) return '—';
  if (s.kind === 'every' && s.everyMs) {
    const mins = Math.round(s.everyMs / 60000);
    if (mins < 60) return `Every ${mins}m`;
    const hrs = Math.round(mins / 60);
    return `Every ${hrs}h`;
  }
  if (s.kind === 'cron' && s.expr) return s.expr;
  if (s.kind === 'at' && s.at) return `Once @ ${new Date(s.at).toLocaleString()}`;
  return s.kind || '—';
}

// Live sessions for the office view. Best-effort: tolerate CLIs that don't
// expose this yet (returns []), so the pixel office still renders.
async function listSessions() {
  if (!(await isAvailable())) return { available: false, sessions: [] };
  const r = await exec(['sessions', 'list', '--json'], { timeoutMs: 8000 });
  if (r.ok && r.stdout.trim()) {
    try {
      const data = JSON.parse(r.stdout);
      return { available: true, sessions: Array.isArray(data) ? data : data.sessions || [] };
    } catch {
      /* ignore */
    }
  }
  return { available: true, sessions: [] };
}

// ── OpenClaw skills (`openclaw skills list --json`) ─────────────────────────
// This OpenClaw build ships skills bundled; each is "eligible" once its
// requirements (API keys / CLIs) are met. There is no registry search/install
// verb here, so the Skill Market browses the real bundled catalog and shows
// readiness. We normalize each entry to { name, description, eligible, source }.
async function skillsList() {
  if (!(await isAvailable())) return { available: false, skills: [] };
  const r = await exec(['skills', 'list', '--json'], { timeoutMs: 20000 });
  if (r.ok && r.stdout.trim()) {
    try {
      const d = JSON.parse(r.stdout);
      const arr = Array.isArray(d) ? d : d.skills || [];
      const skills = arr.map((s) => ({
        name: s.name,
        description: s.description || '',
        eligible: !!s.eligible,
        disabled: !!s.disabled,
        source: s.source || (s.bundled ? 'openclaw-bundled' : ''),
        homepage: s.homepage || '',
      }));
      return { available: true, skills };
    } catch {
      /* ignore */
    }
  }
  return { available: true, skills: [] };
}

// Browse = the bundled catalog, filtered locally by a search term.
async function skillsSearch(query) {
  const all = await skillsList();
  if (!all.available) return { available: false, skills: [] };
  const q = String(query || '').trim().toLowerCase();
  const skills = q
    ? all.skills.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(q))
    : all.skills;
  return { available: true, skills };
}

// Detailed info (requirements, how to enable) for one skill — plain text.
async function skillInfo(name) {
  if (!(await isAvailable())) return { available: false, text: '' };
  const r = await exec(['skills', 'info', String(name || ''), '--verbose'], { timeoutMs: 20000 });
  return { available: true, text: (r.stdout || r.stderr || '').trim() };
}

// ── Channels (Telegram/WhatsApp/Discord/… via `openclaw channels`) ──────────
// The "front desk" of the office: how the boss reaches the team from outside.
// `channels list --json` is config-level and works without the gateway; live
// status needs a running gateway, so we degrade gracefully when it's down.
const CHANNEL_PROVIDERS = [
  'telegram',
  'whatsapp',
  'feishu',
  'qqbot',
  'dingtalk',
  'wecom',
  'discord',
  'slack',
  'signal',
  'imessage',
  'line',
  'msteams',
  'mattermost',
  'matrix',
  'googlechat',
];

async function channelsList() {
  if (!(await isAvailable())) return { available: false, channels: [], providers: CHANNEL_PROVIDERS };
  const r = await exec(['channels', 'list', '--json'], { timeoutMs: 12000 });
  const data = parseLooseJson(r.stdout || '');
  const chat = data?.chat || {};
  let cfg = null;
  try {
    cfg = readJsonFile(configPath());
  } catch {
    cfg = null;
  }
  const channels = [];
  for (const provider of Object.keys(chat)) {
    const accounts = Array.isArray(chat[provider]) ? chat[provider] : [];
    for (const account of accounts) {
      const accountId = normalizeAccountId(account);
      const entry = { provider, account: accountId, configured: true };
      if (cfg) entry.name = channelAccountNameFromConfig(cfg, provider, accountId);
      if (provider === 'whatsapp') {
        try {
          const creds = readJsonFile(whatsappCredsPath(accountId));
          entry.phone = formatWhatsAppPhone(creds?.me?.id);
        } catch {
          entry.phone = null;
        }
        const instruction = channelInstruction.instructionModeFromConfig(accountId);
        entry.instructionMode = instruction.enabled;
        // OpenClaw may report a default WhatsApp account even after credentials
        // and config were removed. Do not show that placeholder as connected.
        if (!entry.phone && !entry.instructionMode && !channelAccountNameFromConfig(cfg, provider, accountId)) {
          continue;
        }
      }
      channels.push(entry);
    }
  }
  return { available: true, channels, providers: CHANNEL_PROVIDERS };
}

// Live channel health from the gateway. Returns gateway:false (with plain text)
// when the gateway isn't running, so the UI can still show config-level state.
async function channelsStatus() {
  if (!(await isAvailable())) return { available: false, gateway: false, text: '' };
  const r = await exec(['channels', 'status'], { timeoutMs: 12000 });
  const blob = `${r.stdout} ${r.stderr}`;
  const gateway = !/gateway (not reachable|closed)|\b1006\b/i.test(blob);
  return { available: true, gateway, text: (r.stdout || '').trim() };
}

// Add/update a channel account. Token field name varies per provider; we map
// the common ones (Telegram/Discord use --token, Slack uses bot/app tokens).
async function channelsAdd(provider, opts = {}) {
  if (!(await isAvailable())) return { ok: false, available: false };
  const ch = String(provider || '')
    .trim()
    .toLowerCase();
  if (!ch) return { ok: false, available: true, error: 'missing channel' };
  ensureValidOpenClawConfig();
  const multiAccount = ch === 'whatsapp' || ch === 'telegram';
  if (multiAccount && !opts.account) opts.account = await channelsNextAccountId(ch);
  if (ch === 'whatsapp') return channelsEnsureWhatsApp(opts);
  const args = ['channels', 'add', '--channel', ch];
  if (opts.token) args.push('--token', String(opts.token));
  if (opts.botToken) args.push('--bot-token', String(opts.botToken));
  if (opts.appToken) args.push('--app-token', String(opts.appToken));
  if (opts.name) args.push('--name', String(opts.name));
  if (opts.account) args.push('--account', normalizeAccountId(opts.account));
  const r = await exec(args, { timeoutMs: 30000 });
  invalidate();
  return {
    ok: r.ok,
    available: true,
    account: normalizeAccountId(opts.account),
    error: r.ok ? undefined : (r.stderr || r.error || '').slice(0, 300),
  };
}

async function gatewayCall(method, params = {}, { timeoutMs = 30000 } = {}) {
  if (!(await isAvailable())) return { ok: false, available: false };
  const args = ['gateway', 'call', method, '--json', '--timeout', String(timeoutMs)];
  const token = getGatewayToken();
  if (token) args.push('--token', token);
  if (params && Object.keys(params).length) args.push('--params', JSON.stringify(params));
  const r = await exec(args, { timeoutMs: timeoutMs + 10000 });
  const data = parseLooseJson(r.stdout || '');
  if (data && typeof data === 'object') {
    return { ok: r.ok || !data.error, available: true, ...data };
  }
  const err = (r.stderr || r.error || '').trim();
  return { ok: false, available: true, error: err.slice(0, 400) || 'gateway call failed' };
}

async function channelsEnsureWhatsApp(opts = {}) {
  if (!(await isAvailable())) return { ok: false, available: false };
  ensureValidOpenClawConfig();
  const accountId = normalizeAccountId(opts.account);
  const args = ['channels', 'add', '--channel', 'whatsapp', '--account', accountId];
  if (opts.name) args.push('--name', String(opts.name));
  const r = await exec(args, { timeoutMs: 30000 });
  invalidate();
  return {
    ok: r.ok,
    available: true,
    account: accountId,
    error: r.ok ? undefined : (r.stderr || r.error || '').slice(0, 300),
  };
}

async function whatsappLogout({ accountId = 'default' } = {}) {
  if (!(await isAvailable())) return { ok: false, available: false };
  const account = normalizeAccountId(accountId);
  const r = await exec(['channels', 'logout', '--channel', 'whatsapp', '--account', account], { timeoutMs: 30000 });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
  const cleared = /cleared whatsapp/i.test(out);
  const removedCreds = removeWhatsAppCredentials(account);
  const removedConfig = removeChannelConfigAccount('whatsapp', account);
  invalidate();
  if (cleared || r.ok || removedCreds || removedConfig) {
    try {
      await gatewayRestart();
    } catch {
      /* best-effort: config/credentials are already removed */
    }
    return {
      ok: true,
      available: true,
      account,
      cleared: cleared || removedCreds,
      removedConfig,
      message: out.slice(-200),
    };
  }
  try {
    const wa = require('./whatsapp-login');
    await wa.logout({ accountId: account });
    removeWhatsAppCredentials(account);
    removeChannelConfigAccount('whatsapp', account);
    invalidate();
    await gatewayRestart().catch(() => {});
    return { ok: true, available: true, account, cleared: true, removedConfig: true };
  } catch (e) {
    return { ok: false, available: true, account, error: (r.stderr || r.error || e.message || '').slice(0, 300) };
  }
}

async function getWhatsAppChannelStatusBlob() {
  try {
    const r = await exec(['channels', 'status'], { timeoutMs: 12000 });
    return `${r.stdout || ''} ${r.stderr || ''}`;
  } catch {
    return '';
  }
}

async function whatsappSessionInvalid(accountId = 'default') {
  return whatsappSessionInvalidFromBlob(await getWhatsAppChannelStatusBlob(), accountId);
}

async function whatsappDisconnectedButConfigured(accountId = 'default') {
  const account = normalizeAccountId(accountId);
  if (!isWhatsAppLinked(account)) return false;
  const blob = await getWhatsAppChannelStatusBlob();
  if (whatsappSessionInvalidFromBlob(blob, account)) return false;
  const line = accountStatusLineFromBlob(blob, 'whatsapp', account);
  if (/not linked/i.test(line)) return false;
  return !!line && /disconnected/i.test(line);
}

async function whatsappLoginStart({ accountId = 'default', name, force = false, timeoutMs = 45000 } = {}) {
  const account = normalizeAccountId(accountId);
  logAction(`whatsapp login/start account=${account} force=${force}`);
  if (!(await isAvailable())) return { ok: false, available: false };
  await channelsEnsureWhatsApp({ account, name });
  if ((isWhatsAppLinked(account) || (await whatsappChannelLive(account))) && !force && !(await whatsappSessionInvalid(account))) {
    const st = await whatsappLinkStatus({ accountId: account });
    await finalizeWhatsAppInstructionMode(account, { phone: st.phone || undefined });
    return {
      ok: true,
      available: true,
      account,
      alreadyLinked: true,
      instructionMode: true,
      message: `WhatsApp (${account}) is already linked on this machine.`,
    };
  }
  if (!force && (await whatsappSessionInvalid(account))) {
    logAction(`whatsapp session invalid (401) account=${account} — clearing for new QR`);
    await whatsappLogout({ accountId: account });
    await new Promise((res) => setTimeout(res, 1200));
    force = true;
  }
  if (!force && (await whatsappDisconnectedButConfigured(account))) {
    return {
      ok: false,
      available: true,
      account,
      needsGatewayRestart: true,
      error: `WhatsApp (${account}) is linked but disconnected. Click Gateway Restart, wait ~10s, then try Show QR again (no relink needed).`,
    };
  }
  const needsClear = !!force;
  if (needsClear) {
    await whatsappLogout({ accountId: account });
    await new Promise((res) => setTimeout(res, 1200));
  }
  const probe = await gatewayProbeReliable({ attempts: 3 });
  if (!probe.running) {
    await gatewayStart();
    const retry = await waitForGatewayProbe({ attempts: 12, delayMs: 2000 });
    if (!retry.running) {
      return {
        ok: false,
        available: true,
        account,
        error: 'Connection engine not ready yet. Wait a moment and try again.',
        needsGateway: true,
        gatewayError: retry.error,
      };
    }
  } else if (needsClear) {
    logAction(`whatsapp gateway restart before fresh QR account=${account}`);
    await gatewayRestart({ fullReset: true });
    await waitForGatewayProbe({ attempts: 12, delayMs: 2000 });
  }
  const wa = require('./whatsapp-login');
  const via = await wa.start({ force: needsClear, timeoutMs, accountId: account });
  if (via.qrDataUrl) {
    logAction(`whatsapp QR ready account=${account} (embedded login)`);
    return { ok: true, available: true, account, ...via };
  }
  if (via.message && /already linked/i.test(via.message)) {
    return { ok: true, available: true, account, alreadyLinked: true, ...via };
  }
  return { ok: false, available: true, account, error: via.error || via.message || 'Could not get QR' };
}

const whatsappWaitChains = new Map();

function whatsappWaitChainFor(accountId = 'default') {
  const id = normalizeAccountId(accountId);
  if (!whatsappWaitChains.has(id)) whatsappWaitChains.set(id, Promise.resolve());
  return whatsappWaitChains.get(id);
}

function setWhatsAppWaitChain(accountId, promise) {
  whatsappWaitChains.set(normalizeAccountId(accountId), promise.catch(() => {}));
}

async function recoverWhatsAppAfterScan({ accountId = 'default', maxMs = 120000 } = {}) {
  const account = normalizeAccountId(accountId);
  logAction(`whatsapp post-scan recovery account=${account}`, `maxMs=${maxMs}`);
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (isWhatsAppLinked(account)) {
      logAction(`whatsapp linked on disk account=${account}`);
      return { connected: true, message: 'WhatsApp linked after pairing.' };
    }
    if (isIncompleteWhatsAppCreds(account)) {
      logAction(`whatsapp creds saved account=${account} — waiting for 515`);
    }
    try {
      const r = await exec(['channels', 'status'], { timeoutMs: 15000 });
      const blob = `${r.stdout || ''} ${r.stderr || ''}`;
      if (isWhatsAppChannelRunningFromStatus(blob, account)) {
        logAction(`whatsapp channel status live account=${account}`);
        return { connected: true, message: 'WhatsApp channel is live.' };
      }
      const line = accountStatusLineFromBlob(blob, 'whatsapp', account);
      if (line && /linked/i.test(line) && /running/i.test(line) && !/not linked/i.test(line)) {
        await new Promise((res) => setTimeout(res, 5000));
        if (isWhatsAppLinked(account)) {
          logAction(`whatsapp registered after linked+running account=${account}`);
          return { connected: true, message: 'WhatsApp linked after pairing.' };
        }
      }
    } catch {
      /* keep polling */
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  if (isWhatsAppLinked(account)) {
    return { connected: true, message: 'WhatsApp linked after pairing.' };
  }
  return {
    connected: false,
    message: isIncompleteWhatsAppCreds(account)
      ? 'Pairing started but did not finish. Tap Gateway Restart, then Retry QR.'
      : 'Pairing did not complete. Tap Retry QR.',
  };
}

function normalizeWhatsAppWaitResult(result = {}, accountId = 'default') {
  const account = normalizeAccountId(accountId);
  const message = String(result.message || result.error || '');
  if (/515|restart required/i.test(message)) {
    return {
      ...result,
      account,
      ok: true,
      connected: false,
      restarting: true,
      message: 'Phone linked — finishing connection (515 restart)…',
    };
  }
  if (/login ended without|still waiting for the qr scan/i.test(message)) {
    return {
      ...result,
      account,
      ok: true,
      connected: false,
      restarting: true,
      message: 'Scan received — finishing connection, please wait…',
    };
  }
  if (/linked|ready|finishing connection/i.test(message) && !/not linked|failed/i.test(message)) {
    return { ...result, account, ok: true, connected: result.connected !== false ? true : !!result.connected, message };
  }
  if (/still waiting|finishing connection/i.test(message)) {
    return { ...result, account, ok: true, connected: false, restarting: true, message: 'Phone linked — finishing connection (please wait)…' };
  }
  if (/login failed/i.test(message)) {
    if (isIncompleteWhatsAppCreds(account)) {
      return {
        ...result,
        account,
        ok: true,
        connected: false,
        restarting: true,
        message: 'Pairing in progress after scan — waiting for restart…',
      };
    }
    return {
      ...result,
      account,
      ok: true,
      connected: false,
      needsNewQr: true,
      message: 'Pairing was interrupted. Generating a fresh QR…',
    };
  }
  return { ok: true, available: true, account, ...result };
}

async function whatsappLoginWait({ accountId = 'default', name, timeoutMs = 180000 } = {}) {
  const account = normalizeAccountId(accountId);
  logAction(`whatsapp login/wait account=${account} timeoutMs=${timeoutMs}`);
  if (!(await isAvailable())) return { ok: false, available: false };
  const run = async () => {
    const probe = await gatewayProbe();
    if (!probe.running) {
      return { ok: false, available: true, account, error: 'Gateway went offline during login. Click Start and retry.', needsGateway: true };
    }
    try {
      const waitMs = Math.max(timeoutMs, 180000);
      const wa = require('./whatsapp-login');
      const r = await wa.wait({ timeoutMs: waitMs, accountId: account });
      let normalized = normalizeWhatsAppWaitResult({ available: true, ...r }, account);
      if (!normalized.connected && (normalized.restarting || isIncompleteWhatsAppCreds(account) || /515/.test(r.message || ''))) {
        logAction(`whatsapp 515 account=${account} — finishing via CLI-style reconnect`);
        const fin = await wa.finishAfter515({ timeoutMs: 120000, accountId: account });
        if (fin.connected) normalized = { ...normalized, ...fin, connected: true };
        else if (!normalized.message) normalized.message = fin.message;
      }
      if (!normalized.connected) {
        const recovered = await recoverWhatsAppAfterScan({ accountId: account, maxMs: 60000 });
        if (recovered.connected) normalized = { ...normalized, ...recovered, connected: true };
        else if (!normalized.message) normalized.message = recovered.message;
      }
      if (!normalized.connected && (isWhatsAppLinked(account) || (await whatsappChannelLive(account))))
        normalized.connected = true;
      if (normalized.connected) {
        logAction(`whatsapp linked OK account=${account} — finalizing channel`);
        await channelsEnsureWhatsApp({ account, name });
        const st = await whatsappLinkStatus({ accountId: account });
        await finalizeWhatsAppInstructionMode(account, { phone: st.phone || undefined });
        const probe = await gatewayProbe();
        if (!probe.running) {
          logAction(`whatsapp gateway offline account=${account} — starting gateway`);
          await gatewayStart();
          await waitForGatewayProbe({ attempts: 15, delayMs: 2000 });
        } else {
          logAction(`whatsapp linked account=${account} — keeping gateway running`);
        }
        normalized.message = normalized.message || 'WhatsApp linked successfully.';
      }
      return normalized;
    } catch (e) {
      if (isWhatsAppLinked(account) || (await whatsappChannelLive(account))) {
        await channelsEnsureWhatsApp({ account, name });
        return { ok: true, available: true, account, connected: true, message: 'WhatsApp linked successfully.' };
      }
      return { ok: false, available: true, account, error: e.message, needsNewQr: !isIncompleteWhatsAppCreds(account) };
    }
  };
  const chain = whatsappWaitChainFor(account);
  const result = chain.then(run, run);
  setWhatsAppWaitChain(account, result);
  return result;
}

async function channelsRemove(provider, account = 'default') {
  if (!(await isAvailable())) return { ok: false, available: false };
  const ch = String(provider || '')
    .trim()
    .toLowerCase();
  if (!ch) return { ok: false, available: true, error: 'missing channel' };
  const accountId = normalizeAccountId(account);
  if (ch === 'whatsapp') {
    const loggedOut = await whatsappLogout({ accountId });
    const args = ['channels', 'remove', '--channel', ch, '--account', accountId, '--delete'];
    const r = await exec(args, { timeoutMs: 30000 });
    const removedConfig = removeChannelConfigAccount(ch, accountId);
    const removedCreds = removeWhatsAppCredentials(accountId);
    invalidate();
    await gatewayRestart().catch(() => {});
    return {
      ok: !!(loggedOut.ok || r.ok || removedConfig || removedCreds),
      available: true,
      removed: !!(loggedOut.ok || r.ok || removedConfig || removedCreds),
      account: accountId,
      loggedOut,
      removedConfig,
      removedCreds,
      error:
        loggedOut.ok || r.ok || removedConfig || removedCreds
          ? undefined
          : (r.stderr || r.error || loggedOut.error || '').slice(0, 300),
    };
  }
  const args = ['channels', 'remove', '--channel', ch, '--account', accountId];
  const r = await exec(args, { timeoutMs: 30000 });
  invalidate();
  return {
    ok: r.ok,
    available: true,
    removed: r.ok,
    account: accountId,
    error: r.ok ? undefined : (r.stderr || r.error || '').slice(0, 300),
  };
}

// Run one task through OpenClaw and return its plain-text result. The runtime
// adapter (server/runtime/openclaw.js) calls this; users only see the text.
// Pull a JSON object out of mixed stdout (OpenClaw prints log lines before the
// JSON payload). Returns null when nothing parses.
function parseLooseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    /* try to slice the object out */
  }
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try {
      return JSON.parse(s.slice(i, j + 1));
    } catch {
      /* give up */
    }
  }
  return null;
}

// Run one agent turn. This OpenClaw build needs a session selector (`--agent`)
// and exposes `openclaw agent -m <text> --json [--local]` (no `--thinking`).
// The reply text lives in payloads[0].text; isError flags a failed turn (e.g.
// a bad API key returns 401 here, which we surface instead of treating as output).
async function runAgent(message, { local, agentId: agentIdOverride } = {}) {
  if (!(await isAvailable())) return { ok: false, available: false };
  const settings = store.readSettings().runtimes?.openclaw || {};
  const agentId = agentIdOverride || settings.agentId || 'main';
  const useLocal = local ?? settings.local;
  // Flags before --message: a long multi-line message arg can otherwise swallow
  // trailing flags on Windows cmd.exe, dropping --local (which forces embedded).
  const args = ['agent', '--agent', agentId, '--json'];
  if (useLocal) args.push('--local');
  args.push('--message', String(message || ''));
  const r = await exec(args, { timeoutMs: 120000 });

  const data = parseLooseJson(r.stdout || '');
  // Strip OpenClaw's own log lines (e.g. "[agents/tool-images] ...", "[tools] ...")
  // so they don't leak into the reply or trip the auth-error heuristic below.
  const cleanStdout = String(r.stdout || '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*\[[a-z][\w/.\- ]*\]/i.test(l))
    .join('\n')
    .trim();
  const text = data
    ? data.payloads?.[0]?.text || data.text || data.result || data.message || data.reply || ''
    : cleanStdout;
  // Detect a real auth failure without false-matching log noise such as "401.4KB".
  const authBlob = `${cleanStdout}\n${r.stderr || ''}`;
  const authFail =
    /incorrect api key|invalid api key|invalid_api_key|\bunauthorized\b|\b401\b(?!\s*[.,\d])/i.test(authBlob);
  const isError = data?.isError || data?.meta?.isError || authFail;
  const meta = data?.meta?.agentMeta || {};

  if (!r.ok && !text) {
    noteRun({ ok: false, error: r.stderr || r.error });
    noteUsage({ ok: false, model: meta.model, lastCallUsage: meta.lastCallUsage });
    return { ok: false, available: true, error: r.stderr || r.error };
  }
  if (isError) {
    const error = text || r.stderr || 'agent error';
    noteRun({ ok: false, error });
    noteUsage({ ok: false, model: meta.model, lastCallUsage: meta.lastCallUsage });
    return { ok: false, available: true, error };
  }
  noteRun({ ok: true });
  noteUsage({ ok: true, model: meta.model, lastCallUsage: meta.lastCallUsage });
  return { ok: true, available: true, text: String(text).trim() };
}

// One tiny real turn to confirm the configured key actually authenticates.
// Called right after a key is saved (deliberate action), so the small token
// cost is acceptable; an invalid key returns 401 and costs nothing.
async function verifyKey() {
  const r = await runAgent('Reply with the single word: ok. Do not use any tools.', { local: true });
  if (r.ok) return { ok: true, available: true };
  return { ok: false, available: !!r.available, authError: getHealth().authError, error: r.error };
}

function resolveAgentWorkspace(agentId) {
  const id = String(agentId || '').trim();
  if (!id) return null;
  try {
    const cfg = readJsonFile(configPath());
    const list = cfg?.agents?.list;
    if (Array.isArray(list)) {
      const hit = list.find((a) => a && (a.id === id || a.agentId === id));
      const ws = hit?.workspace || hit?.workspaceDir;
      if (ws && fs.existsSync(ws)) return ws;
    }
    const slug = id.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
    const guess = path.join(os.homedir(), '.openclaw', 'workspaces', slug);
    if (fs.existsSync(guess)) return guess;
  } catch {
    /* ignore */
  }
  return null;
}

function readAgentWorkspaceFile(agentId, fileName) {
  const ws = resolveAgentWorkspace(agentId);
  if (!ws) return { ok: false, error: 'workspace not found' };
  const p = path.join(ws, String(fileName || '').trim());
  try {
    if (!fs.existsSync(p)) return { ok: true, content: '', missing: true, path: p };
    const content = fs.readFileSync(p, 'utf8');
    return { ok: true, content, missing: false, path: p };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function soulPreviewFromContent(content, maxLen = 400) {
  const raw = String(content || '')
    .replace(/^#+\s+/gm, '')
    .replace(/\r/g, '')
    .trim();
  if (!raw) return '';
  const para = raw.split(/\n\n+/).find((p) => p.trim().length > 0) || raw;
  const flat = para.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLen) return flat;
  return `${flat.slice(0, maxLen - 1).trim()}…`;
}

function parseAgentModelRef(agentEntry) {
  if (!agentEntry || typeof agentEntry !== 'object') return '';
  const model = agentEntry.model;
  if (typeof model === 'string' && model.trim()) return model.trim();
  if (model && typeof model === 'object') {
    const primary = model.primary;
    if (typeof primary === 'string' && primary.trim()) return primary.trim();
    if (primary && typeof primary === 'object' && typeof primary.ref === 'string') {
      return primary.ref.trim();
    }
  }
  return '';
}

async function getAgentModelRef(agentId) {
  const id = String(agentId || '').trim();
  if (!id) return { ok: false, modelRef: '' };
  const { available, config } = await getConfig();
  if (!available || !config) return { ok: false, modelRef: '' };
  const list = config?.agents?.list;
  if (Array.isArray(list)) {
    const hit = list.find((a) => a && (a.id === id || a.agentId === id));
    if (hit) return { ok: true, modelRef: parseAgentModelRef(hit) };
  }
  try {
    const st = await modelsStatus();
    const fallback = st.status?.resolvedDefault || st.status?.defaultModel || '';
    return { ok: true, modelRef: fallback };
  } catch {
    return { ok: true, modelRef: '' };
  }
}

async function setAgentModelRef(agentId, modelRef) {
  const id = String(agentId || '').trim();
  const ref = String(modelRef || '').trim();
  if (!id) return { ok: false, error: 'missing agentId' };
  if (!(await isAvailable())) return { ok: false, available: false };
  const { config } = await getConfig();
  const list = Array.isArray(config?.agents?.list) ? [...config.agents.list] : [];
  const idx = list.findIndex((a) => a && (a.id === id || a.agentId === id));
  const patch = { model: ref ? { primary: ref } : null };
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...patch };
  } else {
    list.push({ id, ...patch });
  }
  const r = await setConfig('agents.list', list);
  return { ok: r.ok, available: true, error: r.error };
}

module.exports = {
  configPath,
  isAvailable,
  invalidate,
  getHealth,
  getUsage,
  listModels,
  agentsAdd,
  agentsList,
  agentsDelete,
  verifyKey,
  getConfig,
  setConfig,
  listAgents,
  setKey,
  deleteKey,
  setModel,
  modelsStatus,
  gatewayStatus,
  gatewayProbe,
  gatewayStart,
  gatewayStop,
  gatewayRestart,
  cronList,
  cronAdd,
  cronRemove,
  cronSetEnabled,
  cronRun,
  formatSchedule,
  listSessions,
  skillsSearch,
  skillsList,
  skillInfo,
  channelsList,
  channelsStatus,
  channelsAdd,
  channelsRemove,
  channelsNextAccountId,
  channelsRename,
  formatWhatsAppPhone,
  ensureValidOpenClawConfig,
  channelsEnsureWhatsApp,
  whatsappLoginStart,
  whatsappLoginWait,
  whatsappLogout,
  whatsappLinkStatus,
  whatsappLinkStatuses,
  normalizeAccountId,
  gatewayCall,
  runAgent,
  readAgentWorkspaceFile,
  soulPreviewFromContent,
  getAgentModelRef,
  setAgentModelRef,
  resolveAgentWorkspace,
  finalizeWhatsAppInstructionMode,
  applyWhatsAppInstructionMode: channelInstruction.applyWhatsAppInstructionMode,
};
