import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { locations, members, users } from '../db/schema.js';
import { assertLocation, isStaff, type AuthUser } from './auth.js';
import { badRequest, forbidden, notFound } from './errors.js';

export function requireLocationId(req: Request, source: 'query' | 'body' = 'query'): string {
  const raw = (source === 'query' ? req.query.locationId : req.body?.locationId) as unknown;
  if (typeof raw !== 'string' || !raw) throw badRequest('locationId is required');
  assertLocation(req.user!, raw);
  return raw;
}

export async function loadLocation(db: Db, id: string) {
  const loc = await db.select().from(locations).where(eq(locations.id, id)).get();
  if (!loc) throw notFound('Location');
  return loc;
}

export async function loadMember(db: Db, id: string) {
  const row = await db
    .select({ member: members, user: users })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(eq(members.id, id))
    .get();
  if (!row) throw notFound('Member');
  return row;
}

/** Staff may touch members in their locations; a member only themself. */
export function assertMemberAccess(user: AuthUser, member: { id: string; locationId: string }) {
  if (isStaff(user)) assertLocation(user, member.locationId);
  else if (user.memberId !== member.id) throw forbidden();
}
