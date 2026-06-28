// Local semantic embeddings — free, on-device, no API calls.
//
// Uses @xenova/transformers (Transformers.js / ONNX) to run a small multilingual
// sentence model entirely inside Node. First use downloads & caches the model
// once (~tens of MB); after that it's fully local and costs nothing per call.
// The model is multilingual, so it understands 中文 and English in one space.
//
// Graceful degrade: if the package or model can't load, embed() returns null and
// callers fall back to keyword (BM25) search — same philosophy as the
// stealth-browser drop-in. Nothing breaks when semantic mode is unavailable.

const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'; // 384-dim, 中文+EN

let _extractorPromise = null;
let _disabled = false;

async function getExtractor() {
  if (_disabled) return null;
  if (_extractorPromise) return _extractorPromise;
  _extractorPromise = (async () => {
    try {
      const { pipeline, env } = require('@xenova/transformers');
      env.allowLocalModels = true; // reuse a cached copy if present
      const extractor = await pipeline('feature-extraction', MODEL);
      try { console.log('[embeddings] local semantic model ready:', MODEL); } catch { /* ignore */ }
      return extractor;
    } catch (e) {
      _disabled = true;
      const msg = e && e.message ? String(e.message).slice(0, 100) : String(e);
      try { console.log('[embeddings] semantic model unavailable → keyword search. (' + msg + ')'); } catch { /* ignore */ }
      return null;
    }
  })();
  return _extractorPromise;
}

// Round to keep stored vectors compact in JSON without hurting cosine accuracy.
function compact(arr) {
  return arr.map((x) => Math.round(x * 1e5) / 1e5);
}

// Returns a number[] embedding, or null when semantic mode is unavailable.
async function embed(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const extractor = await getExtractor();
  if (!extractor) return null;
  try {
    const out = await extractor(t, { pooling: 'mean', normalize: true });
    return compact(Array.from(out.data));
  } catch {
    return null;
  }
}

// Cosine similarity. Vectors are normalized on creation, so this is effectively
// a dot product, but we keep the full formula for safety.
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function isAvailable() {
  return !!(await getExtractor());
}

module.exports = { embed, cosine, isAvailable, MODEL };
