import { and, eq, gt, gte, inArray, isNull, lt, lte, ne, or } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { attendance, bookings, contractPeople, contractSpaces, locationHolidays, members, plans, resourceAssignments, resources, shiftSpaces, shiftTemplates, users } from '../db/schema.js';
import { isAssigned, isHourly } from '../catalogue.js';
import { deskPriceCents, hasExtras, roomPriceCents, type RateCard } from './pricing.js';
import { assertLocation, isStaff, type AuthUser } from '../lib/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { loadLocation } from '../lib/access.js';
import { dayRange, localDate, localTime, minutesBetween, monthRange, toMinutes, todayIn, zonedToUtc } from '../lib/time.js';

const LIVE = ['confirmed', 'completed'] as const;

export const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Why the location is shut on a date (a weekday it never opens, or a holiday), or null when it is open. */
export async function closedReason(db: Db, loc: { id: string; closedWeekdays: string }, date: string): Promise<string | null> {
  const holiday = await db
    .select({ name: locationHolidays.name })
    .from(locationHolidays)
    .where(and(eq(locationHolidays.locationId, loc.id), eq(locationHolidays.date, date)))
    .get();
  if (holiday) return holiday.name ? `Closed for ${holiday.name}` : 'Closed for a holiday';
  return loc.closedWeekdays.split(',').includes(String(weekdayOf(date))) ? 'Closed on this day of the week' : null;
}

/** The shift a booking matches exactly, if the owner set one up for this space: the space's own first, then its kind, then any. */
export async function matchShift(tx: Tx, resource: { id: string; kind: string; locationId: string }, startTime: string, endTime: string, planId: string | null = null) {
  // A plan's shifts are for the members on that plan; shifts that belong to no plan are for everyone.
  const found = (await tx
    .select()
    .from(shiftTemplates)
    .where(and(eq(shiftTemplates.locationId, resource.locationId), eq(shiftTemplates.active, true), eq(shiftTemplates.startTime, startTime), eq(shiftTemplates.endTime, endTime)))
    .all())
    .filter((t) => !t.planId || t.planId === planId);
  const listed = found.length ? await tx.select().from(shiftSpaces).where(inArray(shiftSpaces.shiftId, found.map((t) => t.id))).all() : [];
  const spacesOf = (t: (typeof found)[number]) => listed.filter((s) => s.shiftId === t.id);
  const rows = found.filter((t) => (spacesOf(t).length ? spacesOf(t).some((s) => s.resourceId === resource.id) : t.resourceId === resource.id || (!t.resourceId && (!t.kind || t.kind === resource.kind))));
  const rank = (t: (typeof rows)[number]) => (spacesOf(t).length || t.resourceId ? 0 : t.kind ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b))[0];
}

/** A hot desk booking that runs from opening to closing is a whole-day booking; anything shorter is a part of the day. */
export const isWholeDay = (b: { startsAt: string; endsAt: string }, kind: string, open: string, close: string, tz: string) =>
  kind === 'hot_desk' && localTime(b.startsAt, tz) === open && localTime(b.endsAt, tz) === close;

/** Where a booking's price came from, so the booking form can say so. The screen words it. */
export type PriceBasis =
  | { type: 'plan' }
  | { type: 'minutes'; freeMinutes: number; billableMinutes: number }
  | { type: 'shift'; name: string }
  | { type: 'hourly'; rateCents: number }
  | { type: 'daily'; rateCents: number }
  | { type: 'dayshare'; rateCents: number }
  | { type: 'rates' };

export interface BookingRequest {
  resourceId: string;
  memberId: string;
  date: string;
  startTime?: string | undefined;
  endTime?: string | undefined;
  notes: string;
}

