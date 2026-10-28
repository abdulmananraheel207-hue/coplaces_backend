import { and, eq, gt, gte, inArray, isNull, lt, lte, ne, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { bookings, contracts, resourceAssignments, resources } from '../db/schema.js';
import { isAssigned } from '../catalogue.js';
import { loadLocation, loadMember } from '../lib/access.js';
import { assertLocation, type AuthUser } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { addDays, todayIn, zonedToUtc } from '../lib/time.js';


/** Gives a dedicated desk or office to a member for a period. Used by assignments and by contracts. */
export async function assignSpace(db: Db, actor: AuthUser, body: { resourceId: string; memberId: string; startDate: string; endDate: string | null }) {
  const resource = await db.select().from(resources).where(eq(resources.id, body.resourceId)).get();
  if (!resource) throw notFound('Resource');
  assertLocation(actor, resource.locationId);
  if (resource.status !== 'available') throw conflict(`${resource.name} is not available (${resource.status})`);
  const { member } = await loadMember(db, body.memberId);
  if (member.locationId !== resource.locationId) throw badRequest('Member belongs to a different location');
  if (member.status !== 'active') throw badRequest('Only active members can be assigned a space');
  if (body.endDate && body.endDate < body.startDate) throw badRequest('End date is before start date');

  // A room or hot desk that is normally booked can still be rented to one member, as long as nobody else has it booked in that time.
  if (!isAssigned(resource.kind)) {
    const tz = (await loadLocation(db, resource.locationId)).timezone;
    const from = zonedToUtc(body.startDate, '00:00', tz).toISOString();
    const clash = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.resourceId, resource.id),
          ne(bookings.memberId, body.memberId),
          inArray(bookings.status, ['confirmed', 'completed']),
          gt(bookings.endsAt, from),
          body.endDate ? lt(bookings.startsAt, zonedToUtc(addDays(body.endDate, 1), '00:00', tz).toISOString()) : undefined,
        ),
      )
      .get();
    if (clash) throw conflict(`${resource.name} has bookings by other members in that period. Cancel them first.`);
  }

  const overlapping = await db
    .select({ id: resourceAssignments.id })
    .from(resourceAssignments)
    .where(
      and(
        eq(resourceAssignments.resourceId, resource.id),
        or(isNull(resourceAssignments.endDate), gte(resourceAssignments.endDate, body.startDate)),
        body.endDate ? lte(resourceAssignments.startDate, body.endDate) : undefined,
      ),
    )
    .get();
  if (overlapping) throw conflict(`${resource.name} is already assigned for part of that period`);
  return db.insert(resourceAssignments).values(body).returning().get();
}

async function load(db: Db, actor: AuthUser, id: string) {
  const c = await db.select().from(contracts).where(eq(contracts.id, id)).get();
  if (!c) throw notFound('Contract');
  assertLocation(actor, c.locationId);
  return c;
}

/** Draft to active. A contract on a space hands the space to the member from the start date. */
export function activateContract(db: Db, actor: AuthUser, id: string) {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const c = await load(t, actor, id);
    if (c.status !== 'draft') throw conflict(`This contract is already ${c.status}`);
    const assignment = c.resourceId ? await assignSpace(t, actor, { resourceId: c.resourceId, memberId: c.memberId, startDate: c.startDate, endDate: c.endDate }) : null;
    return t.update(contracts).set({ status: 'active', assignmentId: assignment?.id ?? null }).where(eq(contracts.id, c.id)).returning().get();
  });
}

/** Active to ended on a date (today by default); the space is free again after it. */
export function endContract(db: Db, actor: AuthUser, id: string, date?: string) {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const c = await load(t, actor, id);
    if (c.status !== 'active') throw conflict('Only an active contract can be ended');
    const endDate = date ?? todayIn((await loadLocation(t, c.locationId)).timezone);
    if (endDate < c.startDate) throw badRequest('End date is before the contract started');
    if (c.assignmentId) {
      // An end date is the last day the member has the space, so ending it today frees it from today: the assignment stops the day before,
      // or disappears if it never had a day of its own.
      const today = todayIn((await loadLocation(t, c.locationId)).timezone);
      const last = endDate <= today ? addDays(endDate, -1) : endDate;
      const a = await t.select().from(resourceAssignments).where(eq(resourceAssignments.id, c.assignmentId)).get();
      if (a && last < a.startDate) await t.delete(resourceAssignments).where(eq(resourceAssignments.id, a.id)).run();
      else if (a) await t.update(resourceAssignments).set({ endDate: last }).where(eq(resourceAssignments.id, a.id)).run();
    }
    return t.update(contracts).set({ status: 'ended', endDate }).where(eq(contracts.id, c.id)).returning().get();
  });
}

