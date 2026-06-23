// Per-user voice API preferences. STT/TTS resolve OpenClaw's OpenAI key by default.

const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');
const secretCrypto = require('./secret-crypto');
const oc = require('./openclaw-config');

const FILE = 'voice-api-preferences.json';
const DEFAULT_STT_MODEL = 'gpt-4o-mini-transcribe';

function dataPath() {
  return path.join(getDataDir(), FILE);
}

function readRaw() {
  try {
    const data = JSON.parse(fs.readFileSync(dataPath(), 'utf8'));
    return data && typeof data === 'object' ? data : { users: {} };
  } catch {
    return { users: {} };
  }
}

function writeRaw(data) {
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(dataPath(), JSON.stringify(data, null, 2), 'utf8');
}

function encryptField(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (secretCrypto.isEncrypted(text)) return text;
  return secretCrypto.encrypt(text);
}

function decryptField(value) {
  const raw = String(value ?? '');
  if (!raw) return '';
  if (!secretCrypto.isEncrypted(raw)) return raw;
  return secretCrypto.decrypt(raw);
}

function fieldIsSet(value) {
  return !!String(value ?? '').trim();
}

function normalizeRow(row = {}) {
  return {
    sttApiKey: String(row.sttApiKey || ''),
    openaiSttModel: String(row.openaiSttModel || DEFAULT_STT_MODEL).trim() || DEFAULT_STT_MODEL,
  };
}

function getRow(ownerKey) {
  const key = String(ownerKey || 'local:boss');
  const data = readRaw();
  if (!data.users) data.users = {};
  return { data, key, row: normalizeRow(data.users[key]) };
}

function openclawOpenAiKeyConfigured() {
  return oc.hasProviderApiKey('openai');
}

function publicView(row) {
  const norm = normalizeRow(row);
  return {
    hasSttKey: fieldIsSet(norm.sttApiKey),
    openaiSttModel: norm.openaiSttModel,
    openclawOpenAiKeyConfigured: openclawOpenAiKeyConfigured(),
  };
}

function sttKeyAvailable(ownerKey) {
  return !!getSttApiKey(ownerKey) || openclawOpenAiKeyConfigured();
}

function getPreferences(ownerKey) {
  const { row } = getRow(ownerKey);
  return {
    ...publicView(row),
    sttKeyAvailable: sttKeyAvailable(ownerKey),
  };
}

function getSttApiKey(ownerKey) {
  const { row } = getRow(ownerKey);
  return decryptField(row.sttApiKey).trim();
}

function getSttModel(ownerKey) {
  const { row } = getRow(ownerKey);
  return row.openaiSttModel || DEFAULT_STT_MODEL;
}

function setPreferences(ownerKey, patch = {}) {
  const { data, key, row } = getRow(ownerKey);
  const next = { ...row };

  if (patch.openaiSttModel !== undefined) {
    const model = String(patch.openaiSttModel || '').trim();
    if (model) next.openaiSttModel = model;
  }
  if (patch.sttApiKey !== undefined) {
    const plain = String(patch.sttApiKey || '').trim();
    next.sttApiKey = plain ? encryptField(plain) : '';
  }
  if (patch.clearSttKey) {
    next.sttApiKey = '';
  }

  data.users[key] = next;
  writeRaw(data);
  return getPreferences(ownerKey);
}

/**
 * Resolve OpenAI key for voice STT/TTS:
 * 1) per-user voice override
 * 2) request body (legacy client)
 * 3) OpenClaw provider key from onboarding / Models settings
 */
function resolveSttApiKey(ownerKey, legacyBodyKey = '') {
  const userKey = getSttApiKey(ownerKey);
  if (userKey) return { apiKey: userKey, source: 'user_voice' };

  const legacy = String(legacyBodyKey || '').trim();
  if (legacy) return { apiKey: legacy, source: 'request_body' };

  const openclawKey = oc.readProviderApiKey('openai');
  if (openclawKey) return { apiKey: openclawKey, source: 'openclaw' };

  return { apiKey: '', source: 'none' };
}

function userHasSttKey(ownerKey) {
  return sttKeyAvailable(ownerKey);
}

module.exports = {
  getPreferences,
  setPreferences,
  getSttApiKey,
  getSttModel,
  resolveSttApiKey,
  userHasSttKey,
  sttKeyAvailable,
  openclawOpenAiKeyConfigured,
  publicView,
};