/** Works out everything a booking would be, price included, and refuses it with the same errors a real booking would give. Writes nothing. */
async function planBooking(tx: Tx, req: BookingRequest, actor: AuthUser, now: Date) {
    const resource = await tx.select().from(resources).where(eq(resources.id, req.resourceId)).get();
    if (!resource) throw notFound('Resource');
    assertLocation(actor, resource.locationId);
    if (isAssigned(resource.kind) || (!isHourly(resource.kind) && resource.kind !== 'hot_desk')) {
      throw badRequest('Dedicated desks, offices, lockers and parking are assigned to members, not booked');
    }
    if (resource.status !== 'available') throw conflict(`${resource.name} is not available (${resource.status.replace('_', ' ')})`);

    const member = await tx.select().from(members).where(eq(members.id, req.memberId)).get();
    if (!member) throw notFound('Member');
    if (!isStaff(actor) && actor.memberId !== member.id) throw forbidden();
    if (member.status !== 'active') throw badRequest('Only active members can make bookings');
    if (member.locationId !== resource.locationId) throw badRequest('Member belongs to a different location');

    const loc = await loadLocation(tx as unknown as Db, resource.locationId);
    const tz = loc.timezone;
    const closed = await closedReason(tx as unknown as Db, loc, req.date);
    if (closed) throw badRequest(`${closed}, so nothing can be booked then`);
    if (resource.closedWeekdays?.split(',').includes(String(weekdayOf(req.date)))) throw badRequest(`${resource.name} is closed on this day of the week`);
    // A space can keep its own hours; otherwise it follows the location's.
    const openTime = resource.openTime ?? loc.openTime;
    const closeTime = resource.closeTime ?? loc.closeTime;

    let startTime: string;
    let endTime: string;
    // Rooms are always booked for a time. A hot desk can be too, from and until, or for the whole day when no times are given.
    const hourly = isHourly(resource.kind);
    const timed = hourly || (resource.kind === 'hot_desk' && !!(req.startTime || req.endTime));
    if (timed) {
      if (!req.startTime || !req.endTime) throw badRequest(hourly ? 'startTime and endTime are required for rooms' : 'Give both a from and an until time, or neither for the whole day');
      startTime = req.startTime;
      endTime = req.endTime;
      const dur = toMinutes(endTime) - toMinutes(startTime);
      if (dur <= 0) throw badRequest('End time must be after start time');
      if (dur % 15 !== 0) throw badRequest('Bookings must be in 15 minute steps');
      if (hourly && dur > 12 * 60) throw badRequest('Bookings are limited to 12 hours');
      if (toMinutes(startTime) < toMinutes(openTime) || toMinutes(endTime) > toMinutes(closeTime)) {
        throw badRequest(`Bookings must be within opening hours (${openTime}–${closeTime})`);
      }
    } else {
      startTime = openTime;
      endTime = closeTime;
    }

    const startsAt = zonedToUtc(req.date, startTime, tz).toISOString();
    const endsAt = zonedToUtc(req.date, endTime, tz).toISOString();
    if (Date.parse(endsAt) <= now.getTime()) throw badRequest('That time has already passed');

    // A space rented to a member on a contract is theirs; nobody else can book it while the rent runs.
    const renter = await tx
      .select({ name: users.name, memberId: resourceAssignments.memberId, assignmentId: resourceAssignments.id })
      .from(resourceAssignments)
      .innerJoin(members, eq(members.id, resourceAssignments.memberId))
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(resourceAssignments.resourceId, resource.id), lte(resourceAssignments.startDate, req.date), or(isNull(resourceAssignments.endDate), gte(resourceAssignments.endDate, req.date))))
      .get();
    if (renter && renter.memberId !== member.id) {
      // A space a company rents together can be booked by everyone on that company's contract.
      const shared = await tx.select({ contractId: contractSpaces.contractId }).from(contractSpaces).where(eq(contractSpaces.assignmentId, renter.assignmentId)).get();
      const inCompany = shared && (await tx.select({ id: contractPeople.id }).from(contractPeople).where(and(eq(contractPeople.contractId, shared.contractId), eq(contractPeople.memberId, member.id), isNull(contractPeople.leaveDate))).get());
      if (!inCompany) throw conflict(`${resource.name} is rented to ${renter.name} on that day`);
    }

    const clash = await tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.resourceId, resource.id),
          inArray(bookings.status, [...LIVE]),
          lt(bookings.startsAt, endsAt),
          gt(bookings.endsAt, startsAt),
        ),
      )
      .get();
    if (clash) throw conflict(`${resource.name} is already booked for that time`);

    if (resource.kind === 'hot_desk') {
      const day = dayRange(req.date, tz);
      // A member can be at one desk at a time, so two desk bookings may not overlap, though they may share a day.
      const other = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .innerJoin(resources, eq(resources.id, bookings.resourceId))
        .where(
          and(
            eq(bookings.memberId, member.id),
            eq(resources.kind, 'hot_desk'),
            inArray(bookings.status, [...LIVE]),
            lt(bookings.startsAt, endsAt),
            gt(bookings.endsAt, startsAt),
          ),
        )
        .get();
      if (other) throw conflict(timed ? 'This member already has a desk booked at that time' : 'This member already has a desk booked that day');

      // Someone else is checked in at this desk right now, so it is not free for a booking that covers now.
      if (req.date === todayIn(tz, now) && Date.parse(startsAt) <= now.getTime() && now.getTime() < Date.parse(endsAt)) {
        const sitting = await tx
          .select({ name: users.name })
          .from(attendance)
          .innerJoin(members, eq(members.id, attendance.memberId))
          .innerJoin(users, eq(users.id, members.userId))
          .where(
            and(
              eq(attendance.resourceId, resource.id),
              isNull(attendance.checkOutAt),
              ne(attendance.memberId, member.id),
              gte(attendance.checkInAt, day.start),
              lt(attendance.checkInAt, day.end),
            ),
          )
          .get();
        if (sitting) throw conflict(`${resource.name} is in use by ${sitting.name} right now`);
      }
    }

    const plan = member.planId ? await tx.select().from(plans).where(eq(plans.id, member.planId)).get() : undefined;
    const duration = minutesBetween(startsAt, endsAt);
    let billableMinutes: number;
    let priceCents: number;
    let basis: PriceBasis;

    const card: RateCard = resource;
    const hasPlan = !!plan;

    if (resource.kind === 'corporate_room') {
      // Corporate rooms are premium: always their own rates, never the plan's included minutes.
      billableMinutes = duration;
      const shift = await matchShift(tx, resource, startTime, endTime, plan?.id ?? null);
      priceCents = shift?.priceCents != null ? shift.priceCents : Math.round(hasExtras(card) ? roomPriceCents(card, startTime, endTime, hasPlan) : (resource.hourlyRateCents * duration) / 60);
      basis = shift?.priceCents != null ? { type: 'shift', name: shift.name } : hasExtras(card) ? { type: 'rates' } : { type: 'hourly', rateCents: resource.hourlyRateCents };
    } else if (resource.kind === 'room') {
      // Included meeting minutes are a monthly allowance; only live bookings consume it.
      const month = monthRange(localDate(startsAt, tz).slice(0, 7), tz);
      const used = await tx
        .select({ startsAt: bookings.startsAt, endsAt: bookings.endsAt, billableMinutes: bookings.billableMinutes })
        .from(bookings)
        .innerJoin(resources, eq(resources.id, bookings.resourceId))
        .where(
          and(
            eq(bookings.memberId, member.id),
            eq(resources.kind, 'room'),
            inArray(bookings.status, [...LIVE]),
            gt(bookings.startsAt, month.start),
            lt(bookings.startsAt, month.end),
          ),
        )
        .all();
      const freeUsed = used.reduce((sum, b) => sum + (minutesBetween(b.startsAt, b.endsAt) - b.billableMinutes), 0);
      // The plan's minutes plus the credit hours the owner gave this member (two credit hours are an hour).
      const freeLeft = Math.max(0, (plan?.includedMeetingMinutes ?? 0) + member.meetingCredits * 30 - freeUsed);
      billableMinutes = duration - Math.min(duration, freeLeft);
      // A shift with its own price is charged in full and leaves the included minutes alone. Otherwise only the minutes beyond the allowance are charged, at the booking's own average rate.
      const shift = await matchShift(tx, resource, startTime, endTime, plan?.id ?? null);
      if (shift?.priceCents != null) {
        billableMinutes = duration;
        priceCents = shift.priceCents;
        basis = { type: 'shift', name: shift.name };
      } else {
        priceCents = Math.round(hasExtras(card) ? (roomPriceCents(card, startTime, endTime, hasPlan) * billableMinutes) / duration : (resource.hourlyRateCents * billableMinutes) / 60);
        basis = billableMinutes < duration ? { type: 'minutes', freeMinutes: duration - billableMinutes, billableMinutes } : hasExtras(card) ? { type: 'rates' } : { type: 'hourly', rateCents: resource.hourlyRateCents };
      }
    } else {
      const free = plan?.includesHotDesk ?? false;
      const shift = await matchShift(tx, resource, startTime, endTime, plan?.id ?? null);
      const day = deskPriceCents(card, hasPlan);
      if (free) {
        priceCents = 0;
        basis = { type: 'plan' };
      } else if (shift?.priceCents != null) {
        priceCents = shift.priceCents;
        basis = { type: 'shift', name: shift.name };
      } else if (!timed) {
        priceCents = day;
        basis = { type: 'daily', rateCents: day };
      } else {
        basis = resource.hourlyRateCents > 0 ? { type: 'hourly', rateCents: resource.hourlyRateCents } : { type: 'dayshare', rateCents: day };
        // Part of a day: the hourly rate when the desk has one, otherwise the day price shared out by the hours, and never more than a day.
        const dayMinutes = Math.max(1, toMinutes(closeTime) - toMinutes(openTime));
        const byTime = resource.hourlyRateCents > 0 ? (resource.hourlyRateCents * duration) / 60 : (day * duration) / dayMinutes;
        priceCents = Math.min(day, Math.round(byTime));
      }
      billableMinutes = priceCents > 0 ? duration : 0;
    }

    return {
      row: {
        locationId: resource.locationId,
        resourceId: resource.id,
        memberId: member.id,
        startsAt,
        endsAt,
        billableMinutes,
        priceCents,
        notes: req.notes,
        createdById: actor.id,
      },
      basis,
    };
}

