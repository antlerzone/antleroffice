// Cursor CLI (cursor-agent) — local headless code execution.

const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('../store');
const { runCli, probeCli } = require('./cli-runner');

const FALLBACK_COMMANDS = ['cursor-agent', 'agent'];
const WIN_LAUNCHER_REGEX_OLD = "$name -match '^\\d{4}\\.\\d{1,2}\\.\\d{1,2}-[a-f0-9]+$'";
const WIN_LAUNCHER_REGEX_NEW = "$name -match '^\\d{4}\\.\\d{1,2}\\.\\d{1,2}-.+$'";

function devSettings() {
  return store.readSettings().dev || {};
}

function cursorCommand() {
  const cmd = String(devSettings().cursorCommand || '').trim();
  return cmd || 'cursor-agent';
}

function cursorAgentDir() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'cursor-agent');
}

function versionSortKey(name) {
  const datePart = String(name).split('-')[0];
  const parts = datePart.split('.');
  if (parts.length !== 3) return '';
  return parts.map((p) => p.padStart(2, '0')).join('');
}

function resolveLatestVersionBundle() {
  const versionsDir = path.join(cursorAgentDir(), 'versions');
  if (!fs.existsSync(versionsDir)) return null;
  const dirs = fs
    .readdirSync(versionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}\.\d{1,2}\.\d{1,2}-/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => versionSortKey(b).localeCompare(versionSortKey(a)));
  for (const name of dirs) {
    const versionDir = path.join(versionsDir, name);
    const node = path.join(versionDir, 'node.exe');
    const indexJs = path.join(versionDir, 'index.js');
    if (fs.existsSync(node) && fs.existsSync(indexJs)) {
      return { versionDir, node, indexJs };
    }
  }
  return null;
}

function resolveDirectBundle() {
  const saved = String(devSettings().cursorVersionDir || '').trim();
  if (saved) {
    const node = path.join(saved, 'node.exe');
    const indexJs = path.join(saved, 'index.js');
    if (fs.existsSync(node) && fs.existsSync(indexJs)) {
      return { versionDir: saved, node, indexJs };
    }
  }
  return resolveLatestVersionBundle();
}

function persistCursorBundle(bundle) {
  const s = store.readSettings();
  const next = {
    ...s,
    dev: {
      ...s.dev,
      cursorVersionDir: bundle.versionDir,
      cursorCommand: bundle.node,
    },
  };
  if (s.dev?.cursorVersionDir === next.dev.cursorVersionDir && s.dev?.cursorCommand === next.dev.cursorCommand) {
    return;
  }
  store.writeSettings(next);
}

function persistCursorCommandOnly(cmd) {
  const s = store.readSettings();
  if (s.dev?.cursorCommand === cmd) return;
  store.writeSettings({ ...s, dev: { ...s.dev, cursorCommand: cmd } });
}

function patchCursorWindowsLaunchers() {
  if (process.platform !== 'win32') return false;
  let patched = false;
  for (const file of ['agent.ps1', 'cursor-agent.ps1']) {
    const target = path.join(cursorAgentDir(), file);
    if (!fs.existsSync(target)) continue;
    const text = fs.readFileSync(target, 'utf8');
    if (!text.includes(WIN_LAUNCHER_REGEX_OLD)) continue;
    fs.writeFileSync(target, text.replace(WIN_LAUNCHER_REGEX_OLD, WIN_LAUNCHER_REGEX_NEW), 'utf8');
    patched = true;
  }
  return patched;
}

function cursorCandidatePaths() {
  const candidates = [];
  const configured = cursorCommand();
  if (configured && !configured.endsWith('node.exe')) candidates.push(configured);
  for (const alt of FALLBACK_COMMANDS) {
    if (!candidates.includes(alt)) candidates.push(alt);
  }
  if (process.platform === 'win32') {
    const agentDir = cursorAgentDir();
    candidates.push(path.join(agentDir, 'cursor-agent.ps1'));
    candidates.push(path.join(agentDir, 'agent.ps1'));
  } else {
    const localBin = path.join(os.homedir(), '.local', 'bin');
    candidates.push(path.join(localBin, 'cursor-agent'));
    candidates.push(path.join(localBin, 'agent'));
  }
  return [...new Set(candidates)];
}

