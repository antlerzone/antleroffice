// Git helpers for the IT dev pipeline (feature branch, diff, commit, push).

const { runCli } = require('./cli-runner');

function gitArgs(subcommand, extra = []) {
  return [subcommand, ...extra];
}

async function git(cwd, subcommand, extra = [], opts = {}) {
  return runCli('git', gitArgs(subcommand, extra), { cwd, timeoutMs: opts.timeoutMs || 120000 });
}

async function currentBranch(cwd) {
  const r = await git(cwd, 'rev-parse', ['--abbrev-ref', 'HEAD']);
  return r.ok ? r.stdout.trim() : '';
}

async function checkoutBranch(cwd, branchName) {
  const exists = await git(cwd, 'rev-parse', ['--verify', branchName]);
  if (exists.ok) {
    return git(cwd, 'checkout', [branchName]);
  }
  return git(cwd, 'checkout', ['-b', branchName]);
}

async function diffStat(cwd) {
  const r = await git(cwd, 'diff', ['--stat']);
  if (r.ok && r.stdout.trim()) return r.stdout.trim();
  const staged = await git(cwd, 'diff', ['--cached', '--stat']);
  return staged.stdout.trim();
}

async function fullDiff(cwd) {
  const unstaged = await git(cwd, 'diff');
  const staged = await git(cwd, 'diff', ['--cached']);
  const parts = [];
  if (staged.stdout.trim()) parts.push(staged.stdout.trim());
  if (unstaged.stdout.trim()) parts.push(unstaged.stdout.trim());
  return parts.join('\n\n');
}

async function hasChanges(cwd) {
  const status = await git(cwd, 'status', ['--porcelain']);
  return !!(status.ok && status.stdout.trim());
}

async function commitAll(cwd, message) {
  const add = await git(cwd, 'add', ['-A']);
  if (!add.ok) return add;
  return git(cwd, 'commit', ['-m', message]);
}

async function pushBranch(cwd, branchName) {
  return git(cwd, 'push', ['-u', 'origin', branchName], { timeoutMs: 300000 });
}

function slugifyTask(text) {
  const slug = String(text || '')
    .slice(0, 48)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'task';
}

module.exports = {
  git,
  currentBranch,
  checkoutBranch,
  diffStat,
  fullDiff,
  hasChanges,
  commitAll,
  pushBranch,
  slugifyTask,
};
