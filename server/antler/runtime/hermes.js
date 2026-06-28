// Hermes layer = memory capability. Local memory-store is the stand-in until the
// real Hermes memory API is wired (settings.runtimes.hermes). Interface:
//   getContext(memoryKey, query) — inject before tasks
//   recordAfterTask(...)         — summarize + extract facts after tasks

const memory = require('../memory-store');
const { recordAfterTask } = require('../memory-record');

// Async now: ranking by meaning needs to embed the query (see memory-store).
async function getContext(memoryKey, query) {
  return memory.context(memoryKey, query);
}

function record(memoryKey, entry) {
  return memory.append(memoryKey, entry);
}

module.exports = { getContext, record, recordAfterTask };
