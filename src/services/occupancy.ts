import { and, eq, gte, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { bookings, locationHolidays, resourceAssignments, resources } from '../db/schema.js';
import { isAssigned, isHourly } from '../catalogue.js';
import { loadLocation } from '../lib/access.js';
import { addDays, daysBetween, localDate, toMinutes, zonedToUtc } from '../lib/time.js';
import { weekdayOf } from './bookings.js';

export interface OccupancyItem {
  resourceId: string;
  name: string;
  kind: string;
  floor: string;
  /** Share of the time it could have been used that it was, 0 to 1. */
  utilization: number;
  /** What was used: hours for rooms, days for everything else. */
  used: number;
  unit: 'hours' | 'days';
}

/**
 * How busy each space was over a period. A room is measured in booked hours against the hours it was open, a desk or
 * day office in booked days against the days it was open, and anything assigned in days it was held against all days.
 */
export async function occupancy(db: Db, locationId: string, from: string, to: string) {
  const loc = await loadLocation(db, locationId);
  const span = Math.min(daysBetween(from, to) + 1, 366);
  const days = Array.from({ length: span }, (_, i) => addDays(from, i));
  // The same test as closedReason, with the period's holidays fetched in one query rather than one per day.
  const holidays = new Set(
    (await db
      .select({ date: locationHolidays.date })
      .from(locationHolidays)
      .where(and(eq(locationHolidays.locationId, locationId), gte(locationHolidays.date, from), lte(locationHolidays.date, addDays(from, span - 1))))
      .all())
      .map((h) => h.date),
  );
  const closedWeekdays = loc.closedWeekdays.split(',');
  const openDays = days.filter((d) => !holidays.has(d) && !closedWeekdays.includes(String(weekdayOf(d))));

  const spaces = (await db
    .select()
    .from(resources)
    .where(and(eq(resources.locationId, locationId)))
    .all())
    .filter((r) => r.status !== 'retired');

  const rangeStart = zonedToUtc(from, '00:00', loc.timezone).toISOString();
  const rangeEnd = zonedToUtc(addDays(from, span), '00:00', loc.timezone).toISOString();
  const live = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.locationId, locationId), inArray(bookings.status, ['confirmed', 'completed']), gte(bookings.startsAt, rangeStart), lt(bookings.startsAt, rangeEnd)))
    .all();
  const held = await db
    .select()
    .from(resourceAssignments)
    .where(and(lte(resourceAssignments.startDate, addDays(from, span - 1)), or(isNull(resourceAssignments.endDate), gte(resourceAssignments.endDate, from))))
    .all();

  const items: OccupancyItem[] = spaces.map((r) => {
    const base = { resourceId: r.id, name: r.name, kind: r.kind, floor: r.floor };
    const own = r.closedWeekdays ? r.closedWeekdays.split(',') : [];
    const openHere = openDays.filter((d) => !own.includes(String(weekdayOf(d))));

    if (isAssigned(r.kind)) {
      const mine = held.filter((a) => a.resourceId === r.id);
      const covered = days.filter((d) => mine.some((a) => a.startDate <= d && (!a.endDate || a.endDate >= d))).length;
      return { ...base, utilization: span ? covered / span : 0, used: covered, unit: 'days' as const };
    }

    const mine = live.filter((b) => b.resourceId === r.id);
    if (isHourly(r.kind)) {
      const perDay = toMinutes(r.closeTime ?? loc.closeTime) - toMinutes(r.openTime ?? loc.openTime);
      const available = openHere.length * perDay;
      const booked = mine.reduce((sum, b) => sum + (Date.parse(b.endsAt) - Date.parse(b.startsAt)) / 60_000, 0);
      return { ...base, utilization: available > 0 ? Math.min(1, booked / available) : 0, used: Math.round((booked / 60) * 10) / 10, unit: 'hours' as const };
    }
    // A desk is measured in days, and a part-day booking counts as that part of a day.
    const perDay = Math.max(1, toMinutes(r.closeTime ?? loc.closeTime) - toMinutes(r.openTime ?? loc.openTime));
    const bookedDays = mine.reduce((sum, b) => sum + Math.min(1, (Date.parse(b.endsAt) - Date.parse(b.startsAt)) / 60_000 / perDay), 0);
    return { ...base, utilization: openHere.length ? Math.min(1, bookedDays / openHere.length) : 0, used: Math.round(bookedDays * 10) / 10, unit: 'days' as const };
  });

  const round = (n: number) => Math.round(n * 1000) / 1000;
  const average = items.length ? items.reduce((s, i) => s + i.utilization, 0) / items.length : 0;
  return { from, to: addDays(from, span - 1), days: span, openDays: openDays.length, average: round(average), items: items.map((i) => ({ ...i, utilization: round(i.utilization) })) };
}
