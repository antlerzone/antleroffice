// Auto-describe a skill (block 3).
//
// When the Human Resource agent authors a skill it should ship with a one-line
// `description` — shown on the agent detail page and used as source material for
// the COO's update notice. This helper turns a skill's `system` prompt into that
// line. It uses the configured LLM brain when available and falls back to a plain
// heuristic (first sentence of the instructions) otherwise, so it never blocks
// skill creation and never requires an API key.

const store = require('./store');
const { runBrain } = require('./llm');

function heuristicDescribe(system, name) {
  const text = String(system || '').replace(/\s+/g, ' ').trim();
  if (!text) return name ? `${name}.` : '';
  // Take the first sentence-ish chunk and cap the length.
  const first = text.split(/(?<=[.!?。！？])\s/)[0] || text;
  return first.slice(0, 160).trim();
}

/**
 * Produce a short description for a skill.
 * @param {string} system   The skill's instruction/system prompt.
 * @param {object} [opts]
 * @param {string} [opts.name]      Skill name (for context / fallback).
 * @param {string} [opts.existing]  An already-provided description — respected as-is.
 * @returns {Promise<string>}
 */
async function autoDescribeSkill(system, { name = '', existing = '' } = {}) {
  const cur = String(existing || '').trim();
  if (cur) return cur; // never overwrite an explicit description
  const sys = String(system || '').trim();
  if (!sys) return '';

  try {
    const settings = store.readSettings();
    const brain =
      settings.npcBrains?.human_resource || { mode: 'ai', provider: settings.defaultProvider };
    const provider = brain?.provider || settings.defaultProvider;
    const cfg = settings.providers?.[provider];
    if (!provider || provider === 'demo' || !cfg?.apiKey) {
      return heuristicDescribe(sys, name);
    }
    const { text } = await runBrain({
      settings,
      brain,
      tier: 'light',
      system:
        'Summarize what this office-worker skill does in ONE short plain-English line ' +
        '(max ~20 words), for non-technical users. No surrounding quotes.',
      prompt: `Skill name: ${name || '(unnamed)'}\nInstructions:\n${sys.slice(0, 1200)}`,
    });
    const line = String(text || '').replace(/\s+/g, ' ').trim();
    return line ? line.slice(0, 200) : heuristicDescribe(sys, name);
  } catch {
    return heuristicDescribe(sys, name);
  }
}

module.exports = { autoDescribeSkill, heuristicDescribe };
