// Retell AI integration — boss's own Retell API key (Bring-Your-Own-Key).
// Stored AES-256-GCM encrypted at rest; agents/UI only ever see a masked preview.

const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');
const secretCrypto = require('./secret-crypto');

const FILE = 'retell.json';

function dataPath() {
  return path.join(getDataDir(), FILE);
}

function readRaw() {
  try {
    const data = JSON.parse(fs.readFileSync(dataPath(), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeRaw(obj) {
  const dir = getDataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dataPath(), JSON.stringify(obj, null, 2), 'utf8');
}

function maskKey(plain) {
  const k = String(plain || '').trim();
  if (!k) return '';
  if (k.length <= 8) return '*'.repeat(k.length);
  return `${k.slice(0, 4)}${'*'.repeat(Math.min(k.length - 8, 16))}${k.slice(-4)}`;
}

/** Public-safe status — never returns the plaintext key. */
function getStatus() {
  const raw = readRaw();
  const enc = String(raw.apiKey || '');
  if (!enc) return { configured: false, maskedKey: '', updatedAt: null };
  let plain = '';
  try {
    plain = secretCrypto.isEncrypted(enc) ? secretCrypto.decrypt(enc) : enc;
  } catch {
    plain = '';
  }
  return {
    configured: !!plain,
    maskedKey: maskKey(plain),
    updatedAt: raw.updatedAt || null,
  };
}

/** Decrypted key for runtime use (placing calls). Never expose via HTTP. */
function getApiKey() {
  const raw = readRaw();
  const enc = String(raw.apiKey || '');
  if (!enc) return '';
  try {
    return secretCrypto.isEncrypted(enc) ? secretCrypto.decrypt(enc) : enc;
  } catch {
    return '';
  }
}

function setApiKey(plain) {
  const key = String(plain || '').trim();
  if (!key) throw new Error('Retell API key cannot be empty');
  const raw = readRaw();
  raw.apiKey = secretCrypto.encrypt(key);
  raw.updatedAt = new Date().toISOString();
  writeRaw(raw);
  return getStatus();
}

function clearApiKey() {
  const raw = readRaw();
  delete raw.apiKey;
  raw.updatedAt = new Date().toISOString();
  writeRaw(raw);
  return getStatus();
}

module.exports = { getStatus, getApiKey, setApiKey, clearApiKey, maskKey };