async function probeCmd(cmd) {
  if (cmd.endsWith('.ps1')) {
    if (!fs.existsSync(cmd)) return { installed: false, version: '', raw: '' };
    return probeCli('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      cmd,
      '--version',
    ]);
  }
  if (!['cursor-agent', 'agent'].includes(cmd) && !fs.existsSync(cmd)) {
    return { installed: false, version: '', raw: '' };
  }
  return probeCli(cmd);
}

async function probeDirectBundle(bundle) {
  const r = await probeCli(bundle.node, [bundle.indexJs, '--version']);
  if (!r.installed) return null;
  persistCursorBundle(bundle);
  return { ...r, command: bundle.node, indexJs: bundle.indexJs, versionDir: bundle.versionDir };
}

async function probe() {
  patchCursorWindowsLaunchers();
  const direct = resolveDirectBundle();
  if (direct) {
    const directProbe = await probeDirectBundle(direct);
    if (directProbe) return directProbe;
  }
  for (const cmd of cursorCandidatePaths()) {
    const r = await probeCmd(cmd);
    if (r.installed) {
      persistCursorCommandOnly(cmd);
      return { ...r, command: cmd };
    }
  }
  return { installed: false, version: '', raw: '', command: cursorCommand() };
}

function cursorApiKey() {
  const fromSettings = String(devSettings().cursorApiKey || '').trim();
  if (fromSettings) return fromSettings;
  return String(process.env.CURSOR_API_KEY || '').trim();
}

function hasCursorApiKey() {
  return !!cursorApiKey();
}

function buildRunInvocation(probed, dev, prompt) {
  const args = ['--print', '--force', '--output-format', 'text'];
  const model = String(dev.cursorModel || '').trim();
  if (model) args.push('--model', model);
  args.push(String(prompt || '').trim());

  if (probed.indexJs) {
    return { runCmd: probed.command, runArgs: [probed.indexJs, ...args] };
  }
  if (probed.command.endsWith('.ps1')) {
    return {
      runCmd: 'powershell.exe',
      runArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probed.command, ...args],
    };
  }
  return { runCmd: probed.command, runArgs: args };
}

/**
 * Run Cursor agent in headless print mode.
 * @param {{ prompt: string, projectRoot: string, onChunk?: (line: string) => void }} opts
 */
async function runDev({ prompt, projectRoot, onChunk } = {}) {
  const dev = devSettings();
  const probed = await probe();
  if (!probed.installed) {
    return {
      ok: false,
      available: false,
      error: `Cursor CLI not found. Install from Settings → Dev tools, or https://cursor.com/cli`,
    };
  }
  const apiKey = cursorApiKey();
  if (!apiKey) {
    return {
      ok: false,
      available: true,
      error: 'Cursor API key not set. Add it in Settings → Dev tools (per-user, stored locally).',
    };
  }

  const timeoutMs = Number(dev.cursorTimeoutMs) || 600000;
  const env = { CURSOR_INVOKED_AS: 'cursor-agent', CURSOR_API_KEY: apiKey };

  const { runCmd, runArgs } = buildRunInvocation(probed, dev, prompt);
  const r = await runCli(runCmd, runArgs, { cwd: projectRoot, env, timeoutMs });
  const text = `${r.stdout}\n${r.stderr}`.trim();

  if (onChunk && text) {
    for (const line of text.split('\n')) onChunk(line);
  }

  if (r.timedOut) {
    return { ok: false, available: true, error: 'Cursor CLI timed out', text, provider: 'cursor-cli' };
  }
  if (!r.ok && !text) {
    return {
      ok: false,
      available: true,
      error: r.stderr || `Cursor CLI exited with code ${r.code}`,
      text: '',
      provider: 'cursor-cli',
    };
  }
  return { ok: true, available: true, text, provider: 'cursor-cli' };
}

async function runReview({ plan, diff, projectRoot, onChunk } = {}) {
  const { buildReviewPrompt } = require('./dev-review-prompt');
  const prompt = buildReviewPrompt({ plan, diff });
  return runDev({ prompt, projectRoot, onChunk });
}

module.exports = {
  probe,
  runDev,
  runReview,
  cursorCommand,
  cursorApiKey,
  hasCursorApiKey,
  hasAuth: hasCursorApiKey,
  patchCursorWindowsLaunchers,
};
