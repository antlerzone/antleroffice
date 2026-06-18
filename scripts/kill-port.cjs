#!/usr/bin/env node
/** Kill process listening on a TCP port (Windows dev helper). */
const { execSync } = require('node:child_process');

const port = String(process.argv[2] || '3020').trim();
if (!/^\d+$/.test(port)) {
  console.error('Usage: node scripts/kill-port.cjs [port]');
  process.exit(1);
}

if (process.platform !== 'win32') {
  console.log(`[kill-port] Skipped on ${process.platform} (Windows helper only).`);
  process.exit(0);
}

try {
  const out = execSync(`netstat -ano | findstr ":${port}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue;
    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1];
    if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
  }
  if (!pids.size) {
    console.log(`[kill-port] Port ${port} is free.`);
    process.exit(0);
  }
  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      console.log(`[kill-port] Killed PID ${pid} on port ${port}`);
    } catch {
      console.warn(`[kill-port] Could not kill PID ${pid}`);
    }
  }
} catch {
  console.log(`[kill-port] Port ${port} is free.`);
}
