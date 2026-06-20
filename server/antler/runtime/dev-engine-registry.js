// Registry of dev engines: cursor, claude, codex.

const ENGINES = {
  cursor: () => require('./cursor-cli'),
  claude: () => require('./claude-cli'),
  codex: () => require('./codex-cli'),
};

function getEngine(name) {
  const key = String(name || '').trim().toLowerCase();
  const factory = ENGINES[key];
  if (!factory) return null;
  const mod = factory();
  return {
    name: key,
    probe: () => mod.probe(),
    hasAuth: () => (typeof mod.hasAuth === 'function' ? mod.hasAuth() : Promise.resolve(true)),
    runDev: (opts) => mod.runDev(opts),
    runReview: (opts) => mod.runReview(opts),
  };
}

function listEngineNames() {
  return Object.keys(ENGINES);
}

async function probeAll() {
  const out = {};
  for (const name of listEngineNames()) {
    const eng = getEngine(name);
    out[name] = await eng.probe();
    out[name].apiKeySet =
      typeof require(`./${name}-cli`).hasAuth === 'function'
        ? require(`./${name}-cli`).hasAuth()
        : false;
    if (name === 'codex') {
      out[name].authReady = await require('./codex-cli').hasCodexAuth();
    }
  }
  return out;
}

module.exports = { getEngine, listEngineNames, probeAll };
