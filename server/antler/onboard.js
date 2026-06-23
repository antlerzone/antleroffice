// First-run onboarding: detect OpenClaw (execution) and one-click install if missing.

const { spawnCmd } = require('./spawn-util');
const store = require('./store');
const oc = require('./openclaw-config');
const defaultMcpPack = require('./default-mcp-pack');

let mcpAutoApplyStarted = false;

// Rolling log buffer + current install state (polled by the UI).
const logBuf = [];
let installing = null; // name currently installing, or null
const installQueue = [];

function isInstalling(name) {
  return installing === name;
}

function log(line) {
  const entry = `${new Date().toLocaleTimeString()}  ${line}`;
  logBuf.push(entry);
  if (logBuf.length > 400) logBuf.shift();
}

function runtimeCmd(name) {
  const rt = store.readSettings().runtimes?.[name] || {};
  return (rt.cmd || name).trim() || name;
}

function devCmd(name, fallback) {
  const dev = store.readSettings().dev || {};
  if (name === 'cursor') return String(dev.cursorCommand || fallback || 'cursor-agent').trim();
  if (name === 'codex') return String(dev.codexCommand || fallback || 'codex').trim();
  if (name === 'claude') return String(dev.claudeCommand || fallback || 'claude').trim();
  return fallback || name;
}

// Probe a runtime's `--version`. Returns { installed, version }.
function probe(name) {
  const cmd = runtimeCmd(name);
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (installed) => {
      if (done) return;
      done = true;
      resolve({ installed, version: installed ? out.trim().split('\n')[0] : '' });
    };
    let child;
    try {
      child = spawnCmd(cmd, ['--version']);
    } catch {
      return finish(false);
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(false);
    }, 6000);
    child.stdout?.on('data', (d) => (out += d.toString()));
    child.stderr?.on('data', (d) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0 || /\d+\.\d+/.test(out));
    });
  });
}

async function detect() {
  const openclaw = await probe('openclaw');
  const cursor = await probe(devCmd('cursor', 'cursor-agent'));
  const codex = await probe(devCmd('codex', 'codex'));
  const claude = await probe(devCmd('claude', 'claude'));
  return { openclaw, cursor, codex, claude };
}

// Install command per runtime. OpenClaw is npm-based and cross-platform.
function installSpec(name) {
  if (name === 'openclaw') {
    return { cmd: 'npm', args: ['install', '-g', 'openclaw@latest'] };
  }
  if (name === 'codex') {
    if (process.platform === 'win32') {
      return {
        cmd: 'powershell.exe',
        args: [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          'irm https://chatgpt.com/codex/install.ps1 | iex',
        ],
      };
    }
    return {
      cmd: process.platform === 'win32' ? 'sh' : 'bash',
      args: ['-c', 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'],
    };
  }
  if (name === 'cursor') {
    if (process.platform === 'win32') {
      return {
        cmd: 'powershell.exe',
        args: [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          "irm 'https://cursor.com/install?win32=true' | iex",
        ],
      };
    }
    return {
      cmd: 'bash',
      args: ['-c', 'curl https://cursor.com/install -fsS | bash'],
    };
  }
  if (name === 'claude') {
    return { cmd: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code@latest'] };
  }
  return null;
}

// Spawn the installer and stream output into the log buffer. Returns immediately;
// the UI polls getLog() for progress.
function runInstallJob(name, cmd, args, { onDone } = {}) {
  if (installing) {
    installQueue.push({ name, cmd, args, onDone });
    return { ok: true, queued: true };
  }
  installing = name;
  log(`Installing ${name} (${cmd} ${args.join(' ')})…`);
  let child;
  try {
    child = spawnCmd(cmd, args);
  } catch (e) {
    installing = null;
    log(`Failed to start installer: ${e.message}`);
    drainInstallQueue();
    return { ok: false, error: e.message };
  }
  child.stdout?.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(log));
  child.stderr?.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(log));
  child.on('error', (err) => {
    log(`Installer error: ${err.message}`);
    installing = null;
    drainInstallQueue();
  });
  child.on('close', (code) => {
    log(`${name} install ${code === 0 ? 'completed ✓' : `exited with code ${code}`}.`);
    installing = null;
    oc.invalidate();
    if (typeof onDone === 'function') {
      try {
        onDone(code);
      } catch {
        /* ignore */
      }
    }
    drainInstallQueue();
  });
  return { ok: true };
}

