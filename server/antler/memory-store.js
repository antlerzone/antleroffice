// Persistent per-agent memory = AntlerOffice's local stand-in for the Hermes
// memory layer. Layered like Hermes Agent:
//   - facts (pinned "core memory", always injected)
//   - summaries (compressed task history)
//   - episodes (raw task logs, compressed when backlog grows)
// Retrieval uses BM25 with kind weighting (fact > summary > episode).

const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');

const KIND_WEIGHT = { fact: 2.5, summary: 1.5, episode: 1.0 };
const MAX_ENTRIES = 1000;
const COMPRESS_EPISODE_THRESHOLD = 60;
const COMPRESS_BATCH = 20;
const PINNED_CHAR_LIMIT = 800;
const RETRIEVED_CHAR_LIMIT = 800;

function memDir() {
  const dir = path.join(getDataDir(), 'memory');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function memPath(agentId) {
  const safe = String(agentId || 'shared').replace(/[^a-z0-9_:-]+/gi, '_');
  return path.join(memDir(), `${safe}.json`);
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

let seq = 0;
function memId() {
  return `m-${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

function isDuplicate(entries, text) {
  const norm = String(text || '').trim().toLowerCase();
  if (!norm) return true;
  return entries.slice(-80).some((e) => String(e.text || '').trim().toLowerCase() === norm);
}

// kind: 'fact' | 'episode' | 'summary'
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
  return item;
}

function clear(agentId) {
  try {
    fs.unlinkSync(memPath(agentId));
  } catch {
    /* nothing to clear */
  }
}

// ── BM25 over memory entries (kind-weighted, recency tie-break) ─────────────
const STOP = new Set('the a an and or of to in is are for on with as at by be this that it from your you we our i'.split(' '));

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, ' ')
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

function getRelevant(agentId, query, k = 4) {
  const entries = list(agentId).filter((e) => !(e.kind === 'fact' && e.pinned !== false));
  if (!entries.length) return [];
  const qTerms = [...new Set(tokenize(query))];
  if (!qTerms.length) return entries.slice(-k).reverse();

  const docs = entries.map((e) => ({ entry: e, terms: tokenize(e.text) }));
  const N = docs.length;
  const avgdl = docs.reduce((s, d) => s + d.terms.length, 0) / N || 1;
  const df = {};
  for (const term of qTerms) df[term] = docs.filter((d) => d.terms.includes(term)).length;

  const k1 = 1.5;
  const b = 0.75;
  const scored = docs.map((d) => {
    const dl = d.terms.length || 1;
    let score = KIND_WEIGHT[d.entry.kind] || 1;
    for (const term of qTerms) {
      const n = df[term];
      if (!n) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const tf = d.terms.filter((t) => t === term).length;
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / avgdl)));
    }
    return { entry: d.entry, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score || b2.entry.ts - a.entry.ts)
    .slice(0, k)
    .map((s) => s.entry);
}

function formatHits(hits, limitChars) {
  let out = '';
  for (const h of hits) {
    const block = `- (${h.kind}) ${h.text}\n`;
    if ((out + block).length > limitChars) break;
    out += block;
  }
  return out.trim();
}

function context(agentId, query, k = 4, limitChars = PINNED_CHAR_LIMIT + RETRIEVED_CHAR_LIMIT) {
  const pinned = getPinned(agentId, PINNED_CHAR_LIMIT);
  const hits = getRelevant(agentId, query, k);
  const retrieved = formatHits(hits, Math.max(200, limitChars - pinned.length - 32));

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

module.exports = {
  list,
  append,
  clear,
  getPinned,
  getRelevant,
  context,
  maybeCompressEpisodes,
};
