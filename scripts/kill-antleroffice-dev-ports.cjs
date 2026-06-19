#!/usr/bin/env node
/** Free AntlerOffice local dev ports (never touches 3001 Coliving). */
const { execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function readDevPort() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(/^DEV_PORT=(\d+)/m);
    if (match) return Number(match[1]) || 3300;
  } catch {
    /* ignore */
  }
  return 3300;
}

const base = readDevPort();
const ports = new Set([3020, base, base + 1, base + 2, base + 3, base + 4]);

for (const port of ports) {
  try {
    execSync(`node "${path.join(__dirname, 'kill-port.cjs')}" ${port}`, {
      stdio: 'inherit',
      windowsHide: true,
    });
  } catch {
    /* ignore */
  }
}
