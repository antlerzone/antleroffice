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
            resolve(String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim());
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

// 把一行字写进 Boss Chat 的 COO 线程（界面会刷新看到）
function logToBossChat({ ownerKey, ownerName, from, text }) {
  try {
    const bossChat = require('./boss-chat-store');
    const tid = bossChat.resolveThreadId('coo', null, ownerKey, ownerName);
    if (tid) bossChat.addMessage(tid, from, text, { authorName: from === 'boss' ? (ownerName || 'Boss') : 'COO' });
    return tid;
  } catch { return null; }
}

function registerVoice2Routes(app, opts = {}) {
  const resolveBossOwner = opts.resolveBossOwner || (() => ({ ownerKey: 'local:boss', ownerName: 'Boss' }));

  // 启动时把持久化的 COO 名字应用到 office-state（重启后名字不丢）
  try {
    const persisted = String(require('./store').readSettings().office?.cooName || '').trim();
    if (persisted) require('./office-state').setAgent('coo', { label: persisted });
  } catch { /* ignore */ }

  // 启动后把持久化的 v2 唤醒词推给监听器（延迟，等监听器起来）
  try {
    const off = require('./store').readSettings().office || {};
    let persistedWake = Array.isArray(off.voice2WakePhrases) ? off.voice2WakePhrases : (off.voice2WakePhrase ? [off.voice2WakePhrase] : []);
    persistedWake = persistedWake.map((p) => String(p || '').trim()).filter(Boolean);
    if (persistedWake.length) {
      setTimeout(() => {
        try {
          require('./voice-listener-manager').updateListenerConfig({ globalListenEnabled: true, wakePhrases: persistedWake });
          console.log('[voice2] 开机推送唤醒词给监听器:', persistedWake.join(','));
        } catch (e) { console.warn('[voice2] 开机推送唤醒词失败:', e.message); }
      }, 12000);
    }
  } catch { /* ignore */ }

  // 给内置 COO 改名（/agents 页 Actions → Rename 会调这里）。也就是语音助手的名字。
  app.post('/api/voice2/coo-name', (req, res) => {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: '名字不能为空' });
    try {
      const store = require('./store');
      const s = store.readSettings();
      s.office = s.office || {};
      s.office.cooName = name;
      store.writeSettings(s);
      require('./office-state').setAgent('coo', { label: name });
      try { require('./pa-bridge').refreshOfficeBroadcast(); } catch { /* */ }
      res.json({ ok: true, name });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 每次召唤开一条全新的 COO 对话线程，返回它的 id（这一轮转写都进它）
  app.post('/api/voice2/new-thread', (req, res) => {
    try {
      const owner = resolveBossOwner(req) || {};
      const ownerKey = (req.body && req.body.ownerKey) || owner.ownerKey || 'local:boss';
      const ownerName = (req.body && req.body.ownerName) || owner.ownerName || 'Boss';
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const h24 = d.getHours();
      const ampm = h24 < 12 ? 'AM' : 'PM';
      const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
      const title = `语音 ${d.getMonth() + 1}/${d.getDate()} ${h12}:${pad(d.getMinutes())} ${ampm}`;
      const thread = require('./boss-chat-store').createThread('coo', title, { ownerKey, ownerName });
      res.json({ ok: true, threadId: thread.id });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 调试：前端把 v2 连接过程的关键节点打到后端终端，方便排查（不影响功能）
  app.post('/api/voice2/debug', (req, res) => {
    const msg = String((req.body && req.body.msg) || '').slice(0, 200);
    console.log('[voice2/debug]', msg);
    res.json({ ok: true });
  });

  // 一键清空：删除所有「语音」开头的对话线程（可选 onlyEmpty=只删空的）
  app.post('/api/voice2/clear-threads', (req, res) => {
    try {
      const body = req.body || {};
      const onlyEmpty = body.onlyEmpty === true;
      const owner = resolveBossOwner(req) || {};
      const ownerKey = body.ownerKey || owner.ownerKey || 'local:boss';
      const bossChat = require('./boss-chat-store');
      const threads = bossChat.listThreads('coo', ownerKey) || [];
      let removed = 0;
      for (const t of threads) {
        const isVoice = typeof t.title === 'string' && t.title.startsWith('语音');
        if (!isVoice) continue;
        if (onlyEmpty && (t.messages || []).length > 0) continue;
        if (bossChat.deleteThread(t.id, ownerKey)) removed += 1;
      }
      console.log(`[voice2] 一键清空语音对话：删除 ${removed} 条 (onlyEmpty=${onlyEmpty})`);
      res.json({ ok: true, removed });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 申请 Realtime 临时令牌
  app.post('/api/voice2/session', async (req, res) => {
    try {
      const body = req.body || {};
      console.log('[voice2/session] v2 正在申请 Realtime 令牌（说明前端在尝试连接）');
      const apiKey = resolveOpenAiKey(body.apiKey);
      if (!apiKey) return res.status(400).json({ ok: false, error: '没在 AntlerOffice(model页面) 找到 OpenAI key' });
      // 助手名字 = COO agent 的名字（在 /agents 页可改名）；voice2 在主进程，直接读 office-state。
      let assistantName = '';
      try {
        const coo = require('./office-state').getAgent('coo');
        assistantName = (coo && (coo.label || coo.name)) ? String(coo.label || coo.name).trim() : '';
      } catch { /* ignore */ }
      const json = await mintEphemeralKey({
        apiKey, model: body.model, voice: body.voice,
        assistantName: assistantName || 'Jarvis', soul: body.soul, bossName: body.bossName,
        sleepPhrases: body.sleepPhrases, sleepReply: body.sleepReply,
      });
      res.json({ ok: true, value: json.value, model: body.model || DEFAULT_MODEL });
    } catch (e) {
      console.error('[voice2] session error:', e.message);
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  // 本地中转：前端把 Realtime 的工具调用转到这里，本地执行真·COO，并写进 Boss Chat
  app.post('/api/voice2/coo', async (req, res) => {
    const body = req.body || {};
    const instruction = String(body.instruction || '').trim();
    if (!instruction) return res.status(400).json({ ok: false, text: 'instruction 不能为空' });
    const owner = resolveBossOwner(req) || {};
    const ownerKey = body.ownerKey || owner.ownerKey || 'local:boss';
    // 注意：Boss Chat 的写入交给 /transcript（按真实说出来的话写，避免重复）。
    // 这一轮召唤有专属新线程就用它，让 COO 的上下文也归到这条对话。
    const tid = body.threadId || (() => {
      try { return require('./boss-chat-store').resolveThreadId('coo', null, ownerKey, owner.ownerName); }
      catch { return 'voice2'; }
    })();

    try {
      const cooChat = require('./runtime/openclaw-gateway-chat');
      const result = await cooChat.run({
        instruction,
        agentId: 'coo', // 真·COO（同 Boss Chat 那个），不是空白的 'main'
        threadId: tid || 'voice2',
        ownerKey,
        system: '你正在通过语音助手为老板服务。能查到的就直接动手查并给结果，不要反复追问；'
          + '“NPC/员工/office”指老板自己公司的 AI 员工，绝不要理解成电视剧，也绝不编造数据，调不到就如实说。',
        timeoutMs: 180000,
      });
      const ok = result && result.ok !== false;
      const text = ok ? (result.text || '已处理。') : ('抱歉，COO 处理失败：' + ((result && result.error) || '未知错误'));
      res.json({ ok, text, needsBossInput: !!(result && result.needsBossInput) });
    } catch (e) {
      res.json({ ok: false, text: 'COO 出错：' + e.message, needsBossInput: false });
    }
  });

  // 让前端把“纯闲聊”的语音转写也写进 Boss Chat（你说的 + Jarvis 直接答的）
  app.post('/api/voice2/transcript', (req, res) => {
    const body = req.body || {};
    const text = String(body.text || '').trim();
    const role = body.role === 'assistant' ? 'coo' : 'boss';
    const owner = resolveBossOwner(req) || {};
    console.log(`[voice2/transcript] role=${role} threadId=${body.threadId || '(无)'} owner=${owner.ownerKey} len=${text.length} text="${text.slice(0, 30)}"`);
    if (!text) return res.json({ ok: true });
    const ownerName = body.ownerName || owner.ownerName || 'Boss';
    // 这一轮召唤有专属新线程 → 直接写进它（每次召唤一条独立对话）
    if (body.threadId) {
      try {
        const m = require('./boss-chat-store').addMessage(body.threadId, role, text, { authorName: role === 'boss' ? ownerName : 'COO' });
        console.log(`[voice2/transcript] 写入线程 ${body.threadId} ${m ? '成功' : '失败(线程不存在?)'}`);
        if (m) return res.json({ ok: true });
      } catch (e) { console.warn('[voice2/transcript] 写入出错:', e.message); }
    }
    logToBossChat({
      ownerKey: body.ownerKey || owner.ownerKey || 'local:boss',
      ownerName, from: role, text,
    });
    res.json({ ok: true });
  });

  // 一键生成招呼语（按助手名 + 老板名 + 人设）
  app.post('/api/voice2/generate-greeting', async (req, res) => {
    const apiKey = resolveOpenAiKey(req.body && req.body.apiKey);
    if (!apiKey) return res.status(400).json({ ok: false, error: '没找到 OpenAI key' });
    let assistantName = 'Jarvis';
    try {
      const coo = require('./office-state').getAgent('coo');
      assistantName = (coo && (coo.label || coo.name)) ? String(coo.label || coo.name).trim() : 'Jarvis';
    } catch { /* ignore */ }
    const boss = String((req.body && req.body.bossName) || '').trim();
    const soul = String((req.body && req.body.soul) || '').trim();
    const sys = `你是语音助手「${assistantName}」。写一句简短、自然、口语化的唤醒招呼语——老板喊你时你说的第一句。`
      + (boss ? `称呼老板为「${boss}」。` : '')
      + (soul ? `贴合这个人设：${soul}。` : '')
      + '只输出这一句招呼本身，不要引号、不要解释、不要换行。';
    try {
      let text = await openAiChat({ apiKey, system: sys, user: '生成招呼语' });
      text = text.replace(/^["“「']+|["”」']+$/g, '').trim();
      res.json({ ok: true, greeting: text });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  // 把 v2 设置里的「唤醒词」推给本地监听器。中文/任意词会走本地 whisper 匹配（不烧 token）。
  app.post('/api/voice2/wake-word', (req, res) => {
    const body = req.body || {};
    // 支持多个唤醒词（数组）；也兼容旧的单个 phrase
    let phrases = Array.isArray(body.phrases) ? body.phrases : (body.phrase ? [body.phrase] : []);
    phrases = phrases.map((p) => String(p || '').trim()).filter(Boolean);
    try {
      // 持久化（重启后开机自动推）
      try {
        const store = require('./store');
        const s = store.readSettings();
        s.office = s.office || {};
        s.office.voice2WakePhrases = phrases;
        store.writeSettings(s);
      } catch { /* ignore */ }
      // 清掉旧的默认唤醒 clip（那些 Hey Jarvis），让设的词成为唯一唤醒词。
      if (phrases.length && body.replaceDefaults !== false) {
        try {
          const clips = require('./wake-clips-store');
          for (const c of clips.listClips()) clips.deleteClip(c.id);
          console.log('[voice2] 已清掉默认唤醒词(Hey Jarvis 等)，只保留:', phrases.join(','));
        } catch (e) { console.warn('[voice2] 清 clip 失败:', e.message); }
      }
      require('./voice-listener-manager').updateListenerConfig({
        globalListenEnabled: true,
        wakePhrases: phrases,
      });
      console.log('[voice2] wake-word 推给监听器:', phrases.join(',') || '(空)');
      res.json({ ok: true, phrases });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ElevenLabs 语音输出（Fish 复用现成的 /api/voice/tts/fishaudio）
  app.post('/api/voice2/tts/elevenlabs', async (req, res) => {
    const { text, apiKey, voiceId } = req.body || {};
    if (!String(text || '').trim()) return res.status(400).json({ ok: false, error: 'text 为空' });
    if (!String(apiKey || '').trim()) return res.status(400).json({ ok: false, error: '缺 ElevenLabs key' });
    if (!String(voiceId || '').trim()) return res.status(400).json({ ok: false, error: '缺 voiceId' });
    try {
      const buf = await elevenLabsTts({ text, apiKey, voiceId });
      res.setHeader('Content-Type', 'audio/mpeg');
      res.send(buf);
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { registerVoice2Routes, buildSessionConfig, resolveOpenAiKey, buildSystemPrompt };
