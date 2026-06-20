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
  const mem = hermes.getContext(memoryKey, instruction);
  const knowledge = rag.context(memoryKey, instruction);
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
  let needsInput = false;
  if (agent.runtime !== 'demo') {
    const r = await openclaw.run({
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
      } else {
        note = `OpenClaw could not complete the run (${String(r.error || 'unknown').slice(0, 80)}). Showing a placeholder.`;
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

  return { ...result, needsBossInput: needsInput };
}

module.exports = { runTask };
