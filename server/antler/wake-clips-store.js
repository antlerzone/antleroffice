const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');

function clipsRoot() {
  const dir = path.join(store.getDataDir(), 'wake-clips');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath() {
  return path.join(clipsRoot(), 'index.json');
}

function loadIndex() {
  try {
    const raw = fs.readFileSync(indexPath(), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.clips) ? data.clips : [];
  } catch {
    return [];
  }
}

function saveIndex(clips) {
  fs.writeFileSync(indexPath(), JSON.stringify({ clips, updatedAt: Date.now() }, null, 2), 'utf8');
}

function listClips() {
  return loadIndex().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function getClip(id) {
  return loadIndex().find((c) => c.id === id) || null;
}

function clipAudioPath(id, ext = '.webm') {
  return path.join(clipsRoot(), `${id}${ext}`);
}

function createClip({ phrase, buffer, mimeType, originalName }) {
  const trimmed = String(phrase || '').trim();
  if (!trimmed) throw new Error('phrase is required');
  if (!buffer?.length) throw new Error('audio is required');

  const id = crypto.randomUUID();
  const ext = path.extname(originalName || '') || (mimeType?.includes('wav') ? '.wav' : '.webm');
  const audioPath = clipAudioPath(id, ext);
  fs.writeFileSync(audioPath, buffer);

  const clip = {
    id,
    phrase: trimmed,
    mimeType: mimeType || 'audio/webm',
    ext,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const clips = loadIndex();
  const norm = trimmed.toLowerCase();
  const filtered = clips.filter((c) => String(c.phrase || '').toLowerCase() !== norm);
  filtered.push(clip);
  saveIndex(filtered);
  return clip;
}

function deleteClip(id) {
  const clips = loadIndex();
  const clip = clips.find((c) => c.id === id);
  if (!clip) throw new Error('clip not found');
  const next = clips.filter((c) => c.id !== id);
  saveIndex(next);
  const audioPath = clipAudioPath(id, clip.ext || '.webm');
  try {
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  } catch {
    /* ignore */
  }
  return { ok: true, phrase: clip.phrase };
}

function getClipAudioPath(id) {
  const clip = getClip(id);
  if (!clip) return null;
  const audioPath = clipAudioPath(id, clip.ext || '.webm');
  return fs.existsSync(audioPath) ? audioPath : null;
}

module.exports = {
  listClips,
  getClip,
  createClip,
  deleteClip,
  getClipAudioPath,
};
