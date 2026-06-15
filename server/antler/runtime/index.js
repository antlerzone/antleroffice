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
async function runTask({ agent = {}, instruction, system = '', mcpServers = [] }) {
  const memoryKey = agent.userAgentId || agent.role || agent.id || 'shared';
  const { formatMcpServersBlock } = require('../mcp-runtime-helper');
  const mcpBlock = formatMcpServersBlock(mcpServers);

  // 1) Gather context: relevant long-term memory + retrieved knowledge chunks.
  const mem = hermes.getContext(memoryKey, instruction);
  const knowledge = rag.context(memoryKey, instruction);
  const materialsRoot = materials.getRootPath();
  const fullSystem = [
    system,
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
  if (agent.runtime !== 'demo') {
    const r = await openclaw.run({ instruction, system: fullSystem, agentId: agent.openclawAgentId });
    if (r.ok) result = { text: r.text, provider: r.provider };
    else if (r.available) {
      // OpenClaw is installed but the run failed — be honest about why instead
      // of pretending no key is set. Most common: an invalid/expired API key.
      note = r.authError
        ? 'OpenClaw API key was rejected (401). Update it in Settings → Integrations, then try again.'
        : `OpenClaw could not complete the run (${String(r.error || 'unknown').slice(0, 80)}). Showing a placeholder.`;
    }
  }
  if (!result) {
    const r = await demo.run({ role: agent.role, system: fullSystem, prompt: instruction, note });
    result = { text: r.text, provider: r.provider };
  }

  // 3) Remember the outcome so the agent learns across tasks/restarts.
  hermes.record(memoryKey, {
    kind: 'episode',
    text: `Task: ${instruction}\nResult: ${String(result.text).slice(0, 400)}`,
  });

  return result;
}

module.exports = { runTask };
