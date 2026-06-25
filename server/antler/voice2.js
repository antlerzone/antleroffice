'use strict';
// ── Voice v2 ─────────────────────────────────────────────────────────────────
// 干净的语音新版后端，随主程序一起启动。设计：
//   OpenAI Realtime 负责“听 + 说”；它要用 COO 时“喊一声”(function tool)，
//   前端把这一声转到 /api/voice2/coo，本地执行真·COO（agentId 'coo'），结果递回去念出来。
//   语音每一轮（你说的 + COO 答的）都写进 Boss Chat 线程，聊天记录里看得到。
// 不依赖任何 v1 文件（CosyVoice / 唤醒录音 / 旧 orchestrator），方便之后整套删 v1。

const https = require('https');

const OPENAI_HOST = 'api.openai.com';
const SESSION_PATH = '/v1/realtime/client_secrets';
const DEFAULT_MODEL = 'gpt-realtime';
const DEFAULT_VOICE = 'cedar';

function buildSystemPrompt({ assistantName, soul, bossName, sleepPhrases, sleepReply } = {}) {
  const name = String(assistantName || 'Jarvis').trim() || 'Jarvis';
  const boss = String(bossName || '').trim();
  const soulText = String(soul || '').trim();
  const phrases = String(sleepPhrases || '').trim();
  const reply = String(sleepReply || '').trim();
  const lines = [
    `你是 AntlerOffice 的 COO 语音助手，名字叫「${name}」。用用户说话的语言回应，简洁、口语化。`,
    boss ? `用户（老板）叫「${boss}」，称呼他时请用这个名字。` : '',
    '遇到任何关于用户公司/客户/员工/NPC/账目/排期/报告/“某某做了什么”的请求时，必须分两步，顺序不能反：',
    '第一步【先开口】：先用语音说一句简短的等待语，例如“好的，正在帮你查询，请稍等哦”，这一步不能省、不要沉默。',
    '第二步【再调用】：紧接着调用工具 forward_to_coo，把用户原话原样传过去（保持原语言、不要总结）。',
    '拿到结果后再用语音自然地说给用户。',
    '“NPC/员工/office/办公室”一律指老板自己公司里的 AI 员工和业务，绝不要理解成电视剧《The Office》或泛指；',
    '绝不允许凭空编造名单、人数或数据，调不到真实数据就如实说“这个我暂时调不到准确数据”。',
    '闲聊、笑话、常识自己直接回答，不要调工具。',
    phrases
      ? `当老板表示结束/不需要了（例如说「${phrases}」这类话）时：先用语音说一句「${reply || '好的，我先休息了，有事再喊我。'}」，然后调用工具 end_session 结束会话。不要追问、不要多说。`
      : '',
    soulText ? `\n你的性格与说话风格（务必贯彻）：\n${soulText}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

const FORWARD_TO_COO_TOOL = {
  type: 'function',
  name: 'forward_to_coo',
  description:
    '把一件办公室/业务的事交给 COO（公司执行总管）。COO 能开发票/报价、记账、查客户/项目/员工(NPC)、'
    + '派活、汇报各部门做了什么。任何关于老板自己公司/客户/员工/NPC/账目/排期/报告/“某某做了什么”的请求都调它。'
    + '闲聊、笑话、常识不要调，自己答。',
  parameters: {
    type: 'object',
    properties: {
      instruction: { type: 'string', description: '用户的原话，保持原语言、不要总结、不要翻译。' },
    },
    required: ['instruction'],
  },
};

const END_SESSION_TOOL = {
  type: 'function',
  name: 'end_session',
  description: '当老板表示结束、不需要了、要休息时调用，用来结束本次语音会话。调用前先用语音说一句简短的道别/休息语。',
  parameters: { type: 'object', properties: {} },
};

// OpenAI key：用 AntlerOffice（model 设置页）里设好的那个（= OpenClaw provider key）；允许 body 覆盖。
function resolveOpenAiKey(bodyKey) {
  const k = String(bodyKey || '').trim();
  if (k) return k;
  try {
    const oc = require('./openclaw-config');
    const provKey = oc.readProviderApiKey && oc.readProviderApiKey('openai');
    if (provKey && String(provKey).trim()) return String(provKey).trim();
  } catch { /* ignore */ }
  return '';
}

function buildSessionConfig({ model, voice, assistantName, soul, bossName, sleepPhrases, sleepReply }) {
  return {
    type: 'realtime',
    model: model || DEFAULT_MODEL,
    instructions: buildSystemPrompt({ assistantName, soul, bossName, sleepPhrases, sleepReply }),
    audio: {
      // 开启输入转写：把你说的话也转成文字（否则只有助手那半边能写进 Boss Chat）
      input: { transcription: { model: 'whisper-1' } },
      output: { voice: voice || DEFAULT_VOICE },
    },
    tools: [FORWARD_TO_COO_TOOL, END_SESSION_TOOL],
    tool_choice: 'auto',
  };
}

function mintEphemeralKey({ apiKey, model, voice, assistantName, soul, bossName, sleepPhrases, sleepReply }) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify({ session: buildSessionConfig({ model, voice, assistantName, soul, bossName, sleepPhrases, sleepReply }) });
    const req = https.request(
      {
        hostname: OPENAI_HOST, path: SESSION_PATH, method: 'POST',
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
              return reject(new Error((json.error && json.error.message) || ('HTTP ' + r.statusCode)));
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

// ElevenLabs 文字转语音 → 返回 mp3 Buffer
function elevenLabsTts({ text, apiKey, voiceId }) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify({ text, model_id: 'eleven_multilingual_v2' });
    const req = https.request(
      {
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      },
      (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (r.statusCode !== 200) {
            return reject(new Error('ElevenLabs HTTP ' + r.statusCode + ': ' + buf.toString('utf8').slice(0, 200)));
          }
          resolve(buf);
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('ElevenLabs 请求超时')));
    req.write(bodyStr);
    req.end();
  });
}

// 一次性 OpenAI 文本生成（用于生成招呼语等）
function openAiChat({ apiKey, system, user, model = 'gpt-4o-mini', maxTokens = 80 }) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: maxTokens,
    });
    const req = https.request(
      {
        hostname: OPENAI_HOST, path: '/v1/chat/completions', method: 'POST',
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
            const j = JSON.parse(data);
            if (r.statusCode !== 200) return reject(new Error((j.error && j.error.message) || ('HTTP ' + r.statusCode)));
            resolve(String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].messa