import { describe, expect, it } from 'vitest';
import { addDays, addMonths, dayRange, localDate, localTime, monthRange, zonedToUtc } from '../src/lib/time.js';

describe('time helpers', () => {
  it('converts wall time to UTC across offsets', () => {
    expect(zonedToUtc('2026-01-15', '09:00', 'America/New_York').toISOString()).toBe('2026-01-15T14:00:00.000Z');
    expect(zonedToUtc('2026-07-15', '09:00', 'America/New_York').toISOString()).toBe('2026-07-15T13:00:00.000Z');
    expect(zonedToUtc('2026-06-15', '09:00', 'Asia/Karachi').toISOString()).toBe('2026-06-15T04:00:00.000Z');
    expect(zonedToUtc('2026-06-15', '09:00', 'UTC').toISOString()).toBe('2026-06-15T09:00:00.000Z');
  });

  it('handles the DST boundary', () => {
    // US spring forward 2026-03-08 at 02:00 local
    expect(zonedToUtc('2026-03-08', '01:00', 'America/New_York').toISOString()).toBe('2026-03-08T06:00:00.000Z');
    expect(zonedToUtc('2026-03-08', '03:00', 'America/New_York').toISOString()).toBe('2026-03-08T07:00:00.000Z');
    const day = dayRange('2026-03-08', 'America/New_York');
    expect((Date.parse(day.end) - Date.parse(day.start)) / 3_600_000).toBe(23);
  });

  it('round-trips local date and time', () => {
    const d = zonedToUtc('2026-05-04', '23:30', 'America/Los_Angeles');
    expect(localDate(d, 'America/Los_Angeles')).toBe('2026-05-04');
    expect(localTime(d, 'America/Los_Angeles')).toBe('23:30');
    // the same instant is already the next day in UTC
    expect(localDate(d, 'UTC')).toBe('2026-05-05');
  });

  it('does date arithmetic', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(addMonths('2026-01', -2)).toBe('2025-11');
  });

  it('computes month ranges', () => {
    const m = monthRange('2026-12', 'UTC');
    expect(m.firstDay).toBe('2026-12-01');
    expect(m.nextFirstDay).toBe('2027-01-01');
    expect(m.start).toBe('2026-12-01T00:00:00.000Z');
    expect(m.end).toBe('2027-01-01T00:00:00.000Z');
  });
});
