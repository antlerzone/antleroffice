// Persistent per-agent memory = AntlerOffice's local stand-in for the Hermes
// memory layer. Layered like Hermes Agent:
//   - facts (pinned "core memory", always injected)
//   - summaries (compressed task history)
//   - episodes (raw task logs, compressed when backlog grows)
//
// Retrieval (UPGRADED):
//   - Semantic first: a local, free embedding model (see embeddings.js) ranks by
//     MEANING, so "退款要多久" matches an entry that says "回款周期" and synonyms
//     across 中文/English. Embeddings are computed lazily and cached on each
//     entry, then re-used.
//   - BM25 fallback: if the semantic model isn't available, fall back to the
//     original keyword ranking. Nothing breaks.
//   - Cross-agent sharing: an agent also sees OTHER agents' durable facts (e.g.
//     a customer preference the sales agent learned shows up for support),
//     tagged with their source. Each agent still writes to its own file.
//
// Public API: list/append/clear/getPinned/maybeCompressEpisodes stay synchronous
// (writers and HTTP routes are unchanged). Only getRelevant/context are async,
// because ranking by meaning needs to embed the query.

const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');
const embeddings = require('./embeddings');

const KIND_WEIGHT = { fact: 2.5, digest: 1.8, summary: 1.5, episode: 1.0 };
const MAX_ENTRIES = 1000;
const COMPRESS_EPISODE_THRESHOLD = 60;
const COMPRESS_BATCH = 20;
// Memory-tree layer 2 (OpenHuman-style): when summaries pile up, the oldest
// batch is folded into ONE higher-level "digest" entry. Tree shape:
//   episodes → summaries (existing) → digests (this layer)
const SUMMARY_CONSOLIDATE_THRESHOLD = 24;
const SUMMARY_CONSOLIDATE_BATCH = 12;
const PINNED_CHAR_LIMIT = 800;
const RETRIEVED_CHAR_LIMIT = 800;

