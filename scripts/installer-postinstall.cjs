#!/usr/bin/env node
/** Called by the Windows installer after OpenClaw + AntlerOffice + MCP are laid down. */
const http = require('node:http');

const PORT = Number(process.env.PORT) || 3020;
const URL = `http://127.0.0.1:${PORT}/api/onboard/installer-complete`;

function post() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      URL,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body || '{}'));
          } catch {
            resolve({ ok: false, raw: body });
          }
        });
      },
    );
    req.on('error', reject);
    req.write('{}');
    req.end();
  });
}

post()
  .then((data) => {
    console.log('[installer-postinstall]', data);
    process.exit(data.ok === false ? 1 : 0);
  })
  .catch((e) => {
    console.warn('[installer-postinstall] AntlerOffice server not running yet — MCP will auto-apply on first launch.', e.message);
    process.exit(0);
  });
