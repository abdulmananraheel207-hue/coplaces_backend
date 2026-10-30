import { Router } from 'express';
import { and, asc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { BOOKING_STATUSES, attendance, bookings, members, resources, users } from '../db/schema.js';
import { loadLocation, requireLocationId } from '../lib/access.js';
import { assertLocation, isStaff } from '../lib/auth.js';
import { assertCan, requirePermission } from '../lib/permissions.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { isHourly } from '../catalogue.js';
import { idParam, queryString } from '../lib/http.js';
import { addDays, dayRange, isValidDate, TIME_RE, todayIn, zonedToUtc } from '../lib/time.js';
import { byName } from '../lib/sort.js';
import { parse } from '../lib/validate.js';
import { cancelBooking, closedReason, createBooking, isWholeDay as wholeDay, quoteBooking } from '../services/bookings.js';

const dateStr = z.string().refine(isValidDate, 'Use YYYY-MM-DD');
const timeStr = z.string().regex(TIME_RE, 'Use HH:mm');

async function assertRoomOnly(db: Db, resourceId: string) {
  const r = await db.select({ kind: resources.kind }).from(resources).where(eq(resources.id, resourceId)).get();
  if (r && !isHourly(r.kind)) throw forbidden('Desks and offices come with a plan, so members cannot book them');
}

export function bookingsRouter(db: Db) {
  const r = Router();

  /** Everything needed to draw one day's availability grid. */
  r.get('/schedule', async (req, res) => {
    const locationId = requireLocationId(req);
    const loc = await loadLocation(db, locationId);
    const date = queryString(req, 'date') ?? todayIn(loc.timezone);
    if (!isValidDate(date)) throw badRequest('date must be YYYY-MM-DD');
    const range = dayRange(date, loc.timezone);
    const user = req.user!;

    const bookable = (await db
      .select()
      .from(resources)
      .where(and(eq(resources.locationId, locationId), inArray(resources.kind, ['room', 'corporate_room', 'hot_desk'])))
      .all())
      .filter((x) => x.status !== 'retired')
      .sort((a, b) => byName(a.name, b.name));
    const rows = await db
      .select({ b: bookings, memberName: users.name })
      .from(bookings)
      .innerJoin(members, eq(members.id, bookings.memberId))
      .innerJoin(users, eq(users.id, members.userId))
      .where(
        and(
          eq(bookings.locationId, locationId),
          inArray(bookings.status, ['confirmed', 'completed']),
          lt(bookings.startsAt, range.end),
          gte(bookings.endsAt, range.start),
        ),
      )
      .all();

    // Desks someone is sitting at today without a booking of their own show as in use.
    const inUse =
      date === todayIn(loc.timezone)
        ? (await db
            .select({ resourceId: attendance.resourceId, memberId: attendance.memberId, memberName: users.name })
            .from(attendance)
            .innerJoin(members, eq(members.id, attendance.memberId))
            .innerJoin(users, eq(users.id, members.userId))
            .where(and(eq(attendance.locationId, locationId), isNull(attendance.checkOutAt), gte(attendance.checkInAt, range.start), lt(attendance.checkInAt, range.end)))
            .all())
            .filter((a) => a.resourceId)
            .map((a) => ({
              resourceId: a.resourceId!,
              mine: a.memberId === user.memberId,
              memberName: isStaff(user) ? a.memberName : undefined,
            }))
        : [];

    res.json({
      date,
      timezone: loc.timezone,
      inUse,
      closed: await closedReason(db, loc, date),
      openTime: loc.openTime,
      closeTime: loc.closeTime,
      resources: bookable,
      bookings: rows.map(({ b, memberName }) => ({
        id: b.id,
        resourceId: b.resourceId,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
        status: b.status,
        allDay: (() => {
          const res = bookable.find((x) => x.id === b.resourceId);
          return !!res && wholeDay(b, res.kind, res.openTime ?? loc.openTime, res.closeTime ?? loc.closeTime, loc.timezone);
        })(),
        mine: b.memberId === user.memberId,
        // Other members' identities stay private.
        memberId: isStaff(user) ? b.memberId : undefined,
        memberName: isStaff(user) ? memberName : undefined,
      })),
    });
  });

  r.get('/', async (req, res) => {
    const locationId = requireLocationId(req);
    const loc = await loadLocation(db, locationId);
    const user = req.user!;
    const conds = [eq(bookings.locationId, locationId)];

    const memberId = isStaff(user) ? queryString(req, 'memberId') : user.memberId!;
    if (memberId) conds.push(eq(bookings.memberId, memberId));
    const resourceId = queryString(req, 'resourceId');
    if (resourceId) conds.push(eq(bookings.resourceId, resourceId));
    const status = queryString(req, 'status');
    if (status) {
      if (!(BOOKING_STATUSES as readonly string[]).includes(status)) throw badRequest('Unknown status');
      conds.push(eq(bookings.status, status as (typeof BOOKING_STATUSES)[number]));
    }
    const from = queryString(req, 'from');
    const to = queryString(req, 'to');
    if (from) {
      if (!isValidDate(from)) throw badRequest('from must be YYYY-MM-DD');
      conds.push(gte(bookings.startsAt, zonedToUtc(from, '00:00', loc.timezone).toISOString()));
    }
    if (to) {
      if (!isValidDate(to)) throw badRequest('to must be YYYY-MM-DD');
      conds.push(lt(bookings.startsAt, zonedToUtc(addDays(to, 1), '00:00', loc.timezone).toISOString()));
    }

    const rows = await db
      .select({ b: bookings, resourceName: resources.name, resourceKind: resources.kind, resourceOpen: resources.openTime, resourceClose: resources.closeTime, memberName: users.name })
      .from(bookings)
      .innerJoin(resources, eq(resources.id, bookings.resourceId))
      .innerJoin(members, eq(members.id, bookings.memberId))
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(...conds))
      .orderBy(asc(bookings.startsAt))
      .limit(Math.min(Number(queryString(req, 'limit')) || 500, 5000))
      .all();
    res.json(
      rows.map(({ b, resourceOpen, resourceClose, ...rest }) => ({
        ...b,
        ...rest,
        allDay: wholeDay(b, rest.resourceKind, resourceOpen ?? loc.openTime, resourceClose ?? loc.closeTime, loc.timezone),
      })),
    );
  });

  const bookingBody = z.object({
    resourceId: z.string(),
    memberId: z.string().optional(),
    date: dateStr,
    startTime: timeStr.optional(),
    endTime: timeStr.optional(),
    notes: z.string().trim().max(500).default(''),
  });

  /** The price and times of a booking, worked out exactly as making it would, so the form can show them first. */
  r.post('/quote', async (req, res) => {
    const body = parse(bookingBody, req.body);
    const user = req.user!;
    if (isStaff(user)) assertCan(user, 'bookings');
    const memberId = isStaff(user) ? body.memberId : user.memberId;
    if (!memberId) throw badRequest('memberId is required');
    // A member can see what a room would cost, so they know what they are asking for. Desks and offices come with their plan.
    if (!isStaff(user)) await assertRoomOnly(db, body.resourceId);
    res.json(await quoteBooking(db, { ...body, memberId }, user));
  });

  r.post('/', async (req, res) => {
    const body = parse(
      z.object({
        resourceId: z.string(),
        memberId: z.string().optional(),
        date: dateStr,
        startTime: timeStr.optional(),
        endTime: timeStr.optional(),
        notes: z.string().trim().max(500).default(''),
      }),
      req.body,
    );
    const user = req.user!;
    if (isStaff(user)) assertCan(user, 'bookings');
    // Members do not book anything themselves any more: rooms are asked for (see requests), desks and offices come with a plan.
    if (!isStaff(user)) throw forbidden('Members ask the owner for a room instead. Use Request a room on the Book page.');
    const memberId = body.memberId;
    if (!memberId) throw badRequest('memberId is required');
    res.status(201).json(await createBooking(db, { ...body, memberId }, user));
  });

  r.post('/:id/cancel', async (req, res) => {
    res.json(await cancelBooking(db, idParam(req), req.user!));
  });

  // Staff mark a booking completed / no-show (or reinstate it).
  r.patch('/:id', requirePermission('bookings'), async (req, res) => {
    const body = parse(z.object({ status: z.enum(['confirmed', 'completed', 'no_show']) }), req.body);
    const b = await db.select().from(bookings).where(eq(bookings.id, idParam(req))).get();
    if (!b) throw notFound('Booking');
    assertLocation(req.user!, b.locationId);
    if (b.status === 'cancelled') throw badRequest('Cancelled bookings cannot be changed');
    res.json(await db.update(bookings).set({ status: body.status }).where(eq(bookings.id, b.id)).returning().get());
  });

  return r;
}
