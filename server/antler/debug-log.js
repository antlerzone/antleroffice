// In-memory ring buffer — OpenClaw CLI + API activity for the Channels debug panel.

const MAX = 400;

/** @type {{ ts: number, level: string, source: string, message: string, detail?: string }[]} */
let lines = [];

function fmtTs(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function push(level, source, message, detail) {
  const entry = {
    ts: Date.now(),
    level,
    source,
    message: String(message || '').slice(0, 2000),
    detail: detail ? String(detail).slice(0, 8000) : undefined,
  };
  lines.push(entry);
  if (lines.length > MAX) lines = lines.slice(-MAX);
  return entry;
}

function logInfo(source, message, detail) {
  return push('info', source, message, detail);
}

function logOk(source, message, detail) {
  return push('ok', source, message, detail);
}

function logWarn(source, message, detail) {
  return push('warn', source, message, detail);
}

function logErr(source, message, detail) {
  return push('error', source, message, detail);
}

function logCli(cmd, args, result) {
  const line = [cmd, ...(args || [])].join(' ');
  const out = `${result?.stdout || ''}\n${result?.stderr || ''}`.trim();
  const brief = out.length > 600 ? `${out.slice(0, 600)}…` : out;
  if (result?.ok) return logOk('openclaw', line, brief || undefined);
  return logErr('openclaw', line, brief || result?.error || `exit ${result?.code}`);
}

function list({ limit = 200 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 200, 1), MAX);
  return lines.slice(-n).map((e) => ({
    ...e,
    time: fmtTs(e.ts),
  }));
}

function clear() {
  lines = [];
}

module.exports = { logInfo, logOk, logWarn, logErr, logCli, list, clear };
