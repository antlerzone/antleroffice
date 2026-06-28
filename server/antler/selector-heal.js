// Self-healing element location for Junior's website playback.
//
// Problem: a recorded step pins ONE primary selector; when a site is redesigned
// that selector breaks and the step stalls. This module "tries other ways to
// recognise the element" in a reliability order, AND — the part the old code
// lacked — VERIFIES each candidate actually matches the recorded element before
// clicking. The most dangerous outcome is not "element not found" but "found the
// WRONG element and clicked it anyway", so every hit must clear a confidence bar.
//
// Order (B1):  override (learned) → id → name → other selector candidates →
//              role+name → exact text → fuzzy text → recorded coordinates.
// Coordinates are a last resort and only used when the element still at that
// point looks like the recorded one (structure basically unchanged).
//
// Self-heal writeback (B4): when a non-primary candidate succeeds, the working
// selector is saved to an OVERLAY file (heal-overrides.json) — the original
// recording is never mutated — and the heal is logged. rollbackOverrides()
// restores the original behaviour in one call.

const fs = require('node:fs');
const path = require('node:path');

// How sure we must be that a located element IS the recorded one before we click
// or accept it. High on purpose: skipping (and asking a human) is safer than
// clicking the wrong thing.
const CONFIDENCE_MIN = 0.6;

