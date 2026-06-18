// Calendar month boundaries in Asia/Singapore.

const TZ = 'Asia/Singapore';

function sgParts(ms = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
  });
  const parts = fmt.formatToParts(new Date(ms));
  return {
    year: Number(parts.find((p) => p.type === 'year')?.value),
    month: Number(parts.find((p) => p.type === 'month')?.value),
  };
}

function formatPeriod(ms = Date.now()) {
  const { year, month } = sgParts(ms);
  return `${year}-${String(month).padStart(2, '0')}`;
}

function previousCalendarMonth(ms = Date.now()) {
  const { year, month } = sgParts(ms);
  let y = year;
  let m = month - 1;
  if (m < 1) {
    m = 12;
    y -= 1;
  }
  return `${y}-${String(m).padStart(2, '0')}`;
}

function shiftPeriod(period, delta) {
  const [y, m] = String(period).split('-').map(Number);
  if (!y || !m) return previousCalendarMonth();
  let year = y;
  let month = m + delta;
  while (month < 1) {
    month += 12;
    year -= 1;
  }
  while (month > 12) {
    month -= 12;
    year += 1;
  }
  return `${year}-${String(month).padStart(2, '0')}`;
}

function periodToRangeMs(period) {
  const [y, m] = String(period).split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) {
    return periodToRangeMs(previousCalendarMonth());
  }
  const startMs = new Date(`${y}-${String(m).padStart(2, '0')}-01T00:00:00+08:00`).getTime();
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const endMs = new Date(`${ny}-${String(nm).padStart(2, '0')}-01T00:00:00+08:00`).getTime() - 1;
  return { startMs, endMs };
}

function isFuturePeriod(period, now = Date.now()) {
  return String(period) > formatPeriod(now);
}

function formatPeriodLabel(period) {
  const [y, m] = String(period).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

module.exports = {
  TZ,
  formatPeriod,
  previousCalendarMonth,
  shiftPeriod,
  periodToRangeMs,
  isFuturePeriod,
  formatPeriodLabel,
};
