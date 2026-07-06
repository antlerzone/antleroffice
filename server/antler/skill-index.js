// Keyword + semantic hybrid skill index for on-demand loading (P1).
// Route: keywords first → semantic fallback (unrestricted only) → auto-learn keywords.

const { isRestricted } = require('./skill-restrictions');

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'is', 'are',
  'you', 'your', 'this', 'that', 'inside', 'department', 'agent', 'office', 'antleroffice',
  'skill', 'skills', 'use', 'when', 'from', 'be', 'do', 'not', '请', '帮', '我', '一下', '任务',
]);

const SEMANTIC_CANDIDATE_LIMIT = 8;
const DESC_CLIP = 160;
const semanticCache = new Map();
const SEMANTIC_CACHE_TTL_MS = 5 * 60 * 1000;

let semanticMatcherOverride = null;

function setSemanticMatcherForTests(fn) {
  semanticMatcherOverride = typeof fn === 'function' ? fn : null;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[\s_\-/.,;:()\[\]{}]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function inferKeywords(skill = {}) {
  const out = [];
  const seen = new Set();

  function add(raw) {
    const v = String(raw || '').trim();
    if (!v) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  }

  add(skill.name);
  if (skill.id && skill.id !== skill.name) {
    add(String(skill.id).replace(/_/g, ' '));
    add(String(skill.id).replace(/_/g, '-'));
  }

  for (const token of tokenize(skill.description)) {
    if (token.length >= 3) add(token);
  }

  const firstLine = String(skill.system || '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (firstLine) {
    for (const token of tokenize(firstLine)) {
      if (token.length >= 4) add(token);
      if (out.length >= 12) break;
    }
  }

  return out.slice(0, 12);
}

function resolveKeywords(skill = {}) {
  if (Array.isArray(skill.keywords) && skill.keywords.length) {
    return skill.keywords.map((k) => String(k).trim()).filter(Boolean);
  }
  return inferKeywords(skill);
}

function buildIndex(skills) {
  return (skills || [])
    .filter((s) => s && s.id)
    .map((skill) => ({ skill, keywords: resolveKeywords(skill) }));
}

const ROUTING_RULES = [
  'Routing order for extra skills:',
  '1) Keyword match in the task text loads the full skill immediately.',
  '2) If no keyword hit, semantic fallback may load unrestricted skills (never paid/gray-locked).',
  '3) Paid or gray-locked skills load ONLY on an exact keyword hit — never via semantic fallback.',
  '4) If still unmatched, use your own judgment or propose a new skill via the workshop.',
].join('\n');

function renderIndexBlock(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return '';

  const lines = [
    '## Additional skills (keyword index)',
    ROUTING_RULES,
    '',
  ];

  for (const { skill, keywords } of list) {
    const kw = keywords.length ? keywords.join(', ') : '(no keywords)';
    const label = skill.name || skill.id;
    const desc = skill.description ? ` — ${String(skill.description).slice(0, DESC_CLIP)}` : '';
    const tag = isRestricted(skill, { skillIds: [skill.id] }) ? '' : '';
    void tag;
    lines.push(`- [id:${skill.id}] [${kw}] → ${label}${desc}`);
  }

  return lines.join('\n');
}

function renderSemanticCatalog(entries) {
  return (entries || [])
    .slice(0, SEMANTIC_CANDIDATE_LIMIT)
    .map(({ skill }) => {
      const desc = skill.description ? String(skill.description).slice(0, DESC_CLIP) : '(no description)';
      return `- id:${skill.id} | ${skill.name || skill.id} | ${desc}`;
    })
    .join('\n');
}

function matchSkills(taskText, entries) {
  const text = String(taskText || '').toLowerCase();
  if (!text.trim()) return [];

  const matched = [];
  const seen = new Set();

  for (const entry of entries || []) {
    const { skill, keywords } = entry;
    if (!skill?.id) continue;
    const hit = (keywords || []).some((kw) => {
      const k = String(kw).toLowerCase().trim();
      return k.length >= 2 && text.includes(k);
    });
    if (!hit || seen.has(skill.id)) continue;
    seen.add(skill.id);
    matched.push(skill);
  }

  return matched;
}

function cacheKey(threadId, taskText) {
  const t = String(taskText || '').trim().slice(0, 400);
  return `${String(threadId || 'default')}::${t}`;
}

function getCachedSemantic(key) {
  const hit = semanticCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SEMANTIC_CACHE_TTL_MS) {
    semanticCache.delete(key);
    return null;
  }
  return hit.skills;
}

function setCachedSemantic(key, skills) {
  semanticCache.set(key, { skills, at: Date.now() });
}

function parseSkillIdsFromResponse(text, entries) {
  const allowed = new Set((entries || []).map((e) => e.skill?.id).filter(Boolean));
  const out = [];
  const raw = String(text || '').trim();
  if (!raw || !allowed.size) return out;

  try {
    const json = JSON.parse(raw);
    const ids = Array.isArray(json) ? json : json.skillIds || json.ids || [];
    for (const id of ids) {
      const sid = String(id || '').trim();
      if (allowed.has(sid) && !out.includes(sid)) out.push(sid);
    }
    if (out.length) return out;
  } catch {
    /* fall through */
  }

  for (const id of allowed) {
    if (raw.includes(id) && !out.includes(id)) out.push(id);
  }
  return out.slice(0, 3);
}

