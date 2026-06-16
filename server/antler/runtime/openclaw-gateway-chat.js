// Run a boss-chat turn through the real OpenClaw Gateway (chat.send + chat.history).
// This is the same execution path as the main Chat UI — tools, browser, exec, etc.

const oc = require('../openclaw-config');
const { needsBossInput, scanMessagesForToolAuthBlock } = require('../agent-outcome');

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    /* */
  }
  const blob = String(s || '');
  const i = blob.indexOf('{');
  const j = blob.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try {
      return JSON.parse(blob.slice(i, j + 1));
    } catch {
      /* */
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractAssistantText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let last = '';
  for (const m of list) {
    if (String(m?.role || '').toLowerCase() !== 'assistant') continue;
    const parts = Array.isArray(m.content) ? m.content : [];
    for (const p of parts) {
      if (p?.type === 'text' && String(p.text || '').trim()) {
        last = String(p.text).trim();
      }
    }
    if (typeof m.text === 'string' && m.text.trim()) last = m.text.trim();
    if (typeof m.content === 'string' && m.content.trim()) last = m.content.trim();
  }
  return last;
}

function isRunComplete(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (String(m?.role || '').toLowerCase() !== 'assistant') continue;
    const reason = String(m.stopReason || '').toLowerCase();
    if (reason === 'stop' || reason === 'end_turn') {
      return extractAssistantText(list).length > 0;
    }
    if (reason === 'tooluse' || reason === 'tool_use') return false;
    const parts = Array.isArray(m.content) ? m.content : [];
    if (parts.some((p) => p?.type === 'text' && String(p.text || '').trim().length > 40)) {
      return reason !== 'tooluse' && reason !== 'tool_use';
    }
  }
  return false;
}

function toolActivityLabel(toolName) {
  const n = String(toolName || '').toLowerCase();
  if (/exec|bash|shell|command/.test(n)) return 'Running commands…';
  if (/browser|web|fetch|curl|search|firecrawl|perplexity/.test(n)) return 'Searching the web…';
  if (/read|file|grep/.test(n)) return 'Reading files…';
  return toolName ? `Using ${toolName}…` : 'Using tools…';
}

function liveStatusFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    const role = String(m?.role || '').toLowerCase();
    if (role === 'assistant') {
      const parts = Array.isArray(m.content) ? m.content : [];
      for (let j = parts.length - 1; j >= 0; j -= 1) {
        const p = parts[j];
        if (p?.type === 'toolCall' && p.name) {
          return { bubble: toolActivityLabel(p.name), step: 'Searching' };
        }
        if (p?.type === 'text' && String(p.text || '').trim()) {
          const preview = String(p.text).trim();
          const short = preview.length > 48 ? `${preview.slice(0, 48)}…` : preview;
          return { bubble: short || 'Typing…', step: 'Typing' };
        }
      }
      const reason = String(m.stopReason || '').toLowerCase();
      if (reason === 'tooluse' || reason === 'tool_use') {
        return { bubble: 'Searching…', step: 'Searching' };
      }
    }
    if (role === 'toolresult' || role === 'tool_result') {
      return { bubble: 'Processing results…', step: 'Searching' };
    }
  }
  return { bubble: 'Thinking…', step: 'Thinking' };
}

function pushCooLiveStatus(messages) {
  try {
    const office = require('../office-state');
    const { bubble, step } = liveStatusFromMessages(messages);
    office.setAgent('coo', {
      npcState: 'working',
      bubbleText: bubble,
      currentJob: { label: step, step, progress: 2, total: 2 },
    });
  } catch {
    /* best-effort */
  }
}

async function gatewayCallJson(method, params, { timeoutMs = 120000 } = {}) {
  const r = await oc.gatewayCall(method, params, { timeoutMs });
  if (r && r.ok !== false && (r.runId || r.messages || r.sessionKey || r.status)) return r;
  if (r?.error) return { ok: false, error: r.error };
  return { ok: false, error: 'gateway call failed' };
}

async function ensureGateway() {
  const probe = await oc.gatewayProbe();
  if (probe.running) return { ok: true, running: true };
  const started = await oc.gatewayStart();
  const running = !!started.probe?.running;
  return { ok: running, running, error: started.probe?.error || '' };
}

function buildMessage({ system, instruction }) {
  if (!system) return instruction;
  return `Context:\n${system}\n\n---\nTask: ${instruction}`;
}

function sessionKeyFor({ agentId = 'main', threadId, ownerKey }) {
  const peer = threadId || ownerKey || 'boss';
  const safe = String(peer).replace(/[^a-zA-Z0-9:_-]/g, '-').slice(0, 80);
  return `agent:${agentId}:main:dm:antler-${safe}`;
}

// Returns { ok, text, provider } or { ok:false, available, error }.
async function run({
  instruction,
  system = '',
  agentId = 'main',
  threadId,
  ownerKey,
  timeoutMs = 180000,
} = {}) {
  if (!(await oc.isAvailable())) return { ok: false, available: false };

  const gw = await ensureGateway();
  if (!gw.running) {
    return { ok: false, available: true, error: gw.error || 'OpenClaw Gateway is not running' };
  }

  const sessionKey = sessionKeyFor({ agentId, threadId, ownerKey });
  const message = buildMessage({ system, instruction });
  const idempotencyKey = `antler-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  const sent = await gatewayCallJson(
    'chat.send',
    { sessionKey, message, idempotencyKey },
    { timeoutMs: 30000 },
  );
  if (!sent.runId && sent.status !== 'started') {
    return { ok: false, available: true, error: sent.error || 'chat.send failed' };
  }

  pushCooLiveStatus([]);

  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  let lastMessages = [];
  while (Date.now() < deadline) {
    await sleep(2500);
    const hist = await gatewayCallJson('chat.history', { sessionKey, limit: 40 }, { timeoutMs: 30000 });
    const messages = hist.messages || [];
    lastMessages = messages;
    pushCooLiveStatus(messages);
    const text = extractAssistantText(messages);
    if (text) lastText = text;
    if (text && isRunComplete(messages)) {
      const toolAuthBlocked = scanMessagesForToolAuthBlock(messages);
      const blocked = needsBossInput(text, { toolAuthBlocked });
      return { ok: true, text, provider: 'openclaw-gateway', needsBossInput: blocked };
    }
  }

  if (lastText) {
    const toolAuthBlocked = scanMessagesForToolAuthBlock(lastMessages);
    return {
      ok: true,
      text: lastText,
      provider: 'openclaw-gateway (partial)',
      needsBossInput: needsBossInput(lastText, { toolAuthBlocked }),
    };
  }
  return { ok: false, available: true, error: 'OpenClaw Gateway timed out waiting for a reply' };
}

module.exports = { run, sessionKeyFor, ensureGateway };
