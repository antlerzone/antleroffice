const cron = require('node-cron');
const debugLog = require('./debug-log');
const heartbeatConfig = require('./coo-heartbeat-config-store');
const cooHeartbeat = require('./coo-heartbeat-service');

let scheduledTask = null;

function validateCron(expr) {
  try {
    return cron.validate(String(expr || '').trim());
  } catch {
    return false;
  }
}

async function runScheduledHeartbeat() {
  if (cooHeartbeat.getStatus().running) {
    debugLog.logInfo('coo-heartbeat', 'scheduler_skip_busy');
    return;
  }
  const config = heartbeatConfig.getConfig();
  if (!config.enabled) return;
  debugLog.logInfo('coo-heartbeat', 'scheduler_run');
  try {
    await cooHeartbeat.runHeartbeat({ trigger: 'scheduler', wait: true });
  } catch (e) {
    debugLog.logWarn('coo-heartbeat', e.message || String(e));
  }
}

function reschedule() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }

  const config = heartbeatConfig.getConfig();
  if (!config.enabled) return { ok: true, scheduled: false };

  const expr = String(config.schedule?.cron || '0 */4 * * *').trim();
  if (!validateCron(expr)) {
    debugLog.logWarn('coo-heartbeat', `invalid cron: ${expr}`);
    return { ok: false, scheduled: false, error: 'invalid cron expression' };
  }

  const tz = String(config.schedule?.tz || '').trim();
  const options = tz ? { timezone: tz } : {};
  scheduledTask = cron.schedule(
    expr,
    () => {
      void runScheduledHeartbeat();
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
  runScheduledHeartbeat,
  validateCron,
};
