// OpenClaw executor. Prefer the real Gateway (chat.send + tools); fall back to
// embedded CLI (`openclaw agent --local`) when the gateway is unreachable.

const oc = require('../openclaw-config');
const store = require('../store');
const gatewayChat = require('./openclaw-gateway-chat');

async function tryGateway(rt, message) {
  if (!rt.baseUrl) return null;
  try {
    const res = await fetch(`${rt.baseUrl}${rt.runPath || '/agent'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const text = data?.text || data?.result || data?.message || '';
    if (text) return { ok: true, text: String(text).trim(), provider: 'openclaw-gateway' };
  } catch {
    /* gateway HTTP not reachable */
  }
  return null;
}

// Returns { ok, text, provider } on success, or { ok:false, available } so the
// caller can fall back to demo when OpenClaw isn't installed/reachable.
async function run({ instruction, system, agentId, threadId, ownerKey } = {}) {
  const rt = store.readSettings().runtimes?.openclaw || {};
  const message = system ? `Context:\n${system}\n\n---\nTask: ${instruction}` : instruction;

  if (rt.mode === 'gateway') {
    const viaHttp = await tryGateway(rt, message);
    if (viaHttp) return viaHttp;
  }

  // Real OpenClaw Gateway — same path as the main Chat UI (tools, exec, browser…).
  const viaGw = await gatewayChat.run({
    instruction,
    system,
    agentId: agentId || rt.agentId || 'main',
    threadId,
    ownerKey,
  });
  if (viaGw.ok && viaGw.text) return viaGw;

  // Fallback: embedded local turn (no live gateway).
  const r = await oc.runAgent(message, { local: true, agentId });
  if (r.available && r.ok && r.text) {
    return { ok: true, text: r.text, provider: viaGw.error ? 'openclaw-local (gateway down)' : 'openclaw-local' };
  }
  const authError =
    /incorrect api key|invalid api key|invalid_api_key|unauthorized|no auth|missing api key|\b401\b(?!\s*[.,\d])/i.test(
      r.error || viaGw.error || '',
    );
  return { ok: false, available: !!r.available, authError, error: r.error || viaGw.error };
}

module.exports = { run };