function drainInstallQueue() {
  if (installing || !installQueue.length) return;
  const next = installQueue.shift();
  if (next) runInstallJob(next.name, next.cmd, next.args, { onDone: next.onDone });
}

function startInstall(name, cmd, args, opts) {
  return runInstallJob(name, cmd, args, opts);
}

function install(name) {
  const spec = installSpec(name);
  if (!spec) return { ok: false, error: `unknown runtime: ${name}` };
  const onDone =
    name === 'codex'
      ? (code) => {
          if (code === 0) {
            try {
              const codexCli = require('./runtime/codex-cli');
              codexCli.probe().catch(() => {});
            } catch {
              /* ignore */
            }
          }
        }
      : name === 'cursor'
        ? (code) => {
            if (code === 0) {
              try {
                const cursorCli = require('./runtime/cursor-cli');
                cursorCli.patchCursorWindowsLaunchers();
                cursorCli.probe().catch(() => {});
              } catch {
                /* ignore */
              }
            }
          }
        : name === 'claude'
          ? (code) => {
              if (code === 0) {
                try {
                  const claudeCli = require('./runtime/claude-cli');
                  claudeCli.probe().catch(() => {});
                } catch {
                  /* ignore */
                }
              }
            }
          : undefined;
  return runInstallJob(name, spec.cmd, spec.args, { onDone });
}

function getLog() {
  return { installing, lines: logBuf.slice(-200) };
}

// Save the OpenAI (or other provider) key into OpenClaw's own config, and set a
// default model so OpenClaw can run. Falls back to storing in AntlerOffice
// settings (env-injected at spawn) when OpenClaw isn't installed yet.
async function setOpenClawKey({ provider = 'openai', apiKey = '', model = '' } = {}) {
  if (!apiKey) return { ok: false, error: 'missing apiKey' };
  const available = await oc.isAvailable();
  if (available) {
    const k = await oc.setKey(provider, apiKey);
    if (model) await oc.setModel(model.includes('/') ? model : `${provider}/${model}`);
    if (!k.ok) {
      log(`Could not save ${provider} key: ${k.error || 'unknown error'}.`);
      return { ok: false, available: true, error: k.error };
    }
    log(`Saved ${provider} key into OpenClaw${model ? ` + model ${model}` : ''}. Verifying…`);
    const v = await oc.verifyKey();
    if (v.ok) {
      log(`✓ Key works — OpenClaw can run tasks now.`);
      markAiConfigured();
      return { ok: true, available: true, verified: true };
    }
    log(v.authError ? `✗ Key rejected (looks invalid). Double-check and paste again.` : `Saved, but a test run failed: ${v.error || 'unknown'}.`);
    markAiConfigured();
    return { ok: true, available: true, verified: false, authError: !!v.authError, error: v.error };
  }
  // Persist into AntlerOffice settings so it's used as env/demo until install.
  const s = store.readSettings();
  s.providers[provider] = { ...(s.providers[provider] || {}), apiKey, ...(model ? { model } : {}) };
  store.writeSettings(s);
  markAiConfigured();
  log(`OpenClaw not installed yet — saved ${provider} key in AntlerOffice settings for now.`);
  return { ok: true, available: false };
}

async function hasAnyAiKey() {
  if (await oc.isAvailable()) {
    const ms = await oc.modelsStatus();
    const providers = ms.status?.auth?.providers || [];
    return providers.some((p) => (p.profiles?.labels || []).length > 0);
  }
  const s = store.readSettings();
  return Object.values(s.providers || {}).some((p) => String(p?.apiKey || '').trim());
}

function readOnboarding() {
  return store.readSettings().onboarding || {};
}

function writeOnboarding(patch) {
  const s = store.readSettings();
  s.onboarding = { ...(s.onboarding || {}), ...patch };
  store.writeSettings(s);
  return s.onboarding;
}

function markAiConfigured() {
  return writeOnboarding({ aiConfigured: true, aiSkipped: false });
}

function markAiSkipped() {
  return writeOnboarding({ aiSkipped: true });
}

