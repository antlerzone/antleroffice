// Safe cross-platform spawn. On Windows, npm/openclaw/hermes are usually `.cmd`
// shims that a plain spawn (shell:false) can't resolve, while spawn with
// shell:true concatenates args into a command string (DEP0190 + injection risk
// when args contain user text or secrets). We instead run through `cmd.exe /c`
// with a real args array so Node escapes each argument.

const { spawn } = require('node:child_process');

function spawnCmd(cmd, args = [], opts = {}) {
  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/d', '/s', '/c', cmd, ...args], { ...opts, shell: false, windowsVerbatimArguments: false });
  }
  return spawn(cmd, args, { ...opts, shell: false });
}

// Detached background process with no visible console (Windows).
function spawnHiddenDetached(cmd, args = [], opts = {}) {
  const base = {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    ...opts,
  };
  const child = spawnCmd(cmd, args, base);
  child.unref();
  return child;
}

// Run a Node script in a truly hidden Windows process (no console window).
function spawnNodeHidden(nodePath, scriptPath, args = [], opts = {}) {
  if (process.platform === 'win32') {
    const argList = [scriptPath, ...args].map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
    const ps = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-WindowStyle',
        'Hidden',
        '-Command',
        `Start-Process -WindowStyle Hidden -FilePath '${String(nodePath).replace(/'/g, "''")}' -ArgumentList ${argList}`,
      ],
      { detached: true, stdio: 'ignore', windowsHide: true, ...opts },
    );
    ps.unref();
    return ps;
  }
  const child = spawn(nodePath, [scriptPath, ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    ...opts,
  });
  child.unref();
  return child;
}

module.exports = { spawnCmd, spawnHiddenDetached, spawnNodeHidden };
