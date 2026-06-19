const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');

const INDEX_FILE = 'index.json';
const ALLOWED_EXT = new Set(['.wav', '.mp3', '.m4a', '.ogg', '.webm']);

function profilesRoot() {
  const dir = path.join(store.getDataDir(), 'voice-profiles');
  store.ensureDir(dir);
  return dir;
}

function indexPath() {
  return path.join(profilesRoot(), INDEX_FILE);
}

function readIndex() {
  const p = indexPath();
  try {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(data.profiles)) return data;
    }
  } catch {
    /* ignore corrupt index */
  }
  return { activeProfileId: null, profiles: [] };
}

function writeIndex(data) {
  fs.writeFileSync(indexPath(), JSON.stringify(data, null, 2), 'utf8');
}

function profileDir(id) {
  return path.join(profilesRoot(), id);
}

function inferProfileLang(profile) {
  if (profile.lang === 'zh' || profile.lang === 'en') return profile.lang;
  const ref = String(profile.refText || '').trim();
  if (!ref) return null;
  return /[\u4e00-\u9fff]/.test(ref) ? 'zh' : 'en';
}

function listProfiles() {
  const index = readIndex();
  return {
    activeProfileId: index.activeProfileId || null,
    profiles: index.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      refFile: p.refFile,
      refText: p.refText || null,
      lang: inferProfileLang(p),
      mimeType: p.mimeType || null,
      durationSec: p.durationSec ?? null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
  };
}

function getProfile(id) {
  const index = readIndex();
  return index.profiles.find((p) => p.id === id) || null;
}

function getActiveProfile() {
  const index = readIndex();
  if (!index.activeProfileId) return null;
  return getProfile(index.activeProfileId);
}

function setActiveProfile(id) {
  const index = readIndex();
  if (id && !index.profiles.some((p) => p.id === id)) {
    throw new Error('Profile not found');
  }
  index.activeProfileId = id || null;
  writeIndex(index);
  return index.activeProfileId;
}

function updateRefFile(id, refFile) {
  const index = readIndex();
  const profile = index.profiles.find((p) => p.id === id);
  if (!profile) return null;
  profile.refFile = refFile;
  profile.mimeType = 'audio/wav';
  profile.updatedAt = Date.now();
  writeIndex(index);
  return profile;
}

function createProfile({ name, buffer, originalName, mimeType, durationSec, refText, lang }) {
  if (!buffer || !buffer.length) throw new Error('Reference audio is required');
  const ext = path.extname(originalName || '').toLowerCase();
  const safeExt = ALLOWED_EXT.has(ext) ? ext : '.wav';
  const id = crypto.randomBytes(8).toString('hex');
  const dir = profileDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const refFile = `ref${safeExt}`;
  fs.writeFileSync(path.join(dir, refFile), buffer);

  const trimmedRef = String(refText || '').trim();
  let profileLang = lang === 'zh' || lang === 'en' ? lang : null;
  if (!profileLang && trimmedRef) {
    profileLang = /[\u4e00-\u9fff]/.test(trimmedRef) ? 'zh' : 'en';
  }

  const now = Date.now();
  const profile = {
    id,
    name: String(name || 'My voice').trim() || 'My voice',
    refFile,
    refText: trimmedRef || null,
    lang: profileLang,
    mimeType: mimeType || null,
    durationSec: durationSec ?? null,
    createdAt: now,
    updatedAt: now,
  };

  const index = readIndex();
  index.profiles.push(profile);
  if (!index.activeProfileId) index.activeProfileId = id;
  writeIndex(index);
  return profile;
}

function deleteProfile(id) {
  const index = readIndex();
  const idx = index.profiles.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('Profile not found');
  index.profiles.splice(idx, 1);
  if (index.activeProfileId === id) {
    index.activeProfileId = index.profiles[0]?.id || null;
  }
  writeIndex(index);
  try {
    fs.rmSync(profileDir(id), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return { ok: true, activeProfileId: index.activeProfileId };
}

function updateProfile(id, patch = {}) {
  const index = readIndex();
  const profile = index.profiles.find((p) => p.id === id);
  if (!profile) throw new Error('Profile not found');
  if (patch.name != null) profile.name = String(patch.name).trim() || profile.name;
  if (patch.refText != null) {
    profile.refText = String(patch.refText).trim() || null;
    const ref = profile.refText;
    if (ref) profile.lang = /[\u4e00-\u9fff]/.test(ref) ? 'zh' : 'en';
  }
  if (patch.lang === 'zh' || patch.lang === 'en') {
    profile.lang = patch.lang;
  }
  profile.updatedAt = Date.now();
  writeIndex(index);
  return profile;
}

function getRefAudioPath(profileId) {
  const profile = getProfile(profileId);
  if (!profile) return null;
  const dir = profileDir(profileId);
  const candidates = [
    profile.refFile,
    'ref.wav',
    'ref.webm',
    'ref.mp3',
    'ref.m4a',
    'ref.ogg',
  ].filter(Boolean);
  const seen = new Set();
  for (const name of candidates) {
    if (seen.has(name)) continue;
    seen.add(name);
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

module.exports = {
  listProfiles,
  getProfile,
  getActiveProfile,
  setActiveProfile,
  createProfile,
  deleteProfile,
  getRefAudioPath,
  updateRefFile,
  updateProfile,
  profilesRoot,
};
