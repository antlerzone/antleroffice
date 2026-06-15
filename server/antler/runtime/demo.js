// Demo executor = the local llm.js path. Used only before OpenClaw is set up
// (or when an NPC is explicitly set to the 'demo' runtime). If the boss has put
// an API key in Settings it will answer for real; otherwise a placeholder.

const { runBrain } = require('../llm');
const store = require('../store');

async function run({ role, system, prompt, note }) {
  const settings = store.readSettings();
  const brain = settings.npcBrains?.[role] || { mode: 'ai', provider: settings.defaultProvider };
  const { text, provider } = await runBrain({ settings, brain, system, prompt, note });
  return { ok: true, text, provider: provider === 'demo' ? 'demo' : `demo:${provider}` };
}

module.exports = { run };
