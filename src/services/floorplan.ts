import { and, eq, gt, gte, isNull, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { bookings, resourceAssignments } from '../db/schema.js';
import { loadLocation } from '../lib/access.js';
import { conflict } from '../lib/errors.js';
import { todayIn } from '../lib/time.js';

/**
 * Taking a space out of use (retiring it) must not strand anyone: it is refused while it has bookings still
 * to come or is assigned to a member.
 */
export async function assertRetirable(db: Db, resource: { id: string; name: string; locationId: string }, now = new Date()) {
  const upcoming = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.resourceId, resource.id), eq(bookings.status, 'confirmed'), gt(bookings.endsAt, now.toISOString())))
    .get();
  if (upcoming) throw conflict(`${resource.name} has bookings coming up. Cancel them first, then remove it.`);

  const today = todayIn((await loadLocation(db, resource.locationId)).timezone, now);
  const assigned = await db
    .select({ id: resourceAssignments.id })
    .from(resourceAssignments)
    .where(and(eq(resourceAssignments.resourceId, resource.id), or(isNull(resourceAssignments.endDate), gte(resourceAssignments.endDate, today))))
    .get();
  if (assigned) throw conflict(`${resource.name} is assigned to a member. End the assignment first, then remove it.`);
}
