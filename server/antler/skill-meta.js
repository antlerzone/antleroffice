// Shared skill metadata helpers.
//
// Every skill — whether it lives in the user's "My Skills" store (skills.json)
// or is a built-in/bundled definition (skills/<id>.json, registry.json) — is
// normalized so it always carries:
//   - version:     an integer >= 1 (built-in skills start at 1). Each time a
//                  skill's behaviour changes it is bumped by 1. The heartbeat
//                  compares the version a hired worker is running against the
//                  latest version to decide whether an update is available.
//   - description: a short plain-English line describing what this version
//                  added/changed. Filled in by the Human Resource agent when it
//                  creates or updates a skill; used both for the agent detail
//                  page and as source material for the COO's update notice.
//
// Existing skills that predate versioning are implicitly version 1 with an
// empty description until they are next edited.

function asVersion(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function nextVersion(prev) {
  return asVersion(prev) + 1;
}

function normalizeKeywords(value) {
  if (!Array.isArray(value)) return [];
  return value.map((k) => String(k).trim()).filter(Boolean);
}

function normalizeSkillDef(def) {
  if (!def || typeof def !== 'object') return def;
  return {
    ...def,
    version: asVersion(def.version),
    description: typeof def.description === 'string' ? def.description : '',
    keywords: normalizeKeywords(def.keywords),
  };
}

module.exports = { asVersion, nextVersion, normalizeSkillDef, normalizeKeywords };
