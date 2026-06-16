// Verify hire passwords for hidden catalog agents (uses ECS server bcrypt helper when available).

const fs = require('node:fs');
const path = require('node:path');

let verifyPasswordAsync = null;

function loadVerifyPassword() {
  if (verifyPasswordAsync) return verifyPasswordAsync;
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'server', 'src', 'password.js'),
    path.join(__dirname, '..', '..', 'server', 'src', 'password.js'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const mod = require(p);
    if (typeof mod.verifyPassword === 'function') {
      verifyPasswordAsync = mod.verifyPassword;
      return verifyPasswordAsync;
    }
  }
  return null;
}

async function verifyHirePassword(template, hirePassword, { deferToEcs = false } = {}) {
  const needsPassword =
    template?.requiresHirePassword || template?.visibility === 'hidden' || template?.hidden;
  if (!needsPassword) return true;

  const plain = String(hirePassword || '').trim();
  if (!plain) {
    const err = new Error('Hire password is required for this hidden agent.');
    err.code = 'HIRE_PASSWORD_REQUIRED';
    throw err;
  }

  const hash = template._hirePasswordHash || template.hirePasswordHash;
  if (!hash) {
    if (deferToEcs) return true;
    const err = new Error('Hire password verification requires ECS connection for this hidden agent.');
    err.code = 'HIRE_PASSWORD_UNAVAILABLE';
    throw err;
  }

  const verify = loadVerifyPassword();
  if (!verify) {
    const err = new Error('Hire password verification is unavailable on this desktop.');
    err.code = 'HIRE_PASSWORD_UNAVAILABLE';
    throw err;
  }

  const ok = await verify(plain, hash);
  if (!ok) {
    const err = new Error('Invalid hire password.');
    err.code = 'INVALID_HIRE_PASSWORD';
    throw err;
  }
  return true;
}

function redactCatalogTemplate(t) {
  if (!t || typeof t !== 'object') return t;
  const { hirePasswordHash, _hirePasswordHash, ...rest } = t;
  return rest;
}

module.exports = {
  verifyHirePassword,
  redactCatalogTemplate,
};
