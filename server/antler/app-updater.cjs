const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');

const SCHEDULE_FILE = 'update-schedule.json';

function schedulePath() {
  return path.join(getDataDir(), SCHEDULE_FILE);
}

function readSchedule() {
  try {
    return JSON.parse(fs.readFileSync(schedulePath(), 'utf8'));
  } catch {
    return {
      pendingVersion: null,
      scheduledAt: null,
      preApproved: false,
      skippedVersion: null,
      remindAfter: null,
    };
  }
}

function writeSchedule(patch) {
  const next = { ...readSchedule(), ...patch };
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(schedulePath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function clearSchedule() {
  try { fs.unlinkSync(schedulePath()); } catch { /* */ }
  return readSchedule();
}

function shouldRemind() {
  const s = readSchedule();
  if (!s.pendingVersion) return false;
  if (s.skippedVersion === s.pendingVersion) return false;
  if (s.remindAfter && Date.now() < Number(s.remindAfter)) return false;
  return true;
}

function dueScheduledUpdate() {
  const s = readSchedule();
  if (!s.pendingVersion || !s.scheduledAt) return null;
  if (Date.now() < Number(s.scheduledAt)) return null;
  return s;
}

module.exports = {
  readSchedule,
  writeSchedule,
  clearSchedule,
  shouldRemind,
  dueScheduledUpdate,
};