export function createBooking(db: Db, req: BookingRequest, actor: AuthUser, now = new Date()) {
  return db.transaction(async (tx) => tx.insert(bookings).values((await planBooking(tx, req, actor, now)).row).returning().get());
}

/** What booking this would cost, and when it would run, without making it. */
export async function quoteBooking(db: Db, req: BookingRequest, actor: AuthUser, now = new Date()) {
  const { row, basis } = await db.transaction((tx) => planBooking(tx, req, actor, now));
  return { priceCents: row.priceCents, billableMinutes: row.billableMinutes, startsAt: row.startsAt, endsAt: row.endsAt, basis };
}

export function cancelBooking(db: Db, bookingId: string, actor: AuthUser, now = new Date()) {
  return db.transaction(async (tx) => {
    const b = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).get();
    if (!b) throw notFound('Booking');
    if (isStaff(actor)) {
      if (!actor.permissions.includes('bookings')) throw forbidden('You do not have permission to do this');
      assertLocation(actor, b.locationId);
    } else if (actor.memberId !== b.memberId) throw forbidden();

    if (b.status !== 'confirmed') throw conflict(`Booking is already ${b.status.replace('_', ' ')}`);
    if (b.invoiceId) throw conflict('This booking has already been invoiced');
    if (!isStaff(actor) && Date.parse(b.startsAt) <= now.getTime()) {
      throw conflict('Bookings that have started can only be cancelled by staff');
    }
    return tx
      .update(bookings)
      .set({ status: 'cancelled', cancelledAt: now.toISOString() })
      .where(eq(bookings.id, b.id))
      .returning()
      .get();
  });
}
