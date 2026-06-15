// OpenClaw executor. OpenClaw does the real reasoning + execution using the
// user's own API key (configured through AntlerOffice's UI). We hand it the
// task plus the context AntlerOffice gathered (memory + knowledge) and return
// its plain-text result. CLI-first; optional gateway HTTP if configured.

const oc = require('../openclaw-config');
const store = require('../store');

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
    if (text) return { ok: true, text: String(text).trim(), provider: 'openclaw' };
  } catch {
    /* gateway not reachable -> fall back to CLI */
  }
  return null;
}

// Returns { ok, text, provider } on success, or { ok:false, available } so the
// caller can fall back to demo when OpenClaw isn't installed/reachable.
async function run({ instruction, system, agentId }) {
  const rt = store.readSettings().runtimes?.openclaw || {};
  const message = system ? `Context:\n${system}\n\n---\nTask: ${instruction}` : instruction;

  if (rt.mode === 'gateway') {
    const viaHttp = await tryGateway(rt, message);
    if (viaHttp) return viaHttp;
  }

  // Always run embedded (`--local`): the `openclaw agent` gateway WS is flaky
  // (intermittent 1006 closures) and embedded reads the same auth store. Each
  // hired NPC runs as its own OpenClaw agent; the built-in COO uses the default.
  const r = await oc.runAgent(message, { local: true, agentId });
  if (r.available && r.ok && r.text) return { ok: true, text: r.text, provider: 'openclaw' };
  const authError =
    /incorrect api key|invalid api key|invalid_api_key|unauthorized|no auth|missing api key|\b401\b(?!\s*[.,\d])/i.test(
      r.error || '',
    );
  return { ok: false, available: !!r.available, authError, error: r.error };
}

module.exports = { run };