async function semanticMatch({ taskText, candidates, agent, threadId } = {}) {
  const entries = (candidates || []).slice(0, SEMANTIC_CANDIDATE_LIMIT);
  if (!entries.length || !String(taskText || '').trim()) {
    return { skills: [], aiCalled: false, fromCache: false };
  }

  const key = cacheKey(threadId, taskText);
  const cached = getCachedSemantic(key);
  if (cached) {
    return { skills: cached, aiCalled: false, fromCache: true };
  }

  if (semanticMatcherOverride) {
    const skills = await semanticMatcherOverride({ taskText, candidates: entries, agent, threadId });
    setCachedSemantic(key, skills);
    return { skills, aiCalled: true, fromCache: false };
  }

  const store = require('./store');
  const { runBrain } = require('./llm');
  const settings = store.readSettings();
  const brain =
    settings.npcBrains?.coo ||
    settings.npcBrains?.secretary || { mode: 'ai', provider: settings.defaultProvider };
  const provider = brain?.provider || settings.defaultProvider;
  const cfg = settings.providers?.[provider];
  if (!provider || provider === 'demo' || !cfg?.apiKey) {
    return { skills: [], aiCalled: false, fromCache: false };
  }

  const catalog = renderSemanticCatalog(entries);
  const { text, provider: used } = await runBrain({
    settings,
    brain,
    tier: 'light',
    system:
      'You pick office skills relevant to a task. Reply with JSON only: {"skillIds":["id1"]}. ' +
      'Pick zero or more skill ids from the catalog that are clearly needed. If none fit, return {"skillIds":[]}.',
    prompt: `Task:\n${String(taskText).slice(0, 800)}\n\nSkill catalog:\n${catalog}`,
  });

  if (used === 'demo') return { skills: [], aiCalled: false, fromCache: false };

  const ids = parseSkillIdsFromResponse(text, entries);
  const skills = ids.map((id) => entries.find((e) => e.skill.id === id)?.skill).filter(Boolean);
  setCachedSemantic(key, skills);
  return { skills, aiCalled: true, fromCache: false };
}

function extractChinesePhrases(text, max = 3) {
  const raw = String(text || '');
  const scored = [];
  const stop = new Set(['帮我', '请帮', '一篇', '写一', '任务', '一下']);
  for (let len = Math.min(6, raw.length); len >= 2; len--) {
    for (let i = 0; i <= raw.length - len; i++) {
      const phrase = raw.slice(i, i + len);
      if (!/^[\u4e00-\u9fff]+$/.test(phrase) || stop.has(phrase)) continue;
      scored.push({ phrase, len });
    }
  }
  scored.sort((a, b) => b.len - a.len);
  const out = [];
  const seen = new Set();
  for (const { phrase } of scored) {
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    out.push(phrase);
    if (out.length >= max) break;
  }
  return out;
}

function suggestKeywordsFromTask(taskText, existingKeywords = []) {
  const existing = new Set((existingKeywords || []).map((k) => String(k).toLowerCase()));
  const out = [];

  for (const phrase of extractChinesePhrases(taskText, 4)) {
    if (existing.has(phrase.toLowerCase())) continue;
    out.push(phrase);
    if (out.length >= 3) return out;
  }

  for (const token of tokenize(taskText)) {
    if (token.length < 4 || existing.has(token)) continue;
    out.push(token);
    if (out.length >= 3) break;
  }

  return out.slice(0, 3);
}

function persistLearnedKeywords(skillId, newKeywords) {
  if (!skillId || !newKeywords?.length) return null;
  const registry = require('./registry-store');
  const skill = registry.listSkills().find((s) => s.id === skillId);
  if (!skill) return null;

  const merged = [];
  const seen = new Set();
  for (const k of [...resolveKeywords(skill), ...newKeywords]) {
    const v = String(k).trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(v);
  }

  // TODO(P1 overlay): persist keyword overlays in overlay layer instead of in-place updateSkill.
  return registry.updateSkill(skillId, { keywords: merged.slice(0, 24) });
}

async function resolveExtraSkillMatches({ taskText, indexEntries, agent, threadId } = {}) {
  const keywordMatched = matchSkills(taskText, indexEntries);
  const keywordIds = new Set(keywordMatched.map((s) => s.id));

  const unmatched = (indexEntries || []).filter((e) => e.skill?.id && !keywordIds.has(e.skill.id));
  const semanticCandidates = unmatched.filter((e) => !isRestricted(e.skill, agent));

  let semanticMatched = [];
  let aiCalled = false;

  if (semanticCandidates.length) {
    const result = await semanticMatch({
      taskText,
      candidates: semanticCandidates,
      agent,
      threadId,
    });
    semanticMatched = result.skills || [];
    aiCalled = result.aiCalled;

    for (const sk of semanticMatched) {
      const kws = suggestKeywordsFromTask(taskText, resolveKeywords(sk));
      if (kws.length) persistLearnedKeywords(sk.id, kws);
    }
  }

  return { keywordMatched, semanticMatched, aiCalled };
}

function withKeywords(skill = {}) {
  const keywords = resolveKeywords(skill);
  return { ...skill, keywords };
}

function clearSemanticCache() {
  semanticCache.clear();
}

module.exports = {
  inferKeywords,
  resolveKeywords,
  buildIndex,
  renderIndexBlock,
  matchSkills,
  semanticMatch,
  resolveExtraSkillMatches,
  suggestKeywordsFromTask,
  persistLearnedKeywords,
  withKeywords,
  setSemanticMatcherForTests,
  clearSemanticCache,
  ROUTING_RULES,
  SEMANTIC_CANDIDATE_LIMIT,
};
