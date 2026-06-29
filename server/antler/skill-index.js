// Keyword index for on-demand skill loading (P1).
// Keeps a lightweight directory in the system prompt; full skill.system text is
// injected only when the current task text hits one of the skill's keywords.

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'for',
  'to',
  'of',
  'in',
  'on',
  'with',
  'is',
  'are',
  'you',
  'your',
  'this',
  'that',
  'inside',
  'department',
  'agent',
  'office',
  'antleroffice',
  'skill',
  'skills',
  'use',
  'when',
  'from',
  'be',
  'do',
  'not',
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[\s_\-/.,;:()[\]{}]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

/**
 * Fallback keywords when a skill has no explicit keywords field.
 * Uses skill name/id plus description tokens.
 */
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

function renderIndexBlock(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return '';

  const lines = [
    '## Additional skills (keyword index)',
    'Full instructions for extra skills load only when the current task matches a keyword below.',
    '',
  ];

  for (const { skill, keywords } of list) {
    const kw = keywords.length ? keywords.join(', ') : '(no keywords)';
    const label = skill.name || skill.id;
    const desc = skill.description ? ` — ${skill.description}` : '';
    lines.push(`- [${kw}] → ${label}${desc}`);
  }

  return lines.join('\n');
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

function withKeywords(skill = {}) {
  const keywords = resolveKeywords(skill);
  return { ...skill, keywords };
}

module.exports = {
  inferKeywords,
  resolveKeywords,
  buildIndex,
  renderIndexBlock,
  matchSkills,
  withKeywords,
};