async function markInstallerComplete() {
  const onboarding = writeOnboarding({ installerComplete: true });
  let mcp = { applied: false };
  try {
    mcp = await ensureMcpPackFromInstaller();
  } catch {
    /* non-fatal — installer step still marked complete */
  }
  return { ok: true, onboarding, mcp };
}

async function ensureMcpPackFromInstaller() {
  const pack = readPackSettingsSafe();
  if (pack.enabled) return { applied: false, reason: 'already-enabled' };
  const runtimes = await detect();
  if (!runtimes.openclaw?.installed) return { applied: false, reason: 'openclaw-missing' };
  const result = await defaultMcpPack.applyDefaultMcpPack({
    enableCoo: true,
    enableAdmin: true,
    enableIt: true,
    installPlaywright: true,
  });
  writeOnboarding({ stackReady: true, installerComplete: true });
  return { applied: true, result };
}

function readPackSettingsSafe() {
  const s = store.readSettings();
  return s.defaultMcpPack || { enabled: false };
}

function scheduleMcpAutoApply() {
  if (mcpAutoApplyStarted) return;
  mcpAutoApplyStarted = true;
  void ensureMcpPackFromInstaller().catch(() => {});
}

async function getAppState() {
  scheduleMcpAutoApply();
  const [runtimes, packStatus, hasKey] = await Promise.all([
    detect(),
    defaultMcpPack.getStatus(),
    hasAnyAiKey(),
  ]);
  const s = store.readSettings();
  const onboarding = s.onboarding || {};
  const companyProfile = s.companyProfile || {};
  const openclawReady = !!runtimes.openclaw?.installed;
  const cursorReady = !!runtimes.cursor?.installed;
  const codexReady = !!runtimes.codex?.installed;
  const claudeReady = !!runtimes.claude?.installed;
  const mcpReady = !!packStatus.pack?.enabled;
  const stackReady = openclawReady && mcpReady;
  const aiConfigured = !!onboarding.aiConfigured || hasKey;
  const aiSkipped = !!onboarding.aiSkipped;
  const needsAiSetup = !aiConfigured && !aiSkipped;
  let companySetupDone = !!onboarding.companySetupDone;
  // Legacy installs: AI was configured before company-profile wizard shipped.
  if (!companySetupDone && aiConfigured) {
    writeOnboarding({ companySetupDone: true });
    companySetupDone = true;
  }
  const needsCompanySetup = !companySetupDone;

  if (stackReady && !onboarding.stackReady) {
    writeOnboarding({ stackReady: true });
  }
  if (hasKey && !onboarding.aiConfigured) {
    writeOnboarding({ aiConfigured: true });
  }

  return {
    ok: true,
    runtimes,
    stackReady,
    openclawReady,
    cursorReady,
    codexReady,
    claudeReady,
    mcpReady,
    aiConfigured,
    aiSkipped,
    needsAiSetup,
    companySetupDone,
    needsCompanySetup,
    companyProfile,
    // Show full wizard if company not set up yet, or AI not configured
    showSetupWizard: needsCompanySetup || needsAiSetup,
    defaultMcpPack: packStatus.pack,
  };
}

function saveCompanyProfile(profile = {}) {
  const allowed = ['companyName', 'industry', 'size', 'goals', 'bossStyle', 'desktopName', 'language', 'shareInstallData'];
  const clean = {};
  for (const key of allowed) {
    if (profile[key] !== undefined) clean[key] = profile[key];
  }
  // Persist profile
  const s = store.readSettings();
  s.companyProfile = { ...(s.companyProfile || {}), ...clean };
  // Also persist desktopName into office settings
  if (clean.desktopName) {
    s.    s.office = s.office || {};
    s.office.desktopDisplayName = clean.desktopName;
  }
  s.onboarding = { ...(s.onboarding || {}), companySetupDone: true };
  store.writeSettings(s);
  return { ok: true, companyProfile: s.companyProfile };
}

module.exports = {
  detect,
  install,
  startInstall,
  isInstalling,
  getLog,
  setOpenClawKey,
  getAppState,
  hasAnyAiKey,
  markAiConfigured,
  markAiSkipped,
  markInstallerComplete,
  ensureMcpPackFromInstaller,
  saveCompanyProfile,
};
