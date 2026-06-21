// Continuous COO loop — polls for work and schedules next tick after COO finishes.

const debugLog = require('./debug-log');
const heartbeatConfig = require('./coo-heartbeat-config-store');
const cooHeartbeat = require('./coo-heartbeat-service');
const departmentStandup = require('./department-standup-service');

let intervalTimer = null;
let soonTimer = null;
let tickRunning = false;

function loopIntervalMs(config) {
  const minutes = Number(config.loopIntervalMinutes);
  const m = Number.isFinite(minutes) && minutes > 0 ? minutes : 2;
  return Math.min(30, Math.max(1, m)) * 60 * 1000;
}

async function runLoopTick(trigger = 'loop') {
  if (tickRunning) return { skipped: true, reason: 'tick_running' };
  if (cooHeartbeat.getStatus().running) return { skipped: true, reason: 'heartbeat_running' };
  if (departmentStandup.getStatus().running) return { skipped: true, reason: 'standup_running' };

  const config = heartbeatConfig.getConfig();
  if (!config.enabled || !config.autonomousLoop) {
    return { skipped: true, reason: 'loop_disabled' };
  }

  tickRunning = true;
  try {
    debugLog.logInfo('coo-loop', 'tick', trigger);
    return await cooHeartbeat.runHeartbeat({ trigger, wait: true });
  } catch (e) {
    debugLog.logWarn('coo-loop', e.message || String(e));
    return { ok: false, error: e.message };
  } finally {
    tickRunning = false;
  }
}

function scheduleAfterCooWork(delayMs = 8000) {
  const config = heartbeatConfig.getConfig();
  if (!config.enabled || !config.autonomousLoop) return;
  if (soonTimer) clearTimeout(soonTimer);
  soonTimer = setTimeout(() => {
    soonTimer = null;
    void runLoopTick('after_coo');
  }, Math.max(2000, delayMs));
  if (typeof soonTimer.unref === 'function') soonTimer.unref();
}

function start() {
  stop();
  const config = heartbeatConfig.getConfig();
  if (!config.enabled || !config.autonomousLoop) return { ok: true, started: false };

  const ms = loopIntervalMs(config);
  intervalTimer = setInterval(() => {
    void runLoopTick('interval');
  }, ms);
  if (typeof intervalTimer.unref === 'function') intervalTimer.unref();

  setTimeout(() => void runLoopTick('boot'), 15000).unref?.();

  return { ok: true, started: true, intervalMs: ms };
}

function stop() {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  if (soonTimer) {
    clearTimeout(soonTimer);
    soonTimer = null;
  }
}

function reschedule() {
  return start();
}

function getStatus() {
  return {
    intervalActive: !!intervalTimer,
    soonScheduled: !!soonTimer,
    tickRunning,
    config: heartbeatConfig.getConfig(),
  };
}

module.exports = {
  start,
  stop,
  reschedule,
  runLoopTick,
  scheduleAfterCooWork,
  getStatus,
};
