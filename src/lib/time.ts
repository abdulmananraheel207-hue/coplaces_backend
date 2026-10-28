// Timezone-aware date helpers. Calendar dates are 'YYYY-MM-DD', wall times 'HH:mm',
// and instants are ISO-8601 UTC strings. No date library needed.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

function wallParts(utcMs: number, tz: string) {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function offsetMs(utcMs: number, tz: string) {
  const p = wallParts(utcMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidDate(s: string) {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The UTC instant at which the given wall-clock time occurs in `tz`. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wall - offsetMs(wall, tz);
  guess = wall - offsetMs(guess, tz); // second pass handles DST transitions
  return new Date(guess);
}

/** Calendar date in `tz` for an instant. */
export function localDate(instant: Date | string, tz: string): string {
  const p = wallParts(new Date(instant).getTime(), tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function todayIn(tz: string, now = new Date()) {
  return localDate(now, tz);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** UTC bounds [start, end) of a local calendar day. */
export function dayRange(date: string, tz: string) {
  return {
    start: zonedToUtc(date, '00:00', tz).toISOString(),
    end: zonedToUtc(addDays(date, 1), '00:00', tz).toISOString(),
  };
}

/** UTC bounds [start, end) of a local calendar month ('YYYY-MM'), plus the first day of it and of the next. */
export function monthRange(month: string, tz: string) {
  const firstDay = `${month}-01`;
  const nextFirstDay = `${addMonths(month, 1)}-01`;
  return {
    firstDay,
    nextFirstDay,
    start: zonedToUtc(firstDay, '00:00', tz).toISOString(),
    end: zonedToUtc(nextFirstDay, '00:00', tz).toISOString(),
  };
}

export function minutesBetween(startIso: string, endIso: string) {
  return Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60_000);
}

export function toMinutes(time: string) {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/** 'HH:mm' wall time in `tz` for an instant. */
export function localTime(instant: Date | string, tz: string): string {
  const p = wallParts(new Date(instant).getTime(), tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Adds calendar months to a 'YYYY-MM-DD' date, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonthsToDate(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, lastDay))).toISOString().slice(0, 10);
}
