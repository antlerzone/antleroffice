'use strict';
// COO 的 MCP server（纯 Node，无依赖）。
// 用 JSON-RPC over HTTP（MCP Streamable HTTP 的简化实现），
// 暴露给 OpenAI Realtime 直接调用。核心就一个工具：forward_to_coo。

const http = require('http');
const { loadEnv, loadCoo } = require('./lib');

loadEnv();
const coo = loadCoo();
const PORT = Number(process.env.MCP_PORT || 8941);

// ---- 工具清单 ----
const TOOLS = [
  {
    name: 'forward_to_coo',
    description:
      '把一件办公室/业务的事交给 COO（公司的执行总管）。COO 能开发票/报价、记账(Bukku)、'
      + '查客户/项目、派活给员工、汇报各部门做了什么。任何关于“我的公司/客户/员工/账目/排期/报告/'
      + '某某做了什么”的请求，都调这个工具。闲聊、笑话、常识不要调，自己答。',
    inputSchema: {
      type: 'object',
      properties: {
        instruction: {
          type: 'string',
          description: '用户的原话，保持原语言、不要总结、不要翻译，就像他直接打字给 COO 一样。',
        },
      },
      required: ['instruction'],
    },
  },
];

async function callTool(name, args) {
  if (name !== 'forward_to_coo') {
    throw new Error(`未知工具: ${name}`);
  }
  const instruction = String((args && args.instruction) || '').trim();
  if (!instruction) throw new Error('instruction 不能为空');

  const result = await coo.run({
    instruction,
    agentId: 'coo', // 真·COO（同 localhost:3300/chat），不是空白的 'main'
    threadId: 'realtime-voice',
    ownerKey: process.env.COO_OWNER_KEY || 'local:boss',
    system: '你正在通过语音助手为老板服务。“NPC/员工/office/办公室”一律指老板自己公司里的 AI 员工和业务，'
      + '绝不要理解成电视剧《The Office》或任何泛指。绝不允许凭空编造名单、人数或数据：'
      + '能用真实数据查到的就直接给；调不到就如实说“这个我暂时调不到准确数据”，不要瞎猜。',
    timeoutMs: 180000,
  });

  if (!result || result.ok === false) {
    const msg = (result && result.error) || 'COO 没能完成这件事';
    return { text: `抱歉，COO 处理失败：${msg}`, needsBossInput: false };
  }
  return { text: result.text || '已处理。', needsBossInput: !!result.needsBossInput };
}

// ---- JSON-RPC 处理 ----
function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRpc(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'antler-coo-mcp', version: '0.1.0' },
    });
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const out = await callTool(name, args);
      return rpcResult(id, {
        content: [{ type: 'text', text: out.text }],
        isError: false,
        _meta: { needsBossInput: out.needsBossInput },
      });
    } catch (e) {
      return rpcResult(id, {
        content: [{ type: 'text', text: `工具出错：${e.message}` }],
        isError: true,
      });
    }
  }

  // ping 等
  if (method === 'ping') return rpcResult(id, {});

  return rpcError(id, -32601, `Method not found: ${method}`);
}

const server = http.createServer((req, res) => {
  // 简单 CORS（隧道/调试用）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('AntlerOffice COO MCP server 正在运行。MCP 入口：POST 本地址。');
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    return res.end();
  }

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { res.writeHead(400); return res.end('bad json'); }

    // 通知类（如 notifications/initialized）没有 id，不需要回结果
    const isNotification = parsed && parsed.id === undefined;
    if (isNotification) {
      res.writeHead(202);
      return res.end();
    }

    try {
      const result = await handleRpc(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rpcError(parsed && parsed.id, -32603, e.message)));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mcp] COO MCP server 监听 http://0.0.0.0:${PORT}`);
  console.log('[mcp] 记得用隧道把它暴露成公网地址，填进 .env 的 MCP_PUBLIC_URL');
});
