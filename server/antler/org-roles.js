// Office hierarchy roles: Secretary (gateway main) → hired CEO → department workers.

const office = require('./office-state');

const SECRETARY_ROLE = 'secretary';
const CEO_ROLE = 'ceo';
const LEGACY_COO_ROLE = 'coo';

function normalizeRole(role) {
  const r = String(role || '').trim();
  if (r === LEGACY_COO_ROLE) return CEO_ROLE;
  return r;
}

function isCeoRole(role) {
  return normalizeRole(role) === CEO_ROLE;
}

function isSecretaryRole(role) {
  return String(role || '').trim() === SECRETARY_ROLE;
}

function findSecretary() {
  return office.getAgent(SECRETARY_ROLE);
}

/** Hired CEO only (not the free secretary). */
function findHiredCeo() {
  return (
    office.state.agents.find(
      (a) => !a.external && isCeoRole(a.role) && a.userAgentId,
    ) ||
    office.state.agents.find(
      (a) => !a.external && isCeoRole(a.role) && a.id?.startsWith('user:'),
    ) ||
    null
  );
}

function ceoAgentOrFallback() {
  return (
    findHiredCeo() ||
    office.getAgent(CEO_ROLE) ||
    office.getAgent(LEGACY_COO_ROLE) || {
      id: CEO_ROLE,
      role: CEO_ROLE,
      label: 'CEO',
    }
  );
}

function migrateOfficeAgents() {
  const secretary = office.ensureRole(SECRETARY_ROLE, 'Secretary', 0);
  office.setAgent(secretary.id, {
    openclawAgentId: 'main',
    label: office.getAgent(SECRETARY_ROLE)?.label || 'Secretary',
  });

  const ceoStation = office.ensureRole(CEO_ROLE, 'CEO', 5);
  if (!ceoStation.userAgentId) {
    office.setAgent(ceoStation.id, {
      label: 'CEO',
      npcState: 'resting',
      bubbleText: '',
      openclawAgentId: null,
    });
  }

  for (const a of [...office.state.agents]) {
    if (a.role === LEGACY_COO_ROLE) {
      if (a.userAgentId || String(a.id || '').startsWith('user:')) {
        office.setAgent(a.id, {
          role: CEO_ROLE,
          label: String(a.label || 'CEO').replace(/COO\s*·?\s*OpenClaw/i, 'CEO').trim() || 'CEO',
          openclawAgentId: a.openclawAgentId === 'main' ? null : a.openclawAgentId,
        });
      } else {
        office.removeAgent(a.id);
      }
    }
  }

  const legacyCoo = office.getAgent(LEGACY_COO_ROLE);
  if (legacyCoo && !legacyCoo.userAgentId) {
    office.removeAgent(legacyCoo.id);
  }
}

module.exports = {
  SECRETARY_ROLE,
  CEO_ROLE,
  LEGACY_COO_ROLE,
  normalizeRole,
  isCeoRole,
  isSecretaryRole,
  findSecretary,
  findHiredCeo,
  ceoAgentOrFallback,
  migrateOfficeAgents,
};
