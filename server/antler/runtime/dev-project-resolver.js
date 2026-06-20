// Resolve git project root from OpenClaw workspaces (+ optional settings override).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../store');

function expandHome(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  if (s === '~') return os.homedir();
  return s;
}

function isGitRepo(dir) {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

function readOpenClawMainWorkspace() {
  try {
    const cfgPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    if (!fs.existsSync(cfgPath)) return null;
    const raw = fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '');
    const cfg = JSON.parse(raw);
    const ws = cfg?.agents?.defaults?.workspace;
    return ws ? expandHome(ws) : null;
  } catch {
    return null;
  }
}

function scanOpenClawWorkspaces() {
  const roots = [];
  const base = path.join(os.homedir(), '.openclaw', 'workspaces');
  try {
    if (!fs.existsSync(base)) return roots;
    for (const name of fs.readdirSync(base)) {
      const full = path.join(base, name);
      try {
        if (fs.statSync(full).isDirectory() && isGitRepo(full)) roots.push(full);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }
  return roots;
}

function dedupePaths(paths) {
  const seen = new Set();
  const out = [];
  for (const p of paths) {
    const norm = path.normalize(expandHome(p));
    if (!norm || seen.has(norm.toLowerCase())) continue;
    seen.add(norm.toLowerCase());
    if (fs.existsSync(norm)) out.push(norm);
  }
  return out;
}

function readDevSettings() {
  const s = store.readSettings();
  return s.dev || {};
}

/**
 * @returns {{ ok: boolean, projectRoot?: string, candidates?: string[], needsBossInput?: boolean, message?: string }}
 */
function resolveDevProjectRoot({ bossOverride } = {}) {
  const dev = readDevSettings();
  const override = String(bossOverride || dev.projectRootOverride || '').trim();
  if (override) {
    const root = expandHome(override);
    if (!fs.existsSync(root)) {
      return { ok: false, needsBossInput: true, message: `Project path not found: ${root}` };
    }
    if (!isGitRepo(root)) {
      return { ok: false, needsBossInput: true, message: `Path is not a git repo: ${root}` };
    }
    return { ok: true, projectRoot: root, source: 'override' };
  }

  const candidates = dedupePaths([
    readOpenClawMainWorkspace(),
    ...scanOpenClawWorkspaces(),
  ].filter(Boolean));

  const gitCandidates = candidates.filter(isGitRepo);

  if (gitCandidates.length === 1) {
    return { ok: true, projectRoot: gitCandidates[0], source: 'openclaw', candidates: gitCandidates };
  }
  if (gitCandidates.length === 0) {
    return {
      ok: false,
      needsBossInput: true,
      candidates: [],
      message:
        'No git project found from OpenClaw workspaces. Reply with the full path to the repo you want IT to edit.',
    };
  }
  return {
    ok: false,
    needsBossInput: true,
    candidates: gitCandidates,
    message:
      `Multiple git projects detected. Reply with the path to use:\n${gitCandidates.map((p, i) => `${i + 1}. ${p}`).join('\n')}`,
  };
}

function parseBossProjectChoice(text, candidates = []) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const expanded = expandHome(raw);
  if (fs.existsSync(expanded)) return expanded;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 1 && n <= candidates.length) {
    return candidates[n - 1];
  }
  return null;
}

module.exports = {
  resolveDevProjectRoot,
  parseBossProjectChoice,
  isGitRepo,
  expandHome,
};
