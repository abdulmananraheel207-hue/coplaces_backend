import { toMinutes } from '../lib/time.js';

/** Everything that decides what a room or desk costs. Fields that are null are simply not used. */
export interface RateCard {
  hourlyRateCents: number;
  dailyRateCents: number;
  offPeakRateCents: number | null;
  peakStart: string | null;
  peakEnd: string | null;
  halfDayRateCents: number | null;
  fullDayRateCents: number | null;
  noPlanRateCents: number | null;
}

/** Whether this card prices anything beyond a single hourly rate. */
export const hasExtras = (c: RateCard) => c.offPeakRateCents !== null || c.halfDayRateCents !== null || c.fullDayRateCents !== null || c.noPlanRateCents !== null;

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * What a booking of a room costs in total, before any included meeting minutes are taken off.
 *
 * Minutes inside the peak window pay the hourly rate and the rest pay the off-peak rate, when there is one. A member with
 * no plan pays their own hourly rate throughout, when one is set. A half-day price covers bookings of up to four hours and
 * a day price covers any booking; whichever of those and the hourly total is cheapest wins. The result is not rounded.
 */
export function roomPriceCents(c: RateCard, startTime: string, endTime: string, hasPlan: boolean): number {
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  const duration = end - start;

  let hourly: number;
  if (!hasPlan && c.noPlanRateCents !== null) {
    hourly = (c.noPlanRateCents * duration) / 60;
  } else if (c.offPeakRateCents !== null && c.peakStart && c.peakEnd) {
    const peak = overlap(start, end, toMinutes(c.peakStart), toMinutes(c.peakEnd));
    hourly = (c.hourlyRateCents * peak + c.offPeakRateCents * (duration - peak)) / 60;
  } else {
    hourly = (c.hourlyRateCents * duration) / 60;
  }

  const options = [hourly];
  if (c.halfDayRateCents !== null && duration <= 240) options.push(c.halfDayRateCents);
  if (c.fullDayRateCents !== null) options.push(c.fullDayRateCents);
  return Math.min(...options);
}

/** What a day at a hot desk or day office costs. */
export function deskPriceCents(c: RateCard, hasPlan: boolean): number {
  if (!hasPlan && c.noPlanRateCents !== null) return c.noPlanRateCents;
  return c.dailyRateCents;
}
