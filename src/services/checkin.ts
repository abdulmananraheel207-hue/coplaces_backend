import { and, eq, gte, inArray, isNull, lt, lte, ne, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { attendance, bookings, resourceAssignments, resources, users, members } from '../db/schema.js';
import { loadLocation } from '../lib/access.js';
import { badRequest, conflict } from '../lib/errors.js';
import { dayRange, localDate, localTime, toMinutes, todayIn, zonedToUtc } from '../lib/time.js';
import { isHourly } from '../catalogue.js';
import { closedReason, weekdayOf } from './bookings.js';

const LIVE = ['confirmed', 'completed'] as const;
/** Spaces a person can be checked in at. Lockers, parking and the like are not places to sit. */
const PLACES = ['room', 'corporate_room', 'hot_desk', 'dedicated_desk', 'office'];
/** How early before a room booking starts someone may be checked in, in minutes. */
const EARLY = 30;

/**
 * Closes visits left open from an earlier day: someone who forgot to check out is taken to have left when the building closed.
 * Done whenever people are checked in or the "in the building" list is read, so nothing stays open overnight.
 */
export async function closeStaleVisits(db: Db, locationId: string, now = new Date()) {
  const loc = await loadLocation(db, locationId);
  const todayStart = dayRange(todayIn(loc.timezone, now), loc.timezone).start;
  const stale = await db
    .select()
    .from(attendance)
    .where(and(eq(attendance.locationId, locationId), isNull(attendance.checkOutAt), lt(attendance.checkInAt, todayStart)))
    .all();
  for (const a of stale) {
    const closing = zonedToUtc(localDate(a.checkInAt, loc.timezone), loc.closeTime, loc.timezone).toISOString();
    const left = closing > a.checkInAt ? closing : a.checkInAt;
    await db.update(attendance).set({ checkOutAt: left }).where(eq(attendance.id, a.id)).run();
    await finishBookingOnCheckOut(db, a, new Date(a.checkInAt));
  }
}

/**
 * Checks a member in, at a space or at the door. Everything that has to agree is decided here: the building is open,
 * the space is theirs to use (booked, rented or free), and nobody else is on it.
 */
export async function checkInMember(db: Db, member: { id: string; locationId: string }, resourceId: string | null, now = new Date()) {
  const loc = await loadLocation(db, member.locationId);
  const tz = loc.timezone;
  const todayDate = todayIn(tz, now);
  const day = dayRange(todayDate, tz);
  await closeStaleVisits(db, member.locationId, now);

  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const open = await tx
      .select({ id: attendance.id })
      .from(attendance)
      .where(and(eq(attendance.memberId, member.id), isNull(attendance.checkOutAt)))
      .get();
    if (open) throw conflict('Already checked in');

    const closed = await closedReason(t, loc, todayDate);
    if (closed) throw badRequest(`${closed}, so nobody can check in today`);

    // What the member has booked today, and what is rented to them. Someone with a space of their own can come at any hour.
    const mine = await tx
      .select({ b: bookings, kind: resources.kind, name: resources.name })
      .from(bookings)
      .innerJoin(resources, eq(resources.id, bookings.resourceId))
      .where(and(eq(bookings.memberId, member.id), inArray(bookings.status, [...LIVE]), lt(bookings.startsAt, day.end), gte(bookings.endsAt, day.start)))
      .all();
    const rented = await tx
      .select({ id: resourceAssignments.id })
      .from(resourceAssignments)
      .where(and(eq(resourceAssignments.memberId, member.id), lte(resourceAssignments.startDate, todayDate), or(isNull(resourceAssignments.endDate), gte(resourceAssignments.endDate, todayDate))))
      .all();
    // A hot desk can be booked for part of a day, so someone may hold several. The one that matters is the one running now, or else the next to start.
    const nowMs = now.getTime();
    const deskBookings = mine.filter((x) => x.kind === 'hot_desk').sort((a, b) => a.b.startsAt.localeCompare(b.b.startsAt));
    const deskBooking = deskBookings.find((x) => nowMs >= Date.parse(x.b.startsAt) - EARLY * 60_000 && nowMs < Date.parse(x.b.endsAt)) ?? deskBookings.find((x) => Date.parse(x.b.endsAt) > nowMs) ?? deskBookings[0];
    const bookedDeskIds = new Set(deskBookings.map((x) => x.b.resourceId));

    let target = resourceId ? await tx.select().from(resources).where(eq(resources.id, resourceId)).get() : undefined;
    if (resourceId) {
      if (!target || target.locationId !== member.locationId) throw badRequest('Unknown space for this location');
      if (!PLACES.includes(target.kind)) throw badRequest(`${target.name} is not somewhere to check in`);
      if (target.status === 'retired') throw conflict(`${target.name} has been retired`);
    } else if (deskBooking) {
      target = await tx.select().from(resources).where(eq(resources.id, deskBooking.b.resourceId)).get();
    }

    const here = target ? mine.filter((x) => x.b.resourceId === target!.id).sort((a, b) => a.b.startsAt.localeCompare(b.b.startsAt)) : [];
    let booking = here.find((x) => nowMs >= Date.parse(x.b.startsAt) - EARLY * 60_000 && nowMs < Date.parse(x.b.endsAt)) ?? here.find((x) => Date.parse(x.b.endsAt) > nowMs) ?? here[0];
    let relocate = false;

    if (target) {
      const hourly = isHourly(target.kind);
      const available = target.status === 'available';

      if (hourly) {
        // A room is for the people who booked it, at the time they booked it.
        if (!booking) throw conflict(`${target.name} is not booked by this member today. Book it first.`);
        const from = Date.parse(booking.b.startsAt) - EARLY * 60_000;
        if (now.getTime() < from || now.getTime() >= Date.parse(booking.b.endsAt)) {
          throw conflict(`Their booking for ${target.name} is from ${localTime(booking.b.startsAt, tz)} to ${localTime(booking.b.endsAt, tz)}`);
        }
        if (!available) throw conflict(`${target.name} is not available (${target.status.replace('_', ' ')})`);
      } else {
        // A member who booked a desk sits at that desk. If it has gone out of service they can be moved to another free one.
        if (deskBooking && !bookedDeskIds.has(target.id)) {
          const bookedDesk = (await tx.select().from(resources).where(eq(resources.id, deskBooking.b.resourceId)).get())!;
          if (bookedDesk.status === 'available') throw conflict(`This member booked ${deskBooking.name} today, so they can only check in there`);
          relocate = target.kind === 'hot_desk';
          if (!relocate) throw conflict(`${deskBooking.name} is not available (${bookedDesk.status.replace('_', ' ')}). Move them to another hot desk.`);
        }
        // A desk booked for a time is theirs from just before it starts until it ends.
        if (booking && target.kind === 'hot_desk' && (nowMs < Date.parse(booking.b.startsAt) - EARLY * 60_000 || nowMs >= Date.parse(booking.b.endsAt))) {
          throw conflict(`Their booking for ${target.name} is from ${localTime(booking.b.startsAt, tz)} to ${localTime(booking.b.endsAt, tz)}`);
        }
        if (!available) {
          const hint = deskBooking && bookedDeskIds.has(target.id) ? ' Pick another hot desk for them and their booking moves with them.' : '';
          throw conflict(`${target.name} is not available (${target.status.replace('_', ' ')}).${hint}`);
        }

        // Rented to somebody else.
        const owner = await tx
          .select({ name: users.name })
          .from(resourceAssignments)
          .innerJoin(members, eq(members.id, resourceAssignments.memberId))
          .innerJoin(users, eq(users.id, members.userId))
          .where(
            and(
              eq(resourceAssignments.resourceId, target.id),
              ne(resourceAssignments.memberId, member.id),
              lte(resourceAssignments.startDate, todayDate),
              or(isNull(resourceAssignments.endDate), gte(resourceAssignments.endDate, todayDate)),
            ),
          )
          .get();
        if (owner) throw conflict(`${target.name} is assigned to ${owner.name}`);

        // Booked by someone else today, or someone is sitting there now.
        const bookedBy = await tx
          .select({ name: users.name })
          .from(bookings)
          .innerJoin(members, eq(members.id, bookings.memberId))
          .innerJoin(users, eq(users.id, members.userId))
          .where(
            and(
              eq(bookings.resourceId, target.id),
              ne(bookings.memberId, member.id),
              inArray(bookings.status, [...LIVE]),
              // Booked by someone else for the time being, or for the next hour.
              lt(bookings.startsAt, new Date(nowMs + 60 * 60_000).toISOString()),
              gte(bookings.endsAt, now.toISOString()),
            ),
          )
          .get();
        if (bookedBy) throw conflict(`${target.name} is booked today by ${bookedBy.name}`);
        const sitting = await tx
          .select({ name: users.name })
          .from(attendance)
          .innerJoin(members, eq(members.id, attendance.memberId))
          .innerJoin(users, eq(users.id, members.userId))
          .where(and(eq(attendance.resourceId, target.id), isNull(attendance.checkOutAt), ne(attendance.memberId, member.id), gte(attendance.checkInAt, day.start), lt(attendance.checkInAt, day.end)))
          .get();
        if (sitting) throw conflict(`${target.name} is in use by ${sitting.name}`);
      }

      if (target.closedWeekdays?.split(',').includes(String(weekdayOf(todayDate)))) throw badRequest(`${target.name} is closed on this day of the week`);
    }

    // Opening hours: the space's own, else the building's.
    if (!rented.length) {
      const openTime = target?.openTime ?? loc.openTime;
      const closeTime = target?.closeTime ?? loc.closeTime;
      const nowTime = localTime(now, tz);
      if (toMinutes(nowTime) < toMinutes(openTime) || toMinutes(nowTime) >= toMinutes(closeTime)) {
        throw badRequest(`${target ? target.name : loc.name} is open ${openTime} to ${closeTime}, so nobody can check in now`);
      }
    }

    if (relocate && deskBooking && target) {
      await tx.update(bookings).set({ resourceId: target.id }).where(eq(bookings.id, deskBooking.b.id)).run();
      booking = { ...deskBooking, b: { ...deskBooking.b, resourceId: target.id } };
    }
    if (booking && !booking.b.checkedInAt) await tx.update(bookings).set({ checkedInAt: now.toISOString() }).where(eq(bookings.id, booking.b.id)).run();

    return tx
      .insert(attendance)
      .values({ locationId: member.locationId, memberId: member.id, resourceId: target?.id ?? null, checkInAt: now.toISOString() })
      .returning()
      .get();
  });
}

/** Checking out finishes the booking the member checked in for. */
export async function finishBookingOnCheckOut(db: Db, row: { memberId: string; resourceId: string | null; locationId: string }, now = new Date()) {
  if (!row.resourceId) return;
  const tz = (await loadLocation(db, row.locationId)).timezone;
  const day = dayRange(todayIn(tz, now), tz);
  await db.update(bookings)
    .set({ status: 'completed' })
    .where(
      and(
        eq(bookings.memberId, row.memberId),
        eq(bookings.resourceId, row.resourceId),
        eq(bookings.status, 'confirmed'),
        lt(bookings.startsAt, day.end),
        gte(bookings.endsAt, day.start),
        // Only a booking they really checked in for.
        ne(bookings.checkedInAt, ''),
      ),
    )
    .run();
}
