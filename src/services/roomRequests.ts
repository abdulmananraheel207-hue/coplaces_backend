import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { members, resources, roomRequests, users } from '../db/schema.js';
import { isHourly } from '../catalogue.js';
import { assertLocation, isStaff, type AuthUser } from '../lib/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { createBooking, quoteBooking } from './bookings.js';

/**
 * Members cannot book rooms themselves: they ask the owner, who approves or rejects. Anyone can see how many others are
 * already waiting for the same room at an overlapping time, so they know what to expect.
 */

type Request = typeof roomRequests.$inferSelect;
export interface RequestTimes {
  resourceId: string;
  date: string;
  startTime: string;
  endTime: string;
}

/** Pending requests by other people for the same room, on the same day, at an overlapping time. */
export async function queueAhead(db: Db, t: RequestTimes, exceptMemberId?: string) {
  const rows = await db
    .select({ memberId: roomRequests.memberId, startTime: roomRequests.startTime, endTime: roomRequests.endTime })
    .from(roomRequests)
    .where(and(eq(roomRequests.resourceId, t.resourceId), eq(roomRequests.date, t.date), eq(roomRequests.status, 'pending'), exceptMemberId ? ne(roomRequests.memberId, exceptMemberId) : undefined))
    .all();
  return new Set(rows.filter((r) => r.startTime < t.endTime && r.endTime > t.startTime).map((r) => r.memberId)).size;
}

export async function createRequest(db: Db, actor: AuthUser, body: RequestTimes & { notes: string }) {
  if (isStaff(actor) || !actor.memberId) throw forbidden('Only members ask for rooms. Staff book them directly.');
  const resource = await db.select().from(resources).where(eq(resources.id, body.resourceId)).get();
  if (!resource) throw notFound('Resource');
  assertLocation(actor, resource.locationId);
  if (!isHourly(resource.kind)) throw badRequest('Members can ask for meeting rooms, board rooms and other rooms. Desks and offices come with a plan.');
  // Every rule a real booking has (open hours, closed days, 15 minute steps, a time that is already taken) applies to the ask too.
  await quoteBooking(db, { resourceId: body.resourceId, memberId: actor.memberId, date: body.date, startTime: body.startTime, endTime: body.endTime, notes: body.notes }, actor);
  const mine = await db
    .select({ id: roomRequests.id, startTime: roomRequests.startTime, endTime: roomRequests.endTime })
    .from(roomRequests)
    .where(and(eq(roomRequests.memberId, actor.memberId), eq(roomRequests.resourceId, body.resourceId), eq(roomRequests.date, body.date), eq(roomRequests.status, 'pending')))
    .all();
  if (mine.some((r) => r.startTime < body.endTime && r.endTime > body.startTime)) throw conflict('You have already asked for this room at that time');
  const made = await db.insert(roomRequests).values({ ...body, locationId: resource.locationId, memberId: actor.memberId }).returning().get();
  return { ...made, ahead: await queueAhead(db, body, actor.memberId) };
}

async function load(db: Db, actor: AuthUser, id: string) {
  const r = await db.select().from(roomRequests).where(eq(roomRequests.id, id)).get();
  if (!r) throw notFound('Request');
  assertLocation(actor, r.locationId);
  return r;
}

/** The requests of a location for staff, or a member's own. Newest first, pending ones leading. */
export async function listRequests(db: Db, actor: AuthUser, locationId: string, status?: string) {
  const mineOnly = !isStaff(actor);
  const rows = await db
    .select({ r: roomRequests, memberName: users.name, company: members.company, resourceName: resources.name, resourceKind: resources.kind })
    .from(roomRequests)
    .innerJoin(members, eq(members.id, roomRequests.memberId))
    .innerJoin(users, eq(users.id, members.userId))
    .innerJoin(resources, eq(resources.id, roomRequests.resourceId))
    .where(and(eq(roomRequests.locationId, locationId), mineOnly ? eq(roomRequests.memberId, actor.memberId ?? '-') : undefined, status ? inArray(roomRequests.status, status.split(',') as Request['status'][]) : undefined))
    .orderBy(desc(roomRequests.date), asc(roomRequests.startTime))
    .limit(300)
    .all();
  const out = [];
  for (const { r, ...rest } of rows) out.push({ ...r, ...rest, ahead: r.status === 'pending' ? await queueAhead(db, r, r.memberId) : 0 });
  return out.sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'));
}

export async function cancelRequest(db: Db, actor: AuthUser, id: string) {
  const r = await load(db, actor, id);
  if (isStaff(actor) || actor.memberId !== r.memberId) throw forbidden();
  if (r.status !== 'pending') throw conflict(`This request is already ${r.status}`);
  return db.update(roomRequests).set({ status: 'cancelled' }).where(eq(roomRequests.id, r.id)).returning().get();
}

export async function rejectRequest(db: Db, actor: AuthUser, id: string, reason: string) {
  const r = await load(db, actor, id);
  if (r.status !== 'pending') throw conflict(`This request is already ${r.status}`);
  return db.update(roomRequests).set({ status: 'rejected', reason, decidedById: actor.id, decidedAt: new Date().toISOString() }).where(eq(roomRequests.id, r.id)).returning().get();
}

/** Approving makes the booking, charged at the room's usual price, and marks the other asks for that time as taken. */
export async function approveRequest(db: Db, actor: AuthUser, id: string) {
  const r = await load(db, actor, id);
  if (r.status !== 'pending') throw conflict(`This request is already ${r.status}`);
  const booking = await createBooking(db, { resourceId: r.resourceId, memberId: r.memberId, date: r.date, startTime: r.startTime, endTime: r.endTime, notes: r.notes }, actor);
  const now = new Date().toISOString();
  const done = await db.update(roomRequests).set({ status: 'approved', decidedById: actor.id, decidedAt: now, bookingId: booking.id }).where(eq(roomRequests.id, r.id)).returning().get();
  const others = await db.select().from(roomRequests).where(and(eq(roomRequests.resourceId, r.resourceId), eq(roomRequests.date, r.date), eq(roomRequests.status, 'pending'), ne(roomRequests.id, r.id))).all();
  for (const o of others.filter((x) => x.startTime < r.endTime && x.endTime > r.startTime)) {
    await db.update(roomRequests).set({ status: 'taken', reason: 'Another request for this time was approved', decidedAt: now }).where(eq(roomRequests.id, o.id)).run();
  }
  return { ...done, booking };
}
