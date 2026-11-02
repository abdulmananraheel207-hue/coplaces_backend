import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { amenities, amenityOrders, amenityRequests, memberAmenities, members, users } from '../db/schema.js';
import { loadLocation, loadMember } from '../lib/access.js';
import { assertLocation, isStaff, type AuthUser } from '../lib/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { addDays, todayIn } from '../lib/time.js';
import { amenityItems, createInvoice } from './billing.js';

/**
 * Amenities the owner hands out (tea, coffee, food). Each member can get some free every day; anything beyond that is charged at
 * the amenity's price. The charge is not collected on the spot: it goes on the member's next invoice, or the front desk can collect
 * it at the desk, and either way it shows on finance and to the member.
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
  if (items.length) await t.insert(memberAmenities).values(items.map((i) => ({ memberId, amenityId: i.amenityId, freePerDay: i.freePerDay }))).run();
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

/**
 * Everything the space offers, for the member to order from, with how many of each they get free each day (none for an amenity
 * the owner did not tick for them: they can still order it, and pay the price) and how many they have had today.
 */
export async function memberMenu(db: Db, memberId: string, locationId: string, today: string) {
  const offered = await db.select().from(amenities).where(and(eq(amenities.locationId, locationId), eq(amenities.active, true))).orderBy(asc(amenities.name)).all();
  const free = new Map((await db.select().from(memberAmenities).where(eq(memberAmenities.memberId, memberId)).all()).map((m) => [m.amenityId, m.freePerDay]));
  const had = await db
    .select({ amenityId: amenityOrders.amenityId, n: sql<number>`coalesce(sum(${amenityOrders.quantity}), 0)` })
    .from(amenityOrders)
    .where(and(eq(amenityOrders.memberId, memberId), eq(amenityOrders.date, today)))
    .groupBy(amenityOrders.amenityId)
    .all();
  return offered.map((a) => ({ amenityId: a.id, name: a.name, priceCents: a.priceCents, active: a.active, freePerDay: free.get(a.id) ?? 0, usedToday: had.find((h) => h.amenityId === a.id)?.n ?? 0 }));
}

/** What a member owes for amenities that is not collected and not on an invoice yet. (What is on an invoice is owed through the invoice.) */
export async function amenityOwed(db: Db, memberId: string) {
  return (await db
    .select({ v: sql<number>`coalesce(sum(${amenityOrders.chargeCents}), 0)` })
    .from(amenityOrders)
    .where(and(eq(amenityOrders.memberId, memberId), isNull(amenityOrders.collectedAt), isNull(amenityOrders.invoiceId)))
    .get())!.v;
}

/** Records an amenity given to a member. The first ones of the day, up to their free amount, cost nothing; the rest are charged. */
async function record(t: Db, actor: AuthUser, input: { memberId: string; amenityId: string; quantity: number }) {
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
}

export const giveAmenity = (db: Db, actor: AuthUser, input: { memberId: string; amenityId: string; quantity: number }) => db.transaction((tx) => record(tx as unknown as Db, actor, input));

/** Marks everything a member owes for amenities at the desk as collected. */
export async function collectAmenities(db: Db, actor: AuthUser, memberId: string) {
  const { member } = await loadMember(db, memberId);
  assertLocation(actor, member.locationId);
  const owed = await amenityOwed(db, member.id);
  if (owed <= 0) throw conflict('This member owes nothing for amenities');
  await db.update(amenityOrders).set({ collectedAt: new Date().toISOString() }).where(and(eq(amenityOrders.memberId, member.id), isNull(amenityOrders.collectedAt), isNull(amenityOrders.invoiceId))).run();
  return { collectedCents: owed };
}

/** Puts what a member owes for amenities on an invoice now, instead of waiting for the monthly invoices. */
export async function invoiceAmenities(db: Db, actor: AuthUser, memberId: string) {
  const { member } = await loadMember(db, memberId);
  assertLocation(actor, member.locationId);
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const items = await amenityItems(t, [member.id]);
    if (!items.length) throw conflict('This member owes nothing for amenities');
    const today = todayIn((await loadLocation(t, member.locationId)).timezone);
    return createInvoice(t, { locationId: member.locationId, memberId: member.id, kind: 'manual', issueDate: today, dueDate: addDays(today, 7), items, notes: 'Tea, coffee and food beyond the free amount' });
  });
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

