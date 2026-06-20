// Spawn a CLI command with timeout and captured stdout/stderr.

const { spawnCmd } = require('../spawn-util');

function runCli(cmd, args = [], { cwd, env, timeoutMs = 300000, input } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };

    let child;
    try {
      child = spawnCmd(cmd, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return finish({ ok: false, code: -1, stdout: '', stderr: err.message, timedOut: false });
    }

    if (input && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, code: -1, stdout, stderr: `${stderr}\n(timeout after ${timeoutMs}ms)`.trim(), timedOut: true });
    }, timeoutMs);

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, code: -1, stdout, stderr: err.message, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, code: code ?? -1, stdout, stderr, timedOut: false });
    });
  });
}

async function probeCli(cmd, args = ['--version'], timeoutMs = 8000) {
  const r = await runCli(cmd, args, { timeoutMs });
  const combined = `${r.stdout}\n${r.stderr}`.trim();
  const installed = r.ok || /\d+\.\d+/.test(combined);
  return { installed, version: installed ? combined.split('\n')[0].trim() : '', raw: combined };
}

module.exports = { runCli, probeCli };
