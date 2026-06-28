// Tiny persisted flags for one-time office migrations (separate from settings.json
// so we don't have to touch the settings whitelist/mergeDefaults).
// Stored as plain JSON under the data dir, survives restarts.

const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');

function filePath() {
  return path.join(getDataDir(), 'office-flags.json');
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(filePath(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function write(next) {
  const data = { ...read(), ...(next || {}) };
  fs.writeFileSync(filePath(), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

/**
 * Heuristic: does this install belong to an EXISTING user (someone who used the
 * app before the "empty office" change)? If so, we grandfather their free COO.
 * A brand-new install has none of these signals.
 */
function looksLikeExistingInstall() {
  const dir = getDataDir();
  const hasFile = (name) => {
    try {
      return fs.existsSync(path.join(dir, name));
    } catch {
      return false;
    }
  };
  const jsonHas = (name, key) => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      const arr = Array.isArray(data) ? data : data?.[key];
      return Array.isArray(arr) && arr.length > 0;
    } catch {
      return false;
    }
  };

  // Prior chats with the COO, or any hired worker, or completed onboarding.
  if (jsonHas('boss-chats.json', 'threads')) return true;
  if (jsonHas('agents.json')) return true;
  try {
    const store = require('./store');
    const s = store.readSettings();
    if (s?.onboarding?.companySetupDone || s?.onboarding?.installerComplete) return true;
  } catch {
    /* ignore */
  }
  // Legacy data files that only exist after real usage.
  if (hasFile('deliverables.json') || hasFile('knowledge')) return true;
  return false;
}

module.exports = { read, write, looksLikeExistingInstall };
