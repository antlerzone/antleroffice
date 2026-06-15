#!/usr/bin/env node
/**
 * Plan 1 verification — MCP schema, probe, OAuth state, agent mcpBindings, hire import.
 * Usage: node server/antler/verify-plan1.js [--base http://127.0.0.1:3020]
 */

const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const base = (process.argv.find((a) => a.startsWith('--base=')) || '--base=http://127.0.0.1:3020')
  .split('=')[1]
  .replace(/\/+$/, '');

const results = [];

function pass(name, detail) {
  results.push({ name, ok: true, detail });
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail) {
  results.push({ name, ok: false, detail });
  console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function request(method, urlPath, body) {
  const url = `${base}${urlPath}`;
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, text };
}

function localServer(handler, port) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

async function verifyHttpApi() {
  const probeBad = await request('POST', '/api/config/mcps/probe', { url: 'http://127.0.0.1:59999' });
  if (probeBad.status === 404) {
    fail('POST /api/config/mcps/probe exists', '404 — restart backend (npm run dev:all)');
    return false;
  }
  if (probeBad.status === 422 && probeBad.data.reachable === false) {
    pass('POST /api/config/mcps/probe rejects unreachable', probeBad.data.error || '422');
  } else {
    fail('POST /api/config/mcps/probe rejects unreachable', `status ${probeBad.status}`);
  }

  const oauthCb = await request('GET', '/api/config/mcps/oauth/callback?error=denied');
  if (oauthCb.status === 400 && oauthCb.text.includes('antleroffice-mcp-oauth')) {
    pass('GET /api/config/mcps/oauth/callback', 'HTML callback page');
  } else {
    fail('GET /api/config/mcps/oauth/callback', `status ${oauthCb.status}`);
  }

  const agents = await request('GET', '/api/config/agents');
  if (agents.status === 200 && Array.isArray(agents.data.agents)) {
    pass('GET /api/config/agents', `${agents.data.agents.length} agents`);
  } else {
    fail('GET /api/config/agents', `status ${agents.status}`);
  }

  return true;
}

async function verifyRegistryModules() {
  const tmp = path.join(os.tmpdir(), `ao2-verify-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  process.env.ANTLEROFFICE_DATA_DIR = tmp;
  const store = require('./store');
  store.setDataDir(tmp);

  const registry = require('./registry-store');
  const mcpTasklist = require('./mcp-tasklist');
  const mcpOAuth = require('./mcp-oauth');
  const mcpProbe = require('./mcp-probe');

  const legacy = {
    id: 'mcp_old',
    name: 'Legacy',
    url: 'http://legacy/mcp',
    transport: 'http',
    authType: 'api_key',
    auth: { apiKey: 'secret' },
  };
  fs.writeFileSync(path.join(tmp, 'mcps.json'), JSON.stringify([legacy]));
  const migrated = registry.getMcp('mcp_old');
  if (migrated?.accounts?.length === 1 && migrated.accounts[0].label === 'Default') {
    pass('Legacy MCP migration', 'accounts[0] Default');
  } else {
    fail('Legacy MCP migration', JSON.stringify(migrated?.accounts));
  }

  fs.writeFileSync(
    path.join(tmp, 'agents.json'),
    JSON.stringify([{ id: 'u1', name: 'A', mcpIds: ['mcp_old'] }]),
  );
  const agent = registry.getAgent('u1');
  if (agent?.mcpBindings?.[0]?.mcpId === 'mcp_old') {
    pass('Legacy agent mcpBindings', 'derived from mcpIds');
  } else {
    fail('Legacy agent mcpBindings', JSON.stringify(agent?.mcpBindings));
  }

  const mcp = registry.addMcp({ name: 'FB', url: 'http://127.0.0.1:59301/mcp', transport: 'http' });
  const a1 = registry.addMcpAccount(mcp.id, { label: 'Acc1', authType: 'bearer' });
  registry.updateMcpAccount(mcp.id, a1.account.id, { auth: { bearerToken: 't1' } });
  const a2 = registry.addMcpAccount(mcp.id, { label: 'Acc2', authType: 'bearer' });
  registry.updateMcpAccount(mcp.id, a2.account.id, { auth: { bearerToken: 't2' } });
  const ag = registry.addAgent({
    name: 'Poster',
    mcpBindings: [{ mcpId: mcp.id, accountIds: [a1.account.id, a2.account.id] }],
  });
  const steps = mcpTasklist.assignTasklistAccounts('1. a\n2. b\n3. c', ag.mcpBindings, registry);
  if (steps.map((s) => s.accountLabel).join(',') === 'Acc1,Acc2,Acc1') {
    pass('Tasklist round-robin', steps.map((s) => s.accountLabel).join(' → '));
  } else {
    fail('Tasklist round-robin', JSON.stringify(steps));
  }

  const spec = registry.resolveAgentMcpRuntimeSpec(ag.id);
  if (spec.mcpServers[0]?.accounts[0]?.headers?.Authorization) {
    pass('Runtime spec headers', 'Bearer token present');
  } else {
    fail('Runtime spec headers', JSON.stringify(spec.mcpServers[0]?.accounts[0]));
  }

  process.env.PORT = '59300';
  process.env.OAUTH_REDIRECT_BASE = 'http://127.0.0.1:59300';
  registry.updateMcpAccount(mcp.id, a1.account.id, {
    authType: 'oauth',
    auth: {
      oauth: {
        clientId: 'c',
        clientSecret: 's',
        authorizeUrl: 'http://127.0.0.1:59302/authorize',
        tokenUrl: 'http://127.0.0.1:59302/token',
      },
    },
  });
  const idp = await localServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1:59302');
    if (u.pathname === '/authorize') {
      res.writeHead(302, {
        Location: `${u.searchParams.get('redirect_uri')}?code=abc&state=${u.searchParams.get('state')}`,
      });
      res.end();
      return;
    }
    if (u.pathname === '/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'tok-verify' }));
      return;
    }
    res.writeHead(404);
    res.end();
  }, 59302);
  const started = mcpOAuth.startOAuth({
    mcpId: mcp.id,
    accountId: a1.account.id,
    account: registry.getMcpAccount(mcp.id, a1.account.id),
    frontendOrigin: 'http://127.0.0.1:3001',
  });
  const cb = await mcpOAuth.handleCallback({
    code: 'abc',
    state: new URL(started.authorizeUrl).searchParams.get('state'),
    registry,
  });
  if (cb.ok && registry.getMcpAccount(mcp.id, a1.account.id).auth.oauth.accessToken === 'tok-verify') {
    pass('OAuth code exchange', 'token saved');
  } else {
    fail('OAuth code exchange', cb.error || 'no token');
  }
  idp.close();

  const mock = await localServer((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  }, 59301);
  const probe = await mcpProbe.probe({ url: 'http://127.0.0.1:59301' });
  mock.close();
  if (probe.reachable && !probe.authRequired) {
    pass('MCP probe reachable', probe.probedUrl || probe.statusCode);
  } else {
    fail('MCP probe reachable', JSON.stringify(probe));
  }

  const agentCatalog = require('./agent-catalog');
  if (typeof agentCatalog.ensureBundledMcp === 'function') {
    pass('Hire bundle helpers', 'ensureBundledMcp exported');
  } else {
    fail('Hire bundle helpers', 'missing ensureBundledMcp');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}

async function main() {
  console.log(`AntlerOffice Plan 1 verify — ${base}\n`);
  const apiOk = await verifyHttpApi();
  console.log('');
  await verifyRegistryModules();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    process.exitCode = 1;
    console.log('\nFailed:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  } else {
    console.log('\nAll Plan 1 checks passed.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
