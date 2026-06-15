// Persistent per-agent memory = AntlerOffice's local stand-in for the Hermes
// memory layer. Each agent remembers facts, past tasks (episodes) and summaries
// across restarts, and the runtime injects the most relevant memories before a
// task and appends a new episode after. Swaps to the real Hermes memory API
// once its endpoints are known (see server/runtime/hermes.js).

const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');

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

// kind: 'fact' | 'episode' | 'summary'
function append(agentId, { kind = 'episode', text = '' } = {}) {
  const t = String(text || '').trim();
  if (!t) return null;
  const entries = list(agentId);
  const item = { id: memId(), kind, text: t, ts: Date.now() };
  entries.push(item);
  if (entries.length > 1000) entries.splice(0, entries.length - 1000);
  write(agentId, entries);
  return item;
}

function clear(agentId) {
  try {
    fs.unlinkSync(memPath(agentId));
  } catch {
    /* nothing to clear */
  }
}

// ── BM25 over memory entries (recency-tie-broken) ───────────────────────────
const STOP = new Set('the a an and or of to in is are for on with as at by be this that it from your you we our i'.split(' '));
function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t));
}

function getRelevant(agentId, query, k = 4) {
  const entries = list(agentId);
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
    let score = 0;
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

function context(agentId, query, k = 4, limitChars = 1200) {
  const hits = getRelevant(agentId, query, k);
  if (!hits.length) return '';
  let out = '';
  for (const h of hits) {
    const block = `- (${h.kind}) ${h.text}\n`;
    if ((out + block).length > limitChars) break;
    out += block;
  }
  return out.trim();
}

module.exports = { list, append, clear, getRelevant, context };
