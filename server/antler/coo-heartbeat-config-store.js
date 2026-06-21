const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');

const CONFIG_FILE = 'coo-heartbeat.json';

function configPath() {
  return path.join(getDataDir(), CONFIG_FILE);
}

function defaultConfig() {
  return {
    enabled: true,
    autonomousLoop: true,
    idleBrainstorm: false,
    idleBrainstormCooldownHours: 6,
    loopIntervalMinutes: 2,
    staleJobHours: 24,
    schedule: { cron: '0 */4 * * *', tz: '' },
    maxAutoRunsPerTick: 1,
    lastIdleBrainstormAt: 0,
  };
}

function normalizeConfig(raw) {
  const base = defaultConfig();
  const src = raw && typeof raw === 'object' ? raw : {};
  const staleJobHours = Number(src.staleJobHours);
  const maxAutoRunsPerTick = Number(src.maxAutoRunsPerTick);
  const loopIntervalMinutes = Number(src.loopIntervalMinutes);
  const idleBrainstormCooldownHours = Number(src.idleBrainstormCooldownHours);
  const lastIdleBrainstormAt = Number(src.lastIdleBrainstormAt);

  return {
    enabled: src.enabled !== undefined ? !!src.enabled : base.enabled,
    autonomousLoop: src.autonomousLoop !== undefined ? !!src.autonomousLoop : base.autonomousLoop,
    idleBrainstorm: src.idleBrainstorm !== undefined ? !!src.idleBrainstorm : base.idleBrainstorm,
    idleBrainstormCooldownHours:
      Number.isFinite(idleBrainstormCooldownHours) && idleBrainstormCooldownHours > 0
        ? idleBrainstormCooldownHours
        : base.idleBrainstormCooldownHours,
    loopIntervalMinutes:
      Number.isFinite(loopIntervalMinutes) && loopIntervalMinutes > 0
        ? Math.min(30, Math.floor(loopIntervalMinutes))
        : base.loopIntervalMinutes,
    lastIdleBrainstormAt: Number.isFinite(lastIdleBrainstormAt) ? lastIdleBrainstormAt : 0,
    staleJobHours: Number.isFinite(staleJobHours) && staleJobHours > 0 ? staleJobHours : base.staleJobHours,
    maxAutoRunsPerTick:
      Number.isFinite(maxAutoRunsPerTick) && maxAutoRunsPerTick > 0
        ? Math.min(5, Math.floor(maxAutoRunsPerTick))
        : base.maxAutoRunsPerTick,
    schedule: {
      cron: String(src.schedule?.cron || base.schedule.cron),
      tz: String(src.schedule?.tz || ''),
    },
  };
}

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return null;
  }
}

function writeRaw(data) {
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

function getConfig() {
  return normalizeConfig(readRaw());
}

function patchConfig(patch = {}) {
  const current = getConfig();
  const next = normalizeConfig({
    ...current,
    ...patch,
    schedule: { ...current.schedule, ...(patch.schedule || {}) },
  });
  writeRaw(next);
  return next;
}

module.exports = {
  getConfig,
  patchConfig,
  defaultConfig,
};
