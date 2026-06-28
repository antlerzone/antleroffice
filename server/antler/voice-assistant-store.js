// Backend persistence for the front-end voice-assistant settings blob
// (TTS provider + ElevenLabs/Fish/OpenAI keys, persona, wake words, etc.).
//
// Why this exists: the front-end used to keep these only in browser
// localStorage, which is per-origin. Running the UI from localhost:3300 (dev
// browser), 127.0.0.1:3300 (dev Electron) and 127.0.0.1:3020 (packaged app)
// each got SEPARATE storage, so keys saved in one mode looked "lost" in
// another. Mirroring the blob here (one file on the machine) makes every mode
// share the same settings.

const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');

function filePath() {
  return path.join(getDataDir(), 'voice-assistant-settings.json');
}

/** Returns the stored settings object, or null when nothing has been saved yet. */
function read() {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/** Persist the settings object (overwrites). */
function write(settings) {
  if (!settings || typeof settings !== 'object') {
    throw new Error('settings must be an object');
  }
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(settings, null, 2), 'utf8');
}

module.exports = { read, write, filePath };
