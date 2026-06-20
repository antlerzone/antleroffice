const cron = require('node-cron');
const debugLog = require('./debug-log');
const payroll = require('./payroll');
const auth = require('./auth');

let scheduledTask = null;

function runCeoMidnightPayroll() {
  try {
    const result = payroll.runCeoDailyPayroll();
    if (result.processed > 0) {
      debugLog.logInfo('ceo-payroll', 'midnight_charge', result);
      auth.refreshAllSessionCredits();
    }
  } catch (e) {
    debugLog.logWarn('ceo-payroll', e.message || String(e));
  }
}

function start() {
  if (scheduledTask) return { ok: true, scheduled: true };
  scheduledTask = cron.schedule('0 0 * * *', () => {
    runCeoMidnightPayroll();
  });
  return { ok: true, scheduled: true, cron: '0 0 * * *' };
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
  runCeoMidnightPayroll,
};
