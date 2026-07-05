// Runtime adapter: the single entry point agent-runtime.js uses to actually
// "run" an NPC. AntlerOffice never reasons itself — it gathers context (memory +
// learned knowledge) and relays the task to OpenClaw (the real executor), then
// records the outcome back into memory. Falls back to the local demo executor
// when OpenClaw is absent so the office still works before install.

const rag = require('../rag');
const hermes = require('./hermes');
const demo = require('./demo');
const openclaw = require('./openclaw');
const materials = require('../materials.cjs');

// --- Executor retry policy (error recovery) -------------------------------
// A transient gateway hiccup (chat.send failed, gateway restarting) should be
// retried before we fall back to the demo/placeholder path. We do NOT retry:
//  - auth errors / boss-input asks (retrying won't help),
//  - timeouts (the run may still be executing server-side; re-sending could
//    double-execute side effects like posting or emailing),
//  - "not available" (OpenClaw not installed — nothing to retry).
const OPENCLAW_RETRY_DELAYS_MS = [2000, 5000];

function isRetryableOpenclawFailure(r) {
  if (!r || r.ok) return false;
  if (!r.available) return false;
  if (r.authError || r.needsBossInput) return false;
  if (/timed out/i.test(String(r.error || ''))) return false;
  return true;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOpenclawWithRetry(params) {
  let r = await openclaw.run(params);
  for (const delay of OPENCLAW_RETRY_DELAYS_MS) {
    if (!isRetryableOpenclawFailure(r)) return r;
    await sleepMs(delay);
    r = await openclaw.run(params);
  }
  return r;
}
// ---------------------------------------------------------------------------

// agent: { id, role, runtime, userAgentId }. memoryKey scopes memory + knowledge
// to a user-created agent when present, else the department role.
async function runTask({ agent = {}, instruction, system = '', mcpServers = [], threadId, ownerKey } = {}) {
  const memoryKey = agent.userAgentId || agent.role || agent.id || 'shared';
  const { formatMcpServersBlock, formatOpenClawBuiltinToolsBlock } = require('../mcp-runtime-helper');
  const { bossInputEscalationBlock } = require('../agent-outcome');
  const mcpBlock = formatMcpServersBlock(mcpServers);
  const builtinTools =
    agent.role === 'ceo' || agent.role === 'coo' || agent.id === 'ceo' || agent.id === 'coo'
      ? formatOpenClawBuiltinToolsBlock()
      : '';

  // 1) Gather context: relevant long-term memory + retrieved knowledge chunks.
  const mem = await hermes.getContext(memoryKey, instruction);
  const knowledge = await rag.context(memoryKey, instruction);
  const materialsRoot = materials.getRootPath();
  const fullSystem = [
    system,
    bossInputEscalationBlock(),
    builtinTools,
    mcpBlock,
    mem && `Relevant memory:\n${mem}`,
    knowledge && `Relevant knowledge:\n${knowledge}`,
    `Office materials library (read/write files here when the task needs shared assets):\n${materialsRoot}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  // 2) Execute. Try OpenClaw unless the NPC is explicitly pinned to demo.
  let result = null;
  let note = '';
  let failError = '';
  let needsInput = false;
  let skipMemory = false;
  if (agent.runtime !== 'demo') {
    const r = await runOpenclawWithRetry({
      instruction,
      system: fullSystem,
      agentId: agent.openclawAgentId,
      threadId,
      ownerKey,
    });
    if (r.ok) {
      result = { text: r.text, provider: r.provider };
      needsInput = !!r.needsBossInput;
    } else if (r.available) {
      const { needsBossInput, bossInputAskMessage } = require('../agent-outcome');
      if (r.authError || r.needsBossInput) {
        result = {
          text: bossInputAskMessage({ agentLabel: agent.label || agent.role || 'Agent', provider: 'openclaw' }),
          provider: 'openclaw',
        };
        needsInput = true;
        skipMemory = true; // canned "need your key" ask — not a real outcome
      } else {
        failError = String(r.error || 'unknown');
        note = `OpenClaw could not complete the run after retries (${failError.slice(0, 80)}). Showing a placeholder.`;
      }
    }
  }
  if (!result) {
    const r = await demo.run({ role: agent.role, system: fullSystem, prompt: instruction, note });
    result = { text: r.text, provider: r.provider };
  }

  const { needsBossInput: detectBossInput } = require('../agent-outcome');
  if (!needsInput) needsInput = detectBossInput(result.text, { authError: false });

  // 3) Remember the outcome: summarize + extract facts (not raw episode dumps).
  // Skip placeholder results (provider 'demo' = no real work happened) — otherwise
  // the NPC "remembers" completing tasks it never actually did (memory poisoning).
  if (result.provider !== 'demo' && !skipMemory) {
    try {
      await hermes.recordAfterTask(memoryKey, {
        instruction,
        resultText: result.text,
        role: agent.role || agent.id,
      });
    } catch {
      hermes.record(memoryKey, {
        kind: 'summary',
        text: `Completed: ${String(instruction).slice(0, 120)}`,
      });
    }
  }

  // degraded = execution actually failed and `text` is only a placeholder
  // (NOT the case when the boss's own key produced a real fallback answer).
  const degraded = !!failError && result.provider === 'demo';
  return { ...result, needsBossInput: needsInput, degraded, degradedError: degraded ? failError : '' };
}

module.exports = { runTask, isRetryableOpenclawFailure, runOpenclawWithRetry };
