// Generic backend persistence for front-end UI settings blobs, keyed by name.
// One place per machine (~/.antleroffice2/ui-settings/<key>.json) so the same
// settings are shared no matter which origin loads the UI (localhost:3300 dev
// browser, 127.0.0.1:3300 dev Electron, 127.0.0.1:3020 packaged app).

const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');

function safeKey(key) {
  return String(key || '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 128) || 'default';
}

function dir() {
  return path.join(getDataDir(), 'ui-settings');
}

function filePath(key) {
  return path.join(dir(), `${safeKey(key)}.json`);
}

/** Returns the stored object for this key, or null when nothing saved yet. */
function read(key) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath(key), 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/** Persist (overwrite) the object for this key. */
function write(key, data) {
  if (!data || typeof data !== 'object') {
    throw new Error('data must be an object');
  }
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(filePath(key), JSON.stringify(data, null, 2), 'utf8');
}

module.exports = { read, write, filePath };
