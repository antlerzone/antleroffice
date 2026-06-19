/**
 * Wait for backend + Vite before launching Electron in dev:electron.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

function readEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  let port = 3020;
  let devPort = 3300;
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const portMatch = content.match(/^PORT=(\d+)/m);
    const devMatch = content.match(/^DEV_PORT=(\d+)/m);
    if (portMatch) port = Number(portMatch[1]) || 3020;
    if (devMatch) devPort = Number(devMatch[1]) || 3300;
  } catch {
    /* defaults */
  }
  if (process.env.PORT) port = Number(process.env.PORT) || port;
  if (process.env.DEV_PORT) devPort = Number(process.env.DEV_PORT) || devPort;
  return { port, devPort };
}

function probe(url, checkGateway = false) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => {
        if (!checkGateway) {
          resolve(res.statusCode >= 200 && res.statusCode < 500);
          return;
        }
        try {
          const data = JSON.parse(body);
          resolve(!!data && typeof data.gateway === 'string');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitFor(label, url, checkGateway, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probe(url, checkGateway)) {
      console.log(`[wait-for-dev] ${label} ready at ${url}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  console.warn(`[wait-for-dev] Timed out waiting for ${label} at ${url}`);
}

const { port, devPort } = readEnv();

Promise.all([
  waitFor('backend', `http://127.0.0.1:${port}/api/health`, false, 90000),
  waitFor('vite', `http://127.0.0.1:${devPort}/api/health`, true, 90000),
]).then(() => process.exit(0));
