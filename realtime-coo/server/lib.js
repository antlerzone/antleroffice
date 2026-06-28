'use strict';
// 公用小工具：读 .env、连到现有 COO。没有任何第三方依赖。

const fs = require('fs');
const path = require('path');

// --- 极简 .env 读取（不装 dotenv）---
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

// --- 连到现有 COO（复用主项目 openclaw-gateway-chat）---
// 找不到也不崩，返回一个友好的占位实现，方便先单独测通 MCP 协议。
function loadCoo() {
  const custom = process.env.COO_GATEWAY_CHAT_PATH;
  const candidates = [
    custom,
    path.join(__dirname, '..', '..', 'server', 'antler', 'runtime', 'openclaw-gateway-chat.js'),
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const mod = require(p);
        if (mod && typeof mod.run === 'function') {
          console.log('[coo] 已接到现有 COO 接线:', p);
          return mod;
        }
      }
    } catch (e) {
      console.warn('[coo] 加载', p, '失败:', e.message);
    }
  }

  console.warn('[coo] 没找到现有 COO 接线，先用占位回复（MCP 协议仍可单独测试）。');
  return {
    async run({ instruction }) {
      return {
        ok: true,
        text: `（占位）COO 还没接上。收到指令：${instruction}`,
        needsBossInput: false,
      };
    },
  };
}

// --- 读 OpenAI key ---
// 优先用 AntlerOffice（model 设置页）里存好的 key，也就是 OpenClaw 的 provider key；
// 找不到再退回 .env 的 OPENAI_API_KEY。
function resolveOpenAiKey() {
  const candidates = [
    path.join(__dirname, '..', '..', 'server', 'antler', 'openclaw-config.js'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const oc = require(p);
        const k = oc.readProviderApiKey && oc.readProviderApiKey('openai');
        if (k && String(k).trim()) {
          return { key: String(k).trim(), source: 'antleroffice(model页面)' };
        }
      }
    } catch (e) {
      console.warn('[key] 读 AntlerOffice key 失败:', e.message);
    }
  }
  const envKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (envKey) return { key: envKey, source: '.env' };
  return { key: '', source: 'none' };
}

module.exports = { loadEnv, loadCoo, resolveOpenAiKey };
