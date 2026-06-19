const cron = require('node-cron');
const debugLog = require('./debug-log');
const standupConfig = require('./daily-standup-config-store');
const departmentStandup = require('./department-standup-service');

let scheduledTask = null;

function validateCron(expr) {
  try {
    return cron.validate(String(expr || '').trim());
  } catch {
    return false;
  }
}

async function runScheduledStandup() {
  if (departmentStandup.getStatus().running) {
    debugLog.logInfo('standup', 'scheduler_skip_busy');
    return;
  }
  const config = standupConfig.getConfig();
  if (!config.enabled) return;
  debugLog.logInfo('standup', 'scheduler_run', config.defaultPeriod);
  try {
    await departmentStandup.runStandup({
      period: config.defaultPeriod,
      trigger: 'scheduler',
      wait: true,
    });
  } catch (e) {
    debugLog.logWarn('standup', e.message || String(e));
  }
}

function reschedule() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }

  const config = standupConfig.getConfig();
  if (!config.enabled) return { ok: true, scheduled: false };

  const expr = String(config.schedule?.cron || '0 8 * * *').trim();
  if (!validateCron(expr)) {
    debugLog.logWarn('standup', `invalid cron: ${expr}`);
    return { ok: false, scheduled: false, error: 'invalid cron expression' };
  }

  const tz = String(config.schedule?.tz || '').trim();
  const options = tz ? { timezone: tz } : {};
  scheduledTask = cron.schedule(
    expr,
    () => {
      void runScheduledStandup();
    },
    options,
  );
  return { ok: true, scheduled: true, cron: expr, tz: tz || null };
}

function start() {
  return reschedule();
}

function stop() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}

module.exports = {
  start,
  stop,
  reschedule,
  runScheduledStandup,
  validateCron,
};
