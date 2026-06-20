// Post-task memory writer: summarize outcomes and extract durable facts
// instead of appending raw 400-char episode dumps.

const memory = require('./memory-store');
const store = require('./store');
const { runBrain } = require('./llm');

function parseJsonFromLLM(text) {
  const raw = String(text || '').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

function heuristicRecord(memoryKey, instruction, resultText) {
  const compact = String(resultText).replace(/\s+/g, ' ').trim().slice(0, 200);
  memory.append(memoryKey, {
    kind: 'summary',
    text: `Completed: ${String(instruction).slice(0, 120)} → ${compact}`,
  });
}

async function recordAfterTask(memoryKey, { instruction, resultText, role = 'ceo' } = {}) {
  const task = String(instruction || '').trim();
  const result = String(resultText || '').trim();
  if (!task && !result) return;

  const settings = store.readSettings();
  const brain = settings.npcBrains?.[role] || { mode: 'ai', provider: settings.defaultProvider };
  const provider = brain?.provider || settings.defaultProvider;
  const cfg = settings.providers?.[provider];
  const hasKey = provider && provider !== 'demo' && cfg?.apiKey;

  if (!hasKey) {
    heuristicRecord(memoryKey, task, result);
    return;
  }

  try {
    const { text } = await runBrain({
      settings,
      brain,
      system:
        'Extract durable memory from an agent task log. Reply with JSON only: ' +
        '{"summary":"one concise sentence","facts":["optional fact",...]}. ' +
        'facts: max 2 short items worth remembering next time (preferences, names, decisions). ' +
        'Use empty facts array when nothing durable.',
      prompt: `Task:\n${task.slice(0, 600)}\n\nResult:\n${result.slice(0, 1000)}`,
    });

    const parsed = parseJsonFromLLM(text);
    if (parsed?.summary) {
      memory.append(memoryKey, { kind: 'summary', text: String(parsed.summary).trim() });
    } else {
      heuristicRecord(memoryKey, task, result);
    }

    if (Array.isArray(parsed?.facts)) {
      for (const f of parsed.facts.slice(0, 2)) {
        const t = String(f || '').trim();
        if (t.length >= 8) memory.append(memoryKey, { kind: 'fact', text: t, pinned: true });
      }
    }
  } catch {
    heuristicRecord(memoryKey, task, result);
  }
}

module.exports = { recordAfterTask };
