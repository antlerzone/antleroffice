// Paid / gray-lock gate for skill semantic fallback (P1 hybrid routing).
// Signal sources:
//   - Gray lock: skill not in agent.skillIds (not learned yet)
//   - Paid OT: worker-entitlements.json skills[].homeWorkerId cross-worker
//   - Explicit: skill.cost / skill.status / skill.pricingModel on skill def
// Safe default: when uncertain, treat as restricted (semantic fallback blocked).

const fs = require('node:fs');
const path = require('node:path');

let entitlementsCache = { data: null, at: 0 };
const CACHE_MS = 60_000;

function entitlementsPaths() {
  return [
    path.join(__dirname, '..', '..', '..', 'server', 'data', 'worker-entitlements.json'),
    path.join(__dirname, '..', 'data', 'worker-entitlements.json'),
  ];
}

function loadEntitlementsSync() {
  if (entitlementsCache.data && Date.now() - entitlementsCache.at < CACHE_MS) {
    return entitlementsCache.data;
  }
  for (const p of entitlementsPaths()) {
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      entitlementsCache = { data, at: Date.now() };
      return data;
    } catch {
      /* try next */
    }
  }
  entitlementsCache = { data: { workers: [], skills: {} }, at: Date.now() };
  return entitlementsCache.data;
}

function homeWorkerId(agent) {
  return agent?.templateId || agent?.role || null;
}

function isExplicitPaidOrLocked(skill) {
  if (!skill) return false;
  if (skill.cost === 'paid' || skill.status === 'locked') return true;
  const pm = String(skill.pricingModel || '').toLowerCase();
  return pm === 'paid' || pm === 'paygo' || pm === 'per_use' || pm === 'per_task';
}

/**
 * @returns {boolean} true = semantic fallback must NOT auto-load this skill
 */
function isRestricted(skill, agent) {
  if (!skill?.id || !agent) return true;

  const skillId = skill.id;
  const learned = (agent.skillIds || []).includes(skillId);
  if (!learned) return true;

  if (isExplicitPaidOrLocked(skill)) return true;

  const data = loadEntitlementsSync();
  const meta = data.skills?.[skillId];
  const home = homeWorkerId(agent);

  if (!meta) {
    if (String(skillId).startsWith('skill-')) return false;
    return true;
  }

  if (meta.homeWorkerId && home && meta.homeWorkerId !== home && meta.homeWorkerId !== agent.role) {
    return true;
  }

  const worker = (data.workers || []).find(
    (w) => w.workerId === home || w.workerId === agent.role || w.departmentId === home,
  );
  if (worker?.skillFamilies && meta.skillFamily) {
    const family = worker.skillFamilies[meta.skillFamily] || [];
    if (family.includes(skillId)) return false;
  }

  if (meta.homeWorkerId === home || meta.homeWorkerId === agent.role) return false;

  return true;
}

module.exports = { isRestricted, isExplicitPaidOrLocked, loadEntitlementsSync, homeWorkerId };