function memDir() {
  const dir = path.join(getDataDir(), 'memory');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeKey(agentId) {
  return String(agentId || 'shared').replace(/[^a-z0-9_:-]+/gi, '_');
}

function memPath(agentId) {
  return path.join(memDir(), `${safeKey(agentId)}.json`);
}

function list(agentId) {
  try {
    const data = JSON.parse(fs.readFileSync(memPath(agentId), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function write(agentId, entries) {
  fs.writeFileSync(memPath(agentId), JSON.stringify(entries, null, 2), 'utf8');
  return entries;
}

// Every other agent's file key (for cross-agent fact sharing).
function otherAgentKeys(selfKey) {
  let files = [];
  try {
    files = fs.readdirSync(memDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const self = safeKey(selfKey);
  return files.map((f) => f.replace(/\.json$/, '')).filter((k) => k && k !== self);
}

let seq = 0;
function memId() {
  return `m-${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

function isDuplicate(entries, text) {
  const norm = String(text || '').trim().toLowerCase();
  if (!norm) return true;
  return entries.slice(-80).some((e) => String(e.text || '').trim().toLowerCase() === norm);
}

// kind: 'fact' | 'episode' | 'summary'. Stays synchronous — embeddings are added
// lazily at retrieval time so writers never have to await a model.
function append(agentId, { kind = 'episode', text = '', pinned } = {}) {
  const t = String(text || '').trim();
  if (!t) return null;
  const entries = list(agentId);
  if (isDuplicate(entries, t)) return null;

  const item = { id: memId(), kind, text: t, ts: Date.now() };
  if (kind === 'fact' && pinned !== false) item.pinned = true;

  entries.push(item);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  write(agentId, entries);
  maybeCompressEpisodes(agentId);
  // Fire-and-forget: layer-2 consolidation may call an LLM, so it must never
  // block (or fail) a synchronous append.
  maybeConsolidateSummaries(agentId).catch(() => {});
  return item;
}

function clear(agentId) {
  try {
    fs.unlinkSync(memPath(agentId));
  } catch {
    /* nothing to clear */
  }
}

// ── BM25 over memory entries (kind-weighted) — the fallback ranker ───────────
const STOP = new Set('the a an and or of to in is are for on with as at by be this that it from your you we our i'.split(' '));

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t));
}

function getPinned(agentId, limitChars = PINNED_CHAR_LIMIT) {
  const facts = list(agentId)
    .filter((e) => e.kind === 'fact' && e.pinned !== false)
    .sort((a, b) => b.ts - a.ts);
  if (!facts.length) return '';
  let out = '';
  for (const f of facts) {
    const block = `- ${f.text}\n`;
    if ((out + block).length > limitChars) break;
    out += block;
  }
  return out.trim();
}

// Build the candidate pool: the agent's own non-core entries + OTHER agents'
// durable (pinned) facts, each tagged with its source agent. Also makes sure
// every candidate has an embedding cached (lazily embeds + persists per file).
async function buildCandidates(agentId, { shared = true } = {}) {
  const selfKey = safeKey(agentId);
  const candidates = [];

  // Own entries: everything except own pinned facts (those go via getPinned).
  const own = list(agentId);
  let ownChanged = await ensureEmbeddings(own);
  if (ownChanged) write(agentId, own);
  for (const e of own) {
    if (e.kind === 'fact' && e.pinned !== false) continue;
    candidates.push({ entry: e, agent: selfKey, own: true });
  }

  // Shared: other agents' pinned facts (durable, low-noise, worth sharing).
  if (shared) {
    for (const otherKey of otherAgentKeys(selfKey)) {
      const entries = list(otherKey);
      const facts = entries.filter((e) => e.kind === 'fact' && e.pinned !== false);
      if (!facts.length) continue;
      const changed = await ensureEmbeddings(facts);
      if (changed) write(otherKey, entries); // facts are refs into entries
      for (const e of facts) candidates.push({ entry: e, agent: otherKey, own: false });
    }
  }

  return candidates;
}

// Lazily attach embeddings to any entries missing one. Returns true if changed.
async function ensureEmbeddings(entries) {
  let changed = false;
  for (const e of entries) {
    if (!e.emb && e.text) {
      const v = await embeddings.embed(e.text);
      if (v) { e.emb = v; changed = true; }
    }
  }
  return changed;
}

function bm25Rank(candidates, query, k) {
  const qTerms = [...new Set(tokenize(query))];
  if (!qTerms.length) {
    return candidates
      .slice()
      .sort((a, b) => b.entry.ts - a.entry.ts)
      .slice(0, k);
  }
  const docs = candidates.map((c) => ({ c, terms: tokenize(c.entry.text) }));
  const N = docs.length || 1;
  const avgdl = docs.reduce((s, d) => s + d.terms.length, 0) / N || 1;
  const df = {};
  for (const term of qTerms) df[term] = docs.filter((d) => d.terms.includes(term)).length;

  const k1 = 1.5;
  const b = 0.75;
  const scored = docs.map((d) => {
    const dl = d.terms.length || 1;
    // Kind weight MULTIPLIES the keyword-match score (it is NOT an additive
    // baseline) — otherwise a cross-agent fact with zero keyword overlap could
    // outrank a clearly relevant episode purely on its kind. Zero-match docs
    // score 0 and drop out below.
    let termScore = 0;
    for (const term of qTerms) {
      const n = df[term];
      if (!n) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const tf = d.terms.filter((t) => t === term).length;
      termScore += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / avgdl)));
    }
    const score = termScore * (KIND_WEIGHT[d.c.entry.kind] || 1);
    return { c: d.c, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score || b2.c.entry.ts - a.c.entry.ts)
    .slice(0, k)
    .map((s) => s.c);
}

// Semantic ranking by meaning (cosine), kind-weighted. Returns null when the
// query can't be embedded, so the caller falls back to BM25.
async function semanticRank(candidates, query, k) {
  const qv = await embeddings.embed(query);
  if (!qv) return null;
  const scored = [];
  for (const c of candidates) {
    if (!c.entry.emb) continue;
    const sim = embeddings.cosine(qv, c.entry.emb);
    scored.push({ c, score: sim * (KIND_WEIGHT[c.entry.kind] || 1) });
  }
  if (!scored.length) return null;
  return scored
    .sort((a, b) => b.score - a.score || b.c.entry.ts - a.c.entry.ts)
    .slice(0, k)
    .map((s) => s.c);
}

// Async: returns ranked candidate wrappers { entry, agent, own }. Semantic first,
// BM25 fallback. Includes cross-agent shared facts unless shared:false.
async function getRelevant(agentId, query, k = 4, opts = {}) {
  const candidates = await buildCandidates(agentId, opts);
  if (!candidates.length) return [];
  const semantic = await semanticRank(candidates, query, k);
  return semantic || bm25Rank(candidates, query, k);
}

function formatHits(hits, limitChars, selfKey) {
  let out = '';
  for (const h of hits) {
    const e = h.entry;
    const src = h.own === false && h.agent && h.agent !== selfKey ? ` · from ${h.agent}` : '';
    const block = `- (${e.kind}${src}) ${e.text}\n`;
    if ((out + block).length > limitChars) break;
    out += block;
  }
  return out.trim();
}

// Async: assembled context block = own core memory (pinned) + related memory
// (semantic/BM25, cross-agent).
async function context(agentId, query, k = 4, limitChars = PINNED_CHAR_LIMIT + RETRIEVED_CHAR_LIMIT) {
  const pinned = getPinned(agentId, PINNED_CHAR_LIMIT);
  const hits = await getRelevant(agentId, query, k);
  const retrieved = formatHits(hits, Math.max(200, limitChars - pinned.length - 32), safeKey(agentId));

  const parts = [];
  if (pinned) parts.push(`Core memory:\n${pinned}`);
  if (retrieved) parts.push(`Related memory:\n${retrieved}`);
  return parts.join('\n\n').trim();
}

// Roll up old episodes into one summary entry (keeps storage searchable).
function maybeCompressEpisodes(agentId) {
  const entries = list(agentId);
  const episodes = entries.filter((e) => e.kind === 'episode');
  if (episodes.length < COMPRESS_EPISODE_THRESHOLD) return false;

  const toCompress = episodes.slice(0, COMPRESS_BATCH);
  const ids = new Set(toCompress.map((e) => e.id));
  const bullets = toCompress
    .map((e) => {
      const taskMatch = e.text.match(/^Task:\s*(.+?)(?:\n|$)/s);
      const line = taskMatch ? taskMatch[1] : e.text;
      return `• ${String(line).replace(/\s+/g, ' ').slice(0, 100)}`;
    })
    .join('\n');

  const from = new Date(toCompress[0].ts).toISOString().slice(0, 10);
  const to = new Date(toCompress[toCompress.length - 1].ts).toISOString().slice(0, 10);
  const summary = {
    id: memId(),
    kind: 'summary',
    text: `Compressed ${toCompress.length} past tasks (${from} – ${to}):\n${bullets}`,
    ts: Date.now(),
  };

  write(agentId, entries.filter((e) => !ids.has(e.id)).concat(summary));
  return true;
}

// ── Memory tree layer 2: summaries → digest ─────────────────────────────────
// Without this, summaries grow forever and retrieval noise creeps back in.
// LLM path (cheap "light" model) writes a clean thematic digest; if no key is
// configured we fall back to a deterministic merge, so nothing depends on AI.

function heuristicDigest(batch) {
  const seen = new Set();
  const lines = [];
  for (const e of batch) {
    for (const raw of String(e.text || '').split('\n')) {
      const line = raw.replace(/^[-•]\s*/, '').replace(/\s+/g, ' ').trim();
      if (!line || line.startsWith('Compressed ')) continue;
      const key = line.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`• ${line.slice(0, 110)}`);
      if (lines.length >= 10) return lines.join('\n');
    }
  }
  return lines.join('\n');
}

async function maybeConsolidateSummaries(agentId) {
  const summaries = list(agentId).filter((e) => e.kind === 'summary');
  if (summaries.length < SUMMARY_CONSOLIDATE_THRESHOLD) return false;

  const batch = summaries
    .slice()
    .sort((a, b) => a.ts - b.ts)
    .slice(0, SUMMARY_CONSOLIDATE_BATCH);
  const from = new Date(batch[0].ts).toISOString().slice(0, 10);
  const to = new Date(batch[batch.length - 1].ts).toISOString().slice(0, 10);

  let body = '';
  try {
    // Lazy requires avoid a circular dependency (memory-record → llm → …).
    const store = require('./store');
    const { runBrain } = require('./llm');
    const settings = store.readSettings();
    const provider = settings.defaultProvider;
    const cfg = settings.providers?.[provider];
    if (provider && provider !== 'demo' && cfg?.apiKey) {
      const { text, provider: used } = await runBrain({
        settings,
        brain: { mode: 'ai', provider },
        tier: 'light',
        system:
          'Merge these task summaries into ONE digest of at most 8 bullet lines. ' +
          'Group by theme, keep concrete names, dates, amounts and decisions, drop routine noise. ' +
          'Answer in the dominant language of the input. Bullets only, no preamble.',
        prompt: batch.map((e) => `- ${String(e.text).slice(0, 400)}`).join('\n'),
      });
      if (used !== 'demo') body = String(text || '').trim();
    }
  } catch {
    /* fall through to heuristic */
  }
  if (!body) body = heuristicDigest(batch);
  if (!body) return false;

  // Re-read: appends may have happened while the LLM was running.
  const ids = new Set(batch.map((e) => e.id));
  const entries = list(agentId);
  const digest = {
    id: memId(),
    kind: 'digest',
    text: `Digest ${from} – ${to} (${batch.length} summaries):\n${body.slice(0, 1200)}`,
    ts: Date.now(),
  };
  write(agentId, entries.filter((e) => !ids.has(e.id)).concat(digest));
  return true;
}

module.exports = {
  list,
  append,
  clear,
  getPinned,
  getRelevant,
  context,
  maybeCompressEpisodes,
  maybeConsolidateSummaries,
};
