// Office hierarchy: COO (gateway main, OpenClaw) → department workers.
// Human user = CEO/Boss. Orchestrator = COO (OpenClaw autonomous agent).

const office = require('./office-state');

const SECRETARY_ROLE = 'coo'; // legacy alias — Secretary removed, COO is front door
const COO_ROLE = 'coo';
const IT_JUNIOR_ROLE = 'it_junior';
const LEGACY_CEO_ROLE = 'ceo';

function normalizeRole(role) {
  const r = String(role || '').trim();
  if (r === LEGACY_CEO_ROLE) return COO_ROLE;
  return r;
}

function isCooRole(role) {
  return normalizeRole(role) === COO_ROLE;
}

/** @deprecated use isCooRole */
function isCeoRole(role) {
  return isCooRole(role);
}

function isSecretaryRole(role) {
  return String(role || '').trim() === SECRETARY_ROLE;
}

function isItJuniorRole(role) {
  return String(role || '').trim() === IT_JUNIOR_ROLE;
}

function findItJunior() {
  return office.getAgent(IT_JUNIOR_ROLE);
}

/** @deprecated Secretary removed — returns COO agent as front door */
function findSecretary() {
  return office.getAgent(COO_ROLE);
}

/** Hired COO only. */
function findHiredCoo() {
  return (
    office.state.agents.find(
      (a) => !a.external && isCooRole(a.role) && a.userAgentId,
    ) ||
    office.state.agents.find(
      (a) => !a.external && isCooRole(a.role) && a.id?.startsWith('user:'),
    ) ||
    null
  );
}

/** @deprecated use findHiredCoo */
function findHiredCeo() {
  return findHiredCoo();
}

function cooAgentOrFallback() {
  return (
    findHiredCoo() ||
    office.getAgent(COO_ROLE) ||
    office.getAgent(LEGACY_CEO_ROLE) || {
      id: COO_ROLE,
      role: COO_ROLE,
      label: 'COO',
    }
  );
}

/** @deprecated use cooAgentOrFallback */
function ceoAgentOrFallback() {
  return cooAgentOrFallback();
}

function migrateOfficeAgents() {
  // Remove any legacy secretary agent from state (match by role, not the
  // generated npc id, so seeded/persisted secretaries are reliably cleared).
  for (const a of [...office.state.agents]) {
    if (a.role === 'secretary') {
      office.removeAgent(a.id);
    }
  }

  // NOTE: We no longer auto-create a COO station here. New users start with an
  // empty office and hire a COO from Browse. If a COO already exists (hired, or
  // grandfathered by register.cjs), only normalize it — never create one.
  const cooStation = office.getAgent(COO_ROLE);
  if (cooStation && !cooStation.userAgentId) {
    office.setAgent(cooStation.id, {
      label: 'COO',
      npcState: 'resting',
      bubbleText: '',
      openclawAgentId: cooStation.openclawAgentId || 'main',
    });
  }

  for (const a of [...office.state.agents]) {
    if (a.role === LEGACY_CEO_ROLE) {
      if (a.userAgentId || String(a.id || '').startsWith('user:')) {
        office.setAgent(a.id, {
          role: COO_ROLE,
          label: String(a.label || 'COO').replace(/^CEO\b/i, 'COO').trim() || 'COO',
          openclawAgentId: a.openclawAgentId === 'main' ? null : a.openclawAgentId,
        });
      } else if (a.id === LEGACY_CEO_ROLE || a.id === COO_ROLE) {
        office.setAgent(a.id, { role: COO_ROLE, label: 'COO' });
      } else {
        office.removeAgent(a.id);
      }
    }
  }

  const legacyCeoVacant = office.getAgent(LEGACY_CEO_ROLE);
  if (legacyCeoVacant && !legacyCeoVacant.userAgentId && legacyCeoVacant.id === LEGACY_CEO_ROLE) {
    office.removeAgent(legacyCeoVacant.id);
  }

  // IT Junior is no longer auto-seeded. New users start empty. If one was hired
  // or grandfathered, just normalize its label; never create one here.
  const itJunior = office.getAgent(IT_JUNIOR_ROLE);
  if (itJunior) {
    office.setAgent(itJunior.id, {
      label: itJunior.label || 'IT Junior',
      npcState: 'resting',
      bubbleText: '',
    });
  }
}

module.exports = {
  SECRETARY_ROLE,
  COO_ROLE,
  IT_JUNIOR_ROLE,
  CEO_ROLE: LEGACY_CEO_ROLE,
  LEGACY_CEO_ROLE,
  LEGACY_COO_ROLE: COO_ROLE,
  normalizeRole,
  isCooRole,
  isCeoRole,
  isSecretaryRole,
  isItJuniorRole,
  findSecretary,
  findItJunior,
  findHiredCoo,
  findHiredCeo,
  cooAgentOrFallback,
  ceoAgentOrFallback,
  migrateOfficeAgents,
};