// ── Confidence scoring (pure — no browser, fully unit-testable) ──────────────
function norm(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function roleOf(el) {
  return norm(el && el.role) || ({ a: 'link', button: 'button' }[norm(el && el.tag)] || '');
}

// Text similarity in [0,1]; null when neither side has text (no signal).
function textSim(a, b) {
  a = norm(a); b = norm(b);
  if (!a && !b) return null;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = new Set(a.split(' ')), tb = new Set(b.split(' '));
  let inter = 0;
  for (const x of ta) if (tb.has(x)) inter++;
  const union = new Set([...ta, ...tb]).size || 1;
  let j = inter / union;
  if (a.includes(b) || b.includes(a)) j = Math.max(j, 0.7);
  return j;
}

// recorded: { tag, role, text, label, name, id }
// observed: { tag, role, text, ariaLabel }  (read from the live candidate)
function scoreMatch(recorded = {}, observed = {}) {
  const parts = []; // [weight, value]
  const ts = textSim(recorded.text || recorded.label, observed.text || observed.ariaLabel);
  if (ts !== null) parts.push([0.6, ts]);

  const rr = roleOf(recorded), ro = roleOf(observed);
  if (rr || ro) parts.push([0.25, rr && ro ? (rr === ro ? 1 : 0) : 0.5]);

  const tgr = norm(recorded.tag), tgo = norm(observed.tag);
  if (tgr || tgo) parts.push([0.15, tgr && tgo ? (tgr === tgo ? 1 : 0) : 0.5]);

  if (!parts.length) return 0;
  const wsum = parts.reduce((s, [w]) => s + w, 0);
  return parts.reduce((s, [w, v]) => s + w * v, 0) / wsum;
}

const round = (x) => Math.round(x * 100) / 100;

// ── Overlay store (learned selectors) + heal log ────────────────────────────
function overridesPath(dir) { return path.join(dir, 'heal-overrides.json'); }
function healLogPath(dir) { return path.join(dir, 'heal-log.jsonl'); }

function readOverrides(dir) {
  try { return JSON.parse(fs.readFileSync(overridesPath(dir), 'utf8')) || {}; }
  catch { return {}; }
}
function writeOverride(dir, seq, descriptor) {
  const all = readOverrides(dir);
  all[String(seq)] = descriptor;
  fs.writeFileSync(overridesPath(dir), JSON.stringify(all, null, 2), 'utf8');
}
function rollbackOverrides(dir) {
  try { fs.unlinkSync(overridesPath(dir)); return true; } catch { return false; }
}
function logHeal(dir, entry) {
  try { fs.appendFileSync(healLogPath(dir), JSON.stringify(entry) + '\n', 'utf8'); } catch { /* non-fatal */ }
}
function readHealLog(dir) {
  try {
    return fs.readFileSync(healLogPath(dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

// ── Locator building (needs a Playwright/Patchright `page`) ──────────────────
function locFromDescriptor(page, d) {
  if (!d) return null;
  if (d.by === 'css') return page.locator(d.sel);
  if (d.by === 'role') return page.getByRole(d.role, { name: d.name, exact: false });
  if (d.by === 'text') return page.getByText(d.text, { exact: false });
  return null;
}

// Ordered candidate list. Each item: { level, method, descriptor, loc }.
function orderedCandidates(page, el, override) {
  const esc = (s) => String(s).replace(/(["\\])/g, '\\$1');
  const out = [];
  if (override) out.push({ level: 0, method: 'override', descriptor: override, loc: locFromDescriptor(page, override) });
  if (el.id) {
    const d = { by: 'css', sel: `[id="${esc(el.id)}"]` };
    out.push({ level: 1, method: 'id', descriptor: d, loc: locFromDescriptor(page, d) });
  }
  if (el.name) {
    const d = { by: 'css', sel: `[name="${esc(el.name)}"]` };
    out.push({ level: 2, method: 'name', descriptor: d, loc: locFromDescriptor(page, d) });
  }
  for (const sc of el.selector_candidates || []) {
    const d = { by: 'css', sel: sc };
    out.push({ level: 3, method: 'candidate', descriptor: d, loc: locFromDescriptor(page, d) });
  }
  const role = roleOf(el);
  if (role && el.text) {
    const d = { by: 'role', role, name: el.text };
    out.push({ level: 4, method: 'role+text', descriptor: d, loc: locFromDescriptor(page, d) });
  }
  if (el.text) {
    const d = { by: 'text', text: el.text };
    out.push({ level: 5, method: 'text', descriptor: d, loc: locFromDescriptor(page, d) });
  }
  return out.filter((c) => c.loc);
}

const FP_FN = (node) => ({
  tag: (node.tagName || '').toLowerCase(),
  role: node.getAttribute('role') || '',
  text: (node.innerText || node.textContent || '').trim().slice(0, 80),
  ariaLabel: node.getAttribute('aria-label') || '',
});

async function readFingerprint(loc) {
  try { return await loc.evaluate(FP_FN); } catch { return null; }
}
async function readFingerprintAtPoint(page, x, y) {
  try {
    return await page.evaluate(({ x: px, y: py, src }) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function('node', `return (${src})(node);`);
      const node = document.elementFromPoint(px, py);
      return node ? fn(node) : null;
    }, { x, y, src: FP_FN.toString() });
  } catch { return null; }
}

// Resolve + click the element for a recorded click event, with confidence gating.
// Returns one of:
//   { ok:true, healed, heal_level, method, confidence }
//   { ok:false, needsHuman:true, heal_level:null, method:'none', confidence:0 }
async function resolveClick(page, evt, opts = {}) {
  const el = evt.element || {};
  const dir = opts.workflowPath;
  const overrides = dir ? readOverrides(dir) : {};
  const override = overrides[String(evt.seq)];
  const candidates = orderedCandidates(page, el, override);

  for (const c of candidates) {
    try {
      if ((await c.loc.count()) !== 1) continue;
      if (!(await c.loc.isVisible())) continue;
      const observed = await readFingerprint(c.loc);
      const confidence = observed ? scoreMatch(el, observed) : 0;
      if (confidence < CONFIDENCE_MIN) continue; // verified mismatch → do NOT click
      await c.loc.click({ timeout: 3000 });
      const healed = c.level > 1;
      if (healed && dir) {
        logHeal(dir, { seq: evt.seq, method: c.method, level: c.level, confidence: round(confidence), ts: Date.now() });
        writeOverride(dir, evt.seq, c.descriptor); // self-heal: remember what worked
      }
      return { ok: true, healed, heal_level: c.level, method: c.method, confidence: round(confidence) };
    } catch {
      /* try next candidate */
    }
  }

  // Coordinate fallback — last resort, only if the element still there matches
  // (page structure basically unchanged), else hand off to a human.
  if (opts.allowCoordinates !== false && evt.mouse) {
    const observed = await readFingerprintAtPoint(page, evt.mouse.x, evt.mouse.y);
    const confidence = observed ? scoreMatch(el, observed) : 0;
    if (confidence >= CONFIDENCE_MIN) {
      await page.mouse.click(evt.mouse.x, evt.mouse.y);
      return { ok: true, healed: false, heal_level: 6, method: 'coordinates', confidence: round(confidence) };
    }
  }

  return { ok: false, needsHuman: true, heal_level: null, method: 'none', confidence: 0 };
}

module.exports = {
  CONFIDENCE_MIN,
  scoreMatch,
  textSim,
  roleOf,
  orderedCandidates,
  resolveClick,
  readOverrides,
  writeOverride,
  rollbackOverrides,
  logHeal,
  readHealLog,
};
