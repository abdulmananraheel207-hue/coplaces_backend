import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { amenities, amenityOrders, memberAmenities, members, users } from '../db/schema.js';
import { loadLocation, loadMember } from '../lib/access.js';
import { assertLocation, type AuthUser } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { todayIn } from '../lib/time.js';

/**
 * Amenities the owner hands out (tea, coffee, food). Each member can get some free every day; anything beyond that is charged at
 * the amenity's price. The charge is not put on an invoice: it is an amount the front desk collects, shown on finance and to the member.
 */

export interface FreeAmenity {
  amenityId: string;
  freePerDay: number;
}

/** Sets which amenities a member gets free each day, replacing what they had. */
export async function setMemberAmenities(t: Db, memberId: string, locationId: string, items: FreeAmenity[]) {
  const ids = [...new Set(items.map((i) => i.amenityId))];
  if (ids.length !== items.length) throw badRequest('An amenity can only be listed once');
  if (ids.length) {
    const found = await t.select({ id: amenities.id, locationId: amenities.locationId }).from(amenities).where(inArray(amenities.id, ids)).all();
    if (found.length !== ids.length || found.some((a) => a.locationId !== locationId)) throw badRequest('Amenity does not belong to this location');
  }
  await t.delete(memberAmenities).where(eq(memberAmenities.memberId, memberId)).run();
  for (const i of items) await t.insert(memberAmenities).values({ memberId, amenityId: i.amenityId, freePerDay: i.freePerDay }).run();
}

/** What a member gets free each day, with the amenity's name and price and how many they have had today. */
export async function memberAllowance(db: Db, memberId: string, today: string) {
  const rows = await db
    .select({ amenityId: amenities.id, name: amenities.name, priceCents: amenities.priceCents, active: amenities.active, freePerDay: memberAmenities.freePerDay })
    .from(memberAmenities)
    .innerJoin(amenities, eq(amenities.id, memberAmenities.amenityId))
    .where(eq(memberAmenities.memberId, memberId))
    .orderBy(asc(amenities.name))
    .all();
  const had = await db
    .select({ amenityId: amenityOrders.amenityId, n: sql<number>`coalesce(sum(${amenityOrders.quantity}), 0)` })
    .from(amenityOrders)
    .where(and(eq(amenityOrders.memberId, memberId), eq(amenityOrders.date, today)))
    .groupBy(amenityOrders.amenityId)
    .all();
  return rows.map((r) => ({ ...r, usedToday: had.find((h) => h.amenityId === r.amenityId)?.n ?? 0 }));
}

/** What a member owes for amenities that has not been collected yet. */
export async function amenityOwed(db: Db, memberId: string) {
  return (await db
    .select({ v: sql<number>`coalesce(sum(${amenityOrders.chargeCents}), 0)` })
    .from(amenityOrders)
    .where(and(eq(amenityOrders.memberId, memberId), isNull(amenityOrders.collectedAt)))
    .get())!.v;
}

/** Records an amenity given to a member. The first ones of the day, up to their free amount, cost nothing; the rest are charged. */
export function giveAmenity(db: Db, actor: AuthUser, input: { memberId: string; amenityId: string; quantity: number }) {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const { member } = await loadMember(t, input.memberId);
    assertLocation(actor, member.locationId);
    if (member.status !== 'active') throw badRequest('Only active members can be given amenities');
    const amenity = await t.select().from(amenities).where(eq(amenities.id, input.amenityId)).get();
    if (!amenity || amenity.locationId !== member.locationId) throw notFound('Amenity');
    if (!amenity.active) throw badRequest(`${amenity.name} is not being offered`);
    const today = todayIn((await loadLocation(t, member.locationId)).timezone);
    const mine = await t.select().from(memberAmenities).where(and(eq(memberAmenities.memberId, member.id), eq(memberAmenities.amenityId, amenity.id))).get();
    const had = (await memberAllowance(t, member.id, today)).find((a) => a.amenityId === amenity.id)?.usedToday ?? 0;
    const free = Math.min(input.quantity, Math.max(0, (mine?.freePerDay ?? 0) - had));
    const chargeCents = (input.quantity - free) * amenity.priceCents;
    return t
      .insert(amenityOrders)
      .values({ locationId: member.locationId, memberId: member.id, amenityId: amenity.id, name: amenity.name, date: today, quantity: input.quantity, freeQuantity: free, chargeCents, collectedAt: chargeCents ? null : new Date().toISOString(), recordedById: actor.id })
      .returning()
      .get();
  });
}

/** Marks everything a member owes for amenities as collected. */
export async function collectAmenities(db: Db, actor: AuthUser, memberId: string) {
  const { member } = await loadMember(db, memberId);
  assertLocation(actor, member.locationId);
  const owed = await amenityOwed(db, member.id);
  if (owed <= 0) throw conflict('This member owes nothing for amenities');
  await db.update(amenityOrders).set({ collectedAt: new Date().toISOString() }).where(and(eq(amenityOrders.memberId, member.id), isNull(amenityOrders.collectedAt))).run();
  return { collectedCents: owed };
}

/** Recent amenity orders for a location, newest first, optionally for one member. */
export async function listOrders(db: Db, locationId: string, memberId?: string) {
  const rows = await db
    .select({ o: amenityOrders, memberName: users.name })
    .from(amenityOrders)
    .innerJoin(members, eq(members.id, amenityOrders.memberId))
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(amenityOrders.locationId, locationId), memberId ? eq(amenityOrders.memberId, memberId) : undefined))
    .orderBy(desc(amenityOrders.createdAt))
    .limit(200)
    .all();
  return rows.map(({ o, memberName }) => ({ ...o, memberName }));
}

/** For finance: what is owed and by whom, and what was collected in a stretch of time (income on the day it was collected). */
export async function amenityFinance(db: Db, locationId: string, start: string, end: string) {
  const owedRows = await db
    .select({ memberId: amenityOrders.memberId, name: users.name, owedCents: sql<number>`sum(${amenityOrders.chargeCents})` })
    .from(amenityOrders)
    .innerJoin(members, eq(members.id, amenityOrders.memberId))
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(amenityOrders.locationId, locationId), isNull(amenityOrders.collectedAt)))
    .groupBy(amenityOrders.memberId, users.name)
    .all();
  const collected = await db
    .select({ amountCents: amenityOrders.chargeCents, paidAt: amenityOrders.collectedAt })
    .from(amenityOrders)
    .where(and(eq(amenityOrders.locationId, locationId), sql`${amenityOrders.chargeCents} > 0`, sql`${amenityOrders.collectedAt} >= ${start}`, sql`${amenityOrders.collectedAt} < ${end}`))
    .all();
  return {
    owedRows: owedRows.filter((r) => r.owedCents > 0).sort((a, b) => b.owedCents - a.owedCents),
    collected: collected.map((c) => ({ amountCents: c.amountCents, paidAt: c.paidAt! })),
  };
}
