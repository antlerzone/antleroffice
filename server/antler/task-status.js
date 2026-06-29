// Task status constants (P2 five-state machine on deliverables).

const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  NEEDS_INPUT: 'needs_input',
  COMPLETE: 'complete',
  FAILED: 'failed',
});

const TERMINAL_STATUSES = new Set([TASK_STATUS.COMPLETE, TASK_STATUS.FAILED]);

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(String(status || ''));
}

function clip(text, max = 120) {
  const s = String(text || '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}?` : s;
}

module.exports = { TASK_STATUS, TERMINAL_STATUSES, isTerminalStatus, clip };
