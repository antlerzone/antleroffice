// Claude Code CLI — write + review (Plan A local spawn).

const store = require('../store');
const { runCli, probeCli } = require('./cli-runner');
const { buildReviewPrompt } = require('./dev-review-prompt');

function devSettings() {
  return store.readSettings().dev || {};
}

function claudeCommand() {
  return String(devSettings().claudeCommand || 'claude').trim() || 'claude';
}

function claudeApiKey() {
  const fromDev = String(devSettings().claudeApiKey || '').trim();
  if (fromDev) return fromDev;
  const fromProvider = String(store.readSettings().providers?.anthropic?.apiKey || '').trim();
  if (fromProvider) return fromProvider;
  return String(process.env.ANTHROPIC_API_KEY || '').trim();
}

function hasAuth() {
  return !!claudeApiKey();
}

async function probe() {
  const cmd = claudeCommand();
  const r = await probeCli(cmd);
  return { ...r, command: cmd };
}

function claudeEnv() {
  const key = claudeApiKey();
  if (!key) return {};
  return { ANTHROPIC_API_KEY: key };
}

async function runPrompt({ prompt, projectRoot, onChunk, timeoutMs } = {}) {
  const probed = await probe();
  if (!probed.installed) {
    return {
      ok: false,
      available: false,
      error: 'Claude CLI not found. Install from Settings → Dev tools.',
    };
  }
  if (!hasAuth()) {
    return {
      ok: false,
      available: true,
      error: 'Claude API key not set. Add it in Settings → Dev tools.',
    };
  }
  const dev = devSettings();
  const cmd = probed.command;
  const args = ['--print', '--dangerously-skip-permissions'];
  const model = String(dev.claudeModel || '').trim();
  if (model) args.push('--model', model);
  args.push(String(prompt || '').trim());

  const ms = timeoutMs || Number(dev.claudeTimeoutMs) || 600000;
  const r = await runCli(cmd, args, { cwd: projectRoot, env: claudeEnv(), timeoutMs: ms });
  const text = `${r.stdout}\n${r.stderr}`.trim();
  if (onChunk && text) {
    for (const line of text.split('\n')) onChunk(line);
  }
  if (r.timedOut) {
    return { ok: false, available: true, error: 'Claude CLI timed out', text, provider: 'claude-cli' };
  }
  if (!r.ok && !text) {
    return {
      ok: false,
      available: true,
      error: r.stderr || `Claude CLI exited with code ${r.code}`,
      text: '',
      provider: 'claude-cli',
    };
  }
  return { ok: true, available: true, text, provider: 'claude-cli' };
}

async function runDev(opts) {
  return runPrompt(opts);
}

async function runReview({ plan, diff, projectRoot, onChunk } = {}) {
  const prompt = buildReviewPrompt({ plan, diff });
  return runPrompt({ prompt, projectRoot, onChunk });
}

module.exports = {
  probe,
  runDev,
  runReview,
  claudeCommand,
  claudeApiKey,
  hasAuth,
};
