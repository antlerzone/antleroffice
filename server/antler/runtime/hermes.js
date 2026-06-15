// Hermes layer = memory capability. For now AntlerOffice's local memory-store
// IS the Hermes stand-in: it gathers relevant memories before a task and records
// an episode after. When the real Hermes memory API is provided, wire it here
// (settings.runtimes.hermes) while keeping this same interface.

const memory = require('../memory-store');

function getContext(memoryKey, query) {
  return memory.context(memoryKey, query);
}

function record(memoryKey, entry) {
  return memory.append(memoryKey, entry);
}

module.exports = { getContext, record };
