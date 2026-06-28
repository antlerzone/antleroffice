// Fully-local RAG: split fed documents into chunks and retrieve the most
// relevant ones for a query. This is what turns "drag in a PDF/URL" into focused
// context for OpenClaw, instead of dumping whole files into the prompt.
//
// Retrieval (UPGRADED):
//   - Semantic first: the same free local embedding model as memory (see
//     embeddings.js) ranks chunks by MEANING, so "退款要多久" finds a chunk that
//     says "回款周期" even with no shared keywords, across 中文/English.
//     Embeddings are computed lazily per chunk and cached.
//   - BM25 fallback: if the model isn't available, fall back to the original
//     keyword ranking. Nothing breaks.
//   Knowledge stays per-agent (a PDF dragged to one agent is NOT shared with
//   others — unlike memory facts).
//
// index/listSources/removeSource/clear stay synchronous (HTTP routes unchanged);
// only retrieve/context are async, because ranking by meaning embeds the query.
//
// Per-agent store lives at data/knowledge/<agentId>/chunks.json.

const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');
const embeddings = require('./embeddings');

function agentDir(agentId) {
  const dir = path.join(getDataDir(), 'knowledge', String(agentId).replace(/[^a-z0-9_:-]+/gi, '_'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function chunksPath(agentId) {
  return path.join(agentDir(agentId), 'chunks.json');
}

function readChunks(agentId) {
  try {
    const data = JSON.parse(fs.readFileSync(chunksPath(agentId), 'utf8'));
    return Array.isArray(data.chunks) ? data.chunks : [];
  } catch {
    return [];
  }
}

function writeChunks(agentId, chunks) {
  fs.writeFileSync(chunksPath(agentId), JSON.stringify({ chunks }, null, 2), 'utf8');
  return chunks;
}

// Split text into ~maxChars windows on sentence/paragraph boundaries with a
// small overlap so context isn't lost across the seam.
function chunk(text, maxChars = 800, overlap = 120) {
  const clean = String(text || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
  if (!clean) return [];
  const paras = clean.split(/\n{2,}/);
  const out = [];
  let buf = '';
  const flush = () => {
    const t = buf.trim();
    if (t) out.push(t);
    buf = '';
  };
  for (const p of paras) {
    if ((buf + '\n\n' + p).length <= maxChars) {
      buf = buf ? `${buf}\n\n${p}` : p;
      continue;
    }
    flush();
    if (p.length <= maxChars) {
      buf = p;
    } else {
      // Hard-wrap an oversized paragraph with overlap.
      for (let i = 0; i < p.length; i += maxChars - overlap) {
        out.push(p.slice(i, i + maxChars).trim());
      }
    }
  }
  flush();
  return out.filter(Boolean);
}

let seq = 0;
function chunkId() {
  return `c-${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

// Add a source's text as chunks. Re-indexing the same source replaces its old
// chunks so edits/removals stay consistent.
function index(agentId, source, text) {
  const pieces = chunk(text);
  if (!pieces.length) return { added: 0 };
  const existing = readChunks(agentId).filter((c) => c.source !== source);
  const added = pieces.map((t) => ({ id: chunkId(), source, text: t }));
  writeChunks(agentId, existing.concat(added));
  return { added: added.length };
}

function removeSource(agentId, source) {
  writeChunks(agentId, readChunks(agentId).filter((c) => c.source !== source));
}

function listSources(agentId) {
  const counts = {};
  for (const c of readChunks(agentId)) counts[c.source] = (counts[c.source] || 0) + 1;
  return Object.entries(counts).map(([source, chunks]) => ({ source, chunks }));
}

function clear(agentId) {
  try {
    fs.unlinkSync(chunksPath(agentId));
  } catch {
    /* nothing to clear */
  }
}

// ── BM25 retrieval ──────────────────────────────────────────────────────────
const STOP = new Set(
  'the a an and or of to in is are for on with as at by be this that it from your you we our i'.split(' '),
);

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t));
}

// Lazily attach embeddings to any chunks missing one. Returns true if changed.
async function ensureEmbeddings(chunks) {
  let changed = false;
  for (const c of chunks) {
    if (!c.emb && c.text) {
      const v = await embeddings.embed(c.text);
      if (v) { c.emb = v; changed = true; }
    }
  }
  return changed;
}

function bm25Retrieve(chunks, query, k) {
  const qTerms = [...new Set(tokenize(query))];
  if (!qTerms.length) return [];

  const docs = chunks.map((c) => ({ chunk: c, terms: tokenize(c.text) }));
  const N = docs.length;
  const avgdl = docs.reduce((s, d) => s + d.terms.length, 0) / N || 1;

  const df = {};
  for (const term of qTerms) {
    df[term] = docs.filter((d) => d.terms.includes(term)).length;
  }

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
    return { chunk: d.chunk, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, k)
    .map((s) => s.chunk);
}

// Semantic ranking by meaning (cosine). Returns null when the query can't be
// embedded or no chunk has an embedding yet, so the caller falls back to BM25.
async function semanticRetrieve(chunks, query, k) {
  const qv = await embeddings.embed(query);
  if (!qv) return null;
  const scored = [];
  for (const c of chunks) {
    if (!c.emb) continue;
    scored.push({ chunk: c, score: embeddings.cosine(qv, c.emb) });
  }
  if (!scored.length) return null;
  return scored
    .sort((a, b2) => b2.score - a.score)
    .slice(0, k)
    .map((s) => s.chunk);
}

// Async: semantic-first, BM25 fallback. Lazily embeds + caches chunk vectors.
async function retrieve(agentId, query, k = 4) {
  const chunks = readChunks(agentId);
  if (!chunks.length) return [];
  if (await ensureEmbeddings(chunks)) writeChunks(agentId, chunks);
  const semantic = await semanticRetrieve(chunks, query, k);
  return semantic || bm25Retrieve(chunks, query, k);
}

// Build a compact context block from the top chunks for a query.
async function context(agentId, query, k = 4, limitChars = 2400) {
  const hits = await retrieve(agentId, query, k);
  if (!hits.length) return '';
  let out = '';
  for (const h of hits) {
    const block = `\n[${h.source}]\n${h.text}\n`;
    if ((out + block).length > limitChars) break;
    out += block;
  }
  return out.trim();
}

module.exports = { chunk, index, removeSource, listSources, clear, retrieve, context };