/** For finance: what is owed at the desk and by whom, and what was collected in a stretch of time (income on the day it was collected). */
export async function amenityFinance(db: Db, locationId: string, start: string, end: string) {
  const owedRows = await db
    .select({ memberId: amenityOrders.memberId, name: users.name, owedCents: sql<number>`sum(${amenityOrders.chargeCents})` })
    .from(amenityOrders)
    .innerJoin(members, eq(members.id, amenityOrders.memberId))
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(amenityOrders.locationId, locationId), isNull(amenityOrders.collectedAt), isNull(amenityOrders.invoiceId)))
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

// ---------------------------------------------------------------------------------------------
// Members asking for the amenities they get free

const MAX_WAITING = 10;

/**
 * A member asks the front desk for an amenity the space offers. Their free amount (if the owner gave them one) comes off first and
 * the rest is charged. Nothing is recorded until the front desk serves it.
 */
export async function requestAmenity(db: Db, actor: AuthUser, input: { amenityId: string; quantity: number }) {
  if (isStaff(actor) || !actor.memberId) throw forbidden('Members ask for amenities. The front desk records them directly.');
  const { member } = await loadMember(db, actor.memberId);
  if (member.status !== 'active') throw badRequest('Only active members can ask for amenities');
  const amenity = await db.select().from(amenities).where(eq(amenities.id, input.amenityId)).get();
  if (!amenity || amenity.locationId !== member.locationId) throw notFound('Amenity');
  if (!amenity.active) throw badRequest('That is not being offered right now');
  const waiting = (await db.select({ n: sql<number>`count(*)` }).from(amenityRequests).where(and(eq(amenityRequests.memberId, member.id), eq(amenityRequests.status, 'pending'))).get())!.n;
  if (waiting >= MAX_WAITING) throw conflict('You already have several requests waiting. Wait for the front desk to bring them.');
  return db.insert(amenityRequests).values({ locationId: member.locationId, memberId: member.id, amenityId: amenity.id, quantity: input.quantity }).returning().get();
}

/** Requests for a location for the front desk, or a member's own. Waiting ones first. */
export async function listAmenityRequests(db: Db, actor: AuthUser, locationId: string, pendingOnly = false) {
  const mineOnly = !isStaff(actor);
  const rows = await db
    .select({ r: amenityRequests, memberName: users.name, name: amenities.name, priceCents: amenities.priceCents })
    .from(amenityRequests)
    .innerJoin(members, eq(members.id, amenityRequests.memberId))
    .innerJoin(users, eq(users.id, members.userId))
    .innerJoin(amenities, eq(amenities.id, amenityRequests.amenityId))
    .where(and(eq(amenityRequests.locationId, locationId), mineOnly ? eq(amenityRequests.memberId, actor.memberId ?? '-') : undefined, pendingOnly ? eq(amenityRequests.status, 'pending') : undefined))
    .orderBy(desc(amenityRequests.createdAt))
    .limit(60)
    .all();
  return rows.map(({ r, ...rest }) => ({ ...r, ...rest })).sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'));
}

async function loadRequest(db: Db, actor: AuthUser, id: string) {
  const r = await db.select().from(amenityRequests).where(eq(amenityRequests.id, id)).get();
  if (!r) throw notFound('Request');
  assertLocation(actor, r.locationId);
  if (r.status !== 'pending') throw conflict(`This request is already ${r.status}`);
  return r;
}

/** The front desk brings it: the amenity is recorded for the member, free up to their daily amount and charged beyond it. */
export function serveAmenityRequest(db: Db, actor: AuthUser, id: string) {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const req = await loadRequest(t, actor, id);
    const order = await record(t, actor, { memberId: req.memberId, amenityId: req.amenityId, quantity: req.quantity });
    const done = await t.update(amenityRequests).set({ status: 'served', decidedById: actor.id, decidedAt: new Date().toISOString(), orderId: order.id }).where(eq(amenityRequests.id, req.id)).returning().get();
    return { ...done, order };
  });
}

export async function declineAmenityRequest(db: Db, actor: AuthUser, id: string, reason: string) {
  const req = await loadRequest(db, actor, id);
  return db.update(amenityRequests).set({ status: 'declined', reason, decidedById: actor.id, decidedAt: new Date().toISOString() }).where(eq(amenityRequests.id, req.id)).returning().get();
}

export async function cancelAmenityRequest(db: Db, actor: AuthUser, id: string) {
  const req = await loadRequest(db, actor, id);
  if (isStaff(actor) || actor.memberId !== req.memberId) throw forbidden();
  return db.update(amenityRequests).set({ status: 'cancelled' }).where(eq(amenityRequests.id, req.id)).returning().get();
}
