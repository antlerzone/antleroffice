'use strict';
// 网页 + 令牌服务 + 本地 COO 中转（纯 Node，无依赖）。
// 设计：Realtime 只负责听/说，它要用 COO 时会“喊一声”（function tool），
// 浏览器把这一声转给本服务 /coo，本服务在本地调 COO，再把结果递回去。
// 全程本地，不需要任何隧道/公网地址。
// OpenAI key 自动读 AntlerOffice（model 设置页）里设好的那个。

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { loadEnv, resolveOpenAiKey, loadCoo } = require('./lib');

loadEnv();
const coo = loadCoo();
const APP_PORT = Number(process.env.APP_PORT || 8940);
const REALTIME_MODEL = process.env.REALTIME_MODEL || 'gpt-realtime';
const REALTIME_VOICE = process.env.REALTIME_VOICE || 'cedar';

function getOpenAiKey() {
  const { key, source } = resolveOpenAiKey();
  if (key) console.log('[app] OpenAI key 来源:', source, '末4位:', key.slice(-4));
  return key;
}

const SYSTEM_PROMPT = [
  '你是 AntlerOffice 的 COO 语音助手（代号 Jarvis）。用用户说话的语言回应，简洁、口语化。',
  '遇到任何关于用户公司/客户/员工/账目/排期/报告/“某某做了什么”的请求时，必须分两步，顺序不能反：',
  '第一步【先开口】：先用语音说一句简短的等待语，让用户知道你正在查，例如“好的，正在帮你查询，请稍等哦”“收到，我查一下哈”“稍等，这就去看”。这一步绝对不能省，也不要沉默。',
  '第二步【再调用】：说完等待语后，紧接着调用工具 forward_to_coo，把用户原话原样传过去（保持原语言、不要总结）。',
  '拿到 COO 的结果后，再用语音把结果自然地说给用户。',
  '如果 COO 比较慢、你已经等了一会儿，可以再补一句“还在查，再稍等一下哦”之类的话，别让用户干等着没声音。',
  '闲聊、笑话、常识自己直接回答，不要调工具。',
  'COO 有时会反问（needsBossInput），把问题念给用户，拿到答复后再调一次工具继续。',
].join('');

// 给 Realtime 的工具：本地 function tool（不是远程 MCP，所以不用暴露端口）
const FORWARD_TO_COO_TOOL = {
  type: 'function',
  name: 'forward_to_coo',
  description:
    '把一件办公室/业务的事交给 COO（公司的执行总管）。COO 能开发票/报价、记账(Bukku)、'
    + '查客户/项目、派活给员工、汇报各部门做了什么。任何关于“我的公司/客户/员工/账目/排期/报告/'
    + '某某做了什么”的请求，都调这个工具。闲聊、笑话、常识不要调，自己答。',
  parameters: {
    type: 'object',
    properties: {
      instruction: {
        type: 'string',
        description: '用户的原话，保持原语言、不要总结、不要翻译。',
      },
    },
    required: ['instruction'],
  },
};

function buildSessionConfig() {
  return {
    type: 'realtime',
    model: REALTIME_MODEL,
    instructions: SYSTEM_PROMPT,
    audio: { output: { voice: REALTIME_VOICE } },
    tools: [FORWARD_TO_COO_TOOL],
    tool_choice: 'auto',
  };
}

function mintEphemeralKey(apiKey) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify({ session: buildSessionConfig() });
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/realtime/client_secrets',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          Authorization: 'Bearer ' + apiKey,
        },
      },
      (r) => {
        let data = '';
        r.on('data', (c) => { data += c; });
        r.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (r.statusCode !== 200) {
              return reject(new Error((json.error && json.error.message) || `HTTP ${r.statusCode}`));
            }
            resolve(json);
          } catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('OpenAI 请求超时')));
    req.write(bodyStr);
    req.end();
  });
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  // 申请 Realtime 临时令牌
  if (req.url === '/session' && req.method === 'GET') {
    const apiKey = getOpenAiKey();
    if (!apiKey) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '没在 AntlerOffice(model页面) 或 .env 找到 OpenAI key' }));
    }
    try {
      const json = await mintEphemeralKey(apiKey);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value: json.value, model: REALTIME_MODEL }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 本地 COO 中转：浏览器把 Realtime 的工具调用转到这里，本地执行 COO
  if (req.url === '/coo' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const instruction = String(body.instruction || '').trim();
    if (!instruction) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ text: 'instruction 不能为空', needsBossInput: false }));
    }
    try {
      const result = await coo.run({
        instruction,
        // 'coo' = 你在 localhost:3300/chat 用的那个真·COO（接到办公室数据/工具）。
        // 不要用 'main'，那是个空白会话，只会反问。
        agentId: 'coo',
        threadId: 'realtime-voice',
        ownerKey: process.env.COO_OWNER_KEY || 'local:boss',
        system: '你正在通过语音助手为老板服务。这里说的“NPC/员工/office/办公室”一律指老板自己公司里的 AI 员工和业务，'
          + '绝不要理解成电视剧《The Office》或任何泛指。绝不允许凭空编造名单、人数或数据：'
          + '能用工具/真实数据查到的就直接给结果；如果确实调不到真实数据，就如实说“这个我暂时调不到准确数据”，不要瞎猜。'
          + '只有信息真的不足时，才用一句话问一个最关键的问题。',
        timeoutMs: 180000,
      });
      const ok = result && result.ok !== false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        text: ok ? (result.text || '已处理。') : `COO 处理失败：${(result && result.error) || '未知错误'}`,
        needsBossInput: !!(result && result.needsBossInput),
      }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: `COO 出错：${e.message}`, needsBossInput: false }));
    }
    return;
  }

  // 静态网页
  const file = req.url === '/' ? 'index.html' : req.url.replace(/^\//, '').split('?')[0];
  const filePath = path.join(__dirname, '..', 'web', file);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' ? 'text/javascript' : 'text/plain; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type });
    return res.end(fs.readFileSync(filePath));
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(APP_PORT, () => {
  console.log(`[app] 网页打开 http://127.0.0.1:${APP_PORT}`);
  console.log('[app] 本地中转模式：COO 在本机执行，无需隧道/公网地址。');
});
