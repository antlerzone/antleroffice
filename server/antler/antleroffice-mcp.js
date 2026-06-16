// AntlerOffice Tools — local HTTP MCP server for SaaS NPC authoring (via ECS server).
// Bound to HR agent via catalog mcps[] (default http://127.0.0.1:8931/mcp).

const http = require('node:http');

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

const webAccounts = () => require('./web-accounts-store');

const TOOLS = [
  {
    name: 'list_web_accounts',
    description:
      'List saved web login accounts (alias + display name only). Passwords and cookies are never returned.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_account',
    description:
      'Resolve a web account by alias. Returns safe metadata (browser_profile, session_id) — never username/password.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: 'Account alias, e.g. tnb_home.' },
      },
      required: ['alias'],
    },
  },
  {
    name: 'save_web_account',
    description:
      'Save a website login to the encrypted local vault. display_name is required (boss-visible label). Alias auto-generated if omitted. Never log or echo the password.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Login username or email.' },
        password: { type: 'string', description: 'Login password.' },
        display_name: {
          type: 'string',
          description: 'Required display name for the boss UI, e.g. 妈妈家 or TNB Account A.',
        },
        label: { type: 'string', description: 'Same as display_name (alternative field name).' },
        alias: { type: 'string', description: 'Optional alias; updates existing account if found.' },
      },
      required: ['username', 'password', 'display_name'],
    },
  },
  {
    name: 'list_saas_workers',
    description:
      'List SaaS NPC workers (departments + technical templates + installable bundles) from the ECS server catalog.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_saas_worker',
    description: 'Get one SaaS worker by department id or template id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Department id or bundle template id.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_saas_worker',
    description:
      'Create a full SaaS NPC: catalog.json entry, installable bundle, and department listing. Writes to server/ for git push to ECS.',
    inputSchema: {
      type: 'object',
      properties: {
        templateId: {
          type: 'string',
          description: 'Technical template id (snake_case), e.g. marketing_posts.',
        },
        department: {
          type: 'object',
          description:
            'Marketplace department row (id, name, tagline, category, salaryCreditsPerMonth, visibility, hirePassword when hidden, ...).',
        },
        template: {
          type: 'object',
          description:
            'Technical template fields (role, description, examples[], skillIds, openclawSkillNames, mcps, sprite, ...).',
        },
        skills: {
          type: 'array',
          description: 'ECS skill defs: [{ id, name, system }].',
        },
        openclawSkills: {
          type: 'array',
          description: 'OpenClaw SKILL.md files: [{ folderName, markdown }].',
        },
      },
      required: ['templateId', 'department', 'template', 'skills'],
    },
  },
];

function ecsBaseUrl() {
  return (
    process.env.ECS_BASE_URL ||
    process.env.ECS_SERVER_URL ||
    'http://localhost:3030'
  ).replace(/\/+$/, '');
}

function adminHeaders(extra = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  };
  const token = process.env.ECS_ADMIN_TOKEN;
  if (token) headers['x-admin-token'] = token;
  return headers;
}

async function ecsAdminJson(path, opts = {}) {
  const url = `${ecsBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetch(url, {
    ...opts,
    headers: adminHeaders(opts.headers),
    signal: AbortSignal.timeout(Number(process.env.ECS_ADMIN_TIMEOUT_MS) || 30000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `ECS admin HTTP ${res.status}`);
    err.code = body.code;
    err.status = res.status;
    throw err;
  }
  return body;
}

function toolText(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'list_web_accounts': {
      return toolText({ accounts: webAccounts().listAgentAccounts() });
    }
    case 'get_account': {
      const alias = String(args.alias || '').trim();
      if (!alias) throw new Error('alias is required');
      const account = webAccounts().resolveAgentAccount(alias);
      if (!account) throw new Error(`account not found: ${alias}`);
      return toolText(account);
    }
    case 'save_web_account': {
      const username = String(args.username || '').trim();
      const password = String(args.password || '').trim();
      const displayName = String(args.display_name || args.label || '').trim();
      if (!username || !password) throw new Error('username and password are required');
      if (!displayName) throw new Error('display_name is required');
      const account = webAccounts().saveAccount({
        username,
        password,
        displayName,
        alias: args.alias,
      });
      return toolText({
        ok: true,
        alias: account.alias,
        display_name: account.displayName,
        username_masked: account.usernameMasked,
      });
    }
    case 'list_saas_workers': {
      const data = await ecsAdminJson('/api/admin/catalog/workers');
      return toolText(data);
    }
    case 'get_saas_worker': {
      const id = String(args.id || '').trim();
      if (!id) throw new Error('id is required');
      const data = await ecsAdminJson(`/api/admin/catalog/workers/${encodeURIComponent(id)}`);
      return toolText(data);
    }
    case 'create_saas_worker': {
      const data = await ecsAdminJson('/api/admin/catalog/workers', {
        method: 'POST',
        body: JSON.stringify(args),
      });
      return toolText(data);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRpc(body) {
  const { id, method, params } = body || {};

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'antleroffice-tools', version: '2.0.0' },
    });
  }

  if (method === 'notifications/initialized' || method === 'initialized') {
    return null;
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    try {
      const result = await callTool(toolName, toolArgs);
      return rpcResult(id, result);
    } catch (e) {
      return rpcError(id, -32603, e instanceof Error ? e.message : 'Tool call failed');
    }
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

async function handleMcpRequest(req, res) {
  if (req.method === 'GET') {
    res.writeHead(200, MCP_HEADERS);
    res.end(JSON.stringify({ ok: true, name: 'antleroffice-tools', tools: TOOLS.map((t) => t.name) }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, MCP_HEADERS);
    res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
    return;
  }

  let body = {};
  try {
    body = JSON.parse(req.bodyText || '{}');
  } catch {
    res.writeHead(400, MCP_HEADERS);
    res.end(JSON.stringify(rpcError(body?.id ?? null, -32700, 'Parse error')));
    return;
  }

  const out = await handleRpc(body);
  if (!out) {
    res.writeHead(204, MCP_HEADERS);
    res.end();
    return;
  }
  res.writeHead(200, MCP_HEADERS);
  res.end(JSON.stringify(out));
}

function attachMcpRoutes(app) {
  app.use('/mcp', expressJsonRaw(), async (req, res) => {
    await handleMcpRequest(req, res);
  });
}

function expressJsonRaw() {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      req.bodyText = '';
      return next();
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      req.bodyText = Buffer.concat(chunks).toString('utf8');
      next();
    });
  };
}

function startStandaloneServer(port = 8931) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname !== '/mcp' && url.pathname !== '/') {
      res.writeHead(404, MCP_HEADERS);
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
      return;
    }

    if (req.method === 'GET') {
      await handleMcpRequest({ method: 'GET', headers: req.headers, bodyText: '' }, res);
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, MCP_HEADERS);
      res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    await handleMcpRequest({ method: 'POST', headers: req.headers, bodyText: Buffer.concat(chunks).toString('utf8') }, res);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[AntlerOffice MCP] Tools server listening on http://127.0.0.1:${port}/mcp`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[AntlerOffice MCP] Port ${port} already in use — skipping standalone MCP server`);
      return;
    }
    console.error('[AntlerOffice MCP]', err.message);
  });

  return server;
}

module.exports = {
  TOOLS,
  handleRpc,
  handleMcpRequest,
  attachMcpRoutes,
  startStandaloneServer,
  ecsBaseUrl,
  ecsAdminJson,
};
