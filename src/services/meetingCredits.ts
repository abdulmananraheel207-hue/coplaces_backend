import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memberCreditResources, resources } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';

/**
 * Meeting room credit hours (two make an hour, each month) are given per space: the owner allows a space on the Pricing and credit
 * hours tab, then gives each member some credit hours on it. On any other space the member pays the normal price.
 */

export interface CreditRoom {
  resourceId: string;
  credits: number;
}

/** Sets the spaces a member gets credit hours on, and how many on each, replacing the list. Only spaces of their location that allow credits. */
export async function setCreditResources(t: Db, memberId: string, locationId: string, items: CreditRoom[]) {
  const ids = [...new Set(items.map((i) => i.resourceId))];
  if (ids.length !== items.length) throw badRequest('A space can only be listed once');
  if (ids.length) {
    const found = await t.select({ locationId: resources.locationId, allowed: resources.creditsAllowed }).from(resources).where(inArray(resources.id, ids)).all();
    if (found.length !== ids.length || found.some((r) => r.locationId !== locationId)) throw badRequest('Space does not belong to this location');
    if (found.some((r) => !r.allowed)) throw badRequest('Credit hours are not allowed on one of those spaces. Allow it on the Pricing and credit hours tab first.');
  }
  await t.delete(memberCreditResources).where(eq(memberCreditResources.memberId, memberId)).run();
  if (items.length) await t.insert(memberCreditResources).values(items.map((i) => ({ memberId, resourceId: i.resourceId, credits: i.credits }))).run();
}

/** The spaces a member has credit hours on right now: given to them and still allowed by the owner. */
export async function creditResources(db: Db, memberId: string) {
  return db
    .select({ id: resources.id, name: resources.name, credits: memberCreditResources.credits })
    .from(memberCreditResources)
    .innerJoin(resources, eq(resources.id, memberCreditResources.resourceId))
    .where(and(eq(memberCreditResources.memberId, memberId), eq(resources.creditsAllowed, true)))
    .orderBy(asc(resources.name))
    .all();
}

/**
 * The free minutes used this month. Each space spends its own credit hours first; what goes beyond them comes out of the plan's
 * included minutes, which only meeting rooms (kind "room") can use.
 */
export function freeUsage(used: { resourceId: string; kind: string; free: number }[], credit: { id: string; credits: number }[]) {
  const perSpace = new Map<string, { kind: string; free: number }>();
  for (const u of used) {
    const e = perSpace.get(u.resourceId) ?? { kind: u.kind, free: 0 };
    e.free += u.free;
    perSpace.set(u.resourceId, e);
  }
  const cap = new Map(credit.map((c) => [c.id, c.credits * 30]));
  const creditUsed = new Map<string, number>();
  let planUsed = 0;
  for (const [id, e] of perSpace) {
    const c = Math.min(e.free, cap.get(id) ?? 0);
    creditUsed.set(id, c);
    if (e.kind === 'room') planUsed += e.free - c;
  }
  return { creditUsed, planUsed };
}
