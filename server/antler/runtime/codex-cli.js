// Codex CLI — non-interactive code review (plan A: AntlerOffice spawn, not OpenClaw MCP).

const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('../store');
const { runCli, probeCli } = require('./cli-runner');

function devSettings() {
  return store.readSettings().dev || {};
}

function codexCommand() {
  return String(devSettings().codexCommand || 'codex').trim() || 'codex';
}

function codexCandidatePaths() {
  const candidates = [];
  const configured = codexCommand();
  if (configured) candidates.push(configured);

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
  } else {
    candidates.push(path.join(os.homedir(), '.local', 'bin', 'codex'));
    candidates.push('/usr/local/bin/codex');
  }
  if (configured !== 'codex') candidates.push('codex');
  return [...new Set(candidates)];
}

function persistCodexCommand(cmd) {
  const s = store.readSettings();
  if (s.dev?.codexCommand === cmd) return;
  store.writeSettings({ ...s, dev: { ...s.dev, codexCommand: cmd } });
}

function codexApiKey() {
  const fromDev = String(devSettings().codexApiKey || '').trim();
  if (fromDev) return fromDev;
  const fromProvider = String(store.readSettings().providers?.openai?.apiKey || '').trim();
  if (fromProvider) return fromProvider;
  return (
    String(process.env.CODEX_API_KEY || '').trim() ||
    String(process.env.OPENAI_API_KEY || '').trim()
  );
}

function hasCodexApiKey() {
  return !!codexApiKey();
}

function codexAuthJsonPath() {
  return path.join(os.homedir(), '.codex', 'auth.json');
}

function hasCodexCliLogin() {
  try {
    return fs.existsSync(codexAuthJsonPath()) && fs.statSync(codexAuthJsonPath()).size > 2;
  } catch {
    return false;
  }
}

async function probeLoginStatus(cmd) {
  const r = await runCli(cmd, ['login', 'status'], { timeoutMs: 10000 });
  const combined = `${r.stdout}\n${r.stderr}`.trim();
  return r.ok || /logged in|authenticated|signed in/i.test(combined);
}

async function hasCodexAuth() {
  if (hasCodexApiKey()) return true;
  if (!hasCodexCliLogin()) return false;
  const probed = await probe();
  if (!probed.installed) return hasCodexCliLogin();
  return probeLoginStatus(probed.command);
}

async function ensureCodexLogin(apiKey) {
  const key = String(apiKey || codexApiKey()).trim();
  if (!key) return { ok: false, error: 'missing api key' };
  const probed = await probe();
  if (!probed.installed) return { ok: false, error: 'Codex CLI not installed' };
  const r = await runCli(probed.command, ['login', '--with-api-key'], {
    input: `${key}\n`,
    timeoutMs: 30000,
  });
  const combined = `${r.stdout}\n${r.stderr}`.trim();
  if (r.ok || /logged in|authenticated|saved/i.test(combined)) {
    return { ok: true };
  }
  return { ok: false, error: combined || `codex login exited ${r.code}` };
}

function codexExecEnv() {
  const key = codexApiKey();
  if (!key) return {};
  return { CODEX_API_KEY: key, OPENAI_API_KEY: key };
}

async function probe() {
  for (const cmd of codexCandidatePaths()) {
    if (cmd !== 'codex' && !fs.existsSync(cmd)) continue;
    const r = await probeCli(cmd);
    if (r.installed) {
      persistCodexCommand(cmd);
      return { ...r, command: cmd };
    }
  }
  return { installed: false, version: '', raw: '', command: codexCommand() };
}

const REVIEW_TEMPLATE = `You are a strict code reviewer. Compare the implementation diff against the plan.

Reply on the FIRST line with exactly one of:
APPROVED
REVISION: <specific feedback>

Then provide a short review summary.

## Plan
{{PLAN}}

## Git diff
{{DIFF}}
`;

function buildReviewPrompt({ plan, diff }) {
  const body = REVIEW_TEMPLATE.replace('{{PLAN}}', String(plan || '(no plan)'))
    .replace('{{DIFF}}', String(diff || '(empty diff)').slice(0, 120000));
  return body;
}

/**
 * @param {{ plan: string, diff: string, projectRoot: string, onChunk?: (line: string) => void }} opts
 */
async function runReview({ plan, diff, projectRoot, onChunk } = {}) {
  const probed = await probe();
  if (!probed.installed) {
    return {
      ok: false,
      available: false,
      error: 'Codex CLI not installed. Install from Settings → Dev tools.',
    };
  }
  if (!(await hasCodexAuth())) {
    return {
      ok: false,
      available: true,
      error:
        'Codex not authenticated. Add OpenAI API key in Settings → Dev tools, or run `codex login` in terminal.',
    };
  }

  const prompt = buildReviewPrompt({ plan, diff });
  const dev = devSettings();
  const timeoutMs = Number(dev.codexTimeoutMs) || 300000;
  const cmd = probed.command;

  const r = await runCli(cmd, ['exec', prompt], {
    cwd: projectRoot,
    timeoutMs,
    env: codexExecEnv(),
  });
  const text = `${r.stdout}\n${r.stderr}`.trim();

  if (onChunk && text) {
    for (const line of text.split('\n')) onChunk(line);
  }

  if (r.timedOut) {
    return { ok: false, available: true, error: 'Codex CLI timed out', text, provider: 'codex-cli' };
  }
  if (!text) {
    return {
      ok: false,
      available: true,
      error: r.stderr || `Codex CLI exited with code ${r.code}`,
      text: '',
      provider: 'codex-cli',
    };
  }
  return { ok: true, available: true, text, provider: 'codex-cli' };
}

async function runDev({ prompt, projectRoot, onChunk } = {}) {
  const probed = await probe();
  if (!probed.installed) {
    return {
      ok: false,
      available: false,
      error: 'Codex CLI not installed.',
    };
  }
  if (!(await hasCodexAuth())) {
    return {
      ok: false,
      available: true,
      error: 'Codex not authenticated. Add OpenAI API key in Settings → Dev tools.',
    };
  }
  const dev = devSettings();
  const timeoutMs = Number(dev.codexTimeoutMs) || 300000;
  const r = await runCli(probed.command, ['exec', String(prompt || '').trim()], {
    cwd: projectRoot,
    timeoutMs,
    env: codexExecEnv(),
  });
  const text = `${r.stdout}\n${r.stderr}`.trim();
  if (onChunk && text) {
    for (const line of text.split('\n')) onChunk(line);
  }
  if (r.timedOut) {
    return { ok: false, available: true, error: 'Codex CLI timed out', text, provider: 'codex-cli' };
  }
  if (!r.ok && !text) {
    return {
      ok: false,
      available: true,
      error: r.stderr || `Codex CLI exited with code ${r.code}`,
      text: '',
      provider: 'codex-cli',
    };
  }
  return { ok: true, available: true, text, provider: 'codex-cli' };
}

module.exports = {
  probe,
  runDev,
  runReview,
  buildReviewPrompt,
  codexCommand,
  codexApiKey,
  hasCodexApiKey,
  hasCodexAuth,
  hasAuth: hasCodexAuth,
  ensureCodexLogin,
};
