import { Router } from 'express';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { CONTRACT_STATUSES, PAYMENT_METHODS, PRICING_MODES, bookings, contractPeople, contractSpaces, contracts, depositEntries, members, resourceAssignments, resources, users } from '../db/schema.js';
import { loadMember, requireLocationId } from '../lib/access.js';
import { assertLocation } from '../lib/auth.js';
import { requirePermission } from '../lib/permissions.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { idParam, queryString } from '../lib/http.js';
import { isValidDate } from '../lib/time.js';
import { parse } from '../lib/validate.js';
import { isAssigned } from '../catalogue.js';
import { addPerson, createCompanyContract, discardCompanyDraft, extendContract, refreshRent, removePerson, setContractSpaces } from '../services/companyContracts.js';
import { monthCharges, monthlyTotal } from '../services/contractPricing.js';
import { activateContract, endContract } from '../services/contracts.js';
import { loadLocation } from '../lib/access.js';
import { addDays, zonedToUtc } from '../lib/time.js';

const dateStr = z.string().refine(isValidDate, 'Use YYYY-MM-DD');

const contractFields = z.object({
  memberId: z.string(),
  resourceId: z.string().nullable(),
  startDate: dateStr,
  endDate: dateStr.nullable(),
  rentCents: z.number().int().min(0),
  depositCents: z.number().int().min(0),
  advanceCents: z.number().int().min(0),
  notes: z.string().trim().max(1000),
});

const money = z.number().int().min(0).max(1_000_000_000_000);
const pricing = {
  pricingMode: z.enum(PRICING_MODES),
  pricePerMemberCents: money,
  extraMemberCents: money,
  fixedPriceCents: money,
};
const person = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().pipe(z.email()),
  phone: z.string().trim().max(40).default(''),
  password: z.string().min(8, 'Passwords need at least 8 characters').max(100),
  deskResourceId: z.string().nullable().default(null),
  joinDate: dateStr.optional(),
});
const companyBody = z.object({
  locationId: z.string(),
  companyName: z.string().trim().min(1).max(120),
  companyEmail: z.string().trim().max(200).default(''),
  companyPhone: z.string().trim().max(40).default(''),
  startDate: dateStr,
  endDate: dateStr.nullable().default(null),
  ...pricing,
  advanceCents: money.default(0),
  depositCents: money.default(0),
  notes: z.string().trim().max(1000).default(''),
  spaceIds: z.array(z.string()).max(50).default([]),
  people: z.array(person).min(1).max(200),
});

/** Checks the member and space of a contract belong to the location and the space can be rented. */
async function checkParties(db: Db, locationId: string, memberId: string, resourceId: string | null) {
  const { member } = await loadMember(db, memberId);
  if (member.locationId !== locationId) throw badRequest('Member belongs to a different location');
  if (resourceId) {
    const r = await db.select().from(resources).where(eq(resources.id, resourceId)).get();
    if (!r || r.locationId !== locationId) throw notFound('Space');
    if (r.status === 'retired') throw badRequest(`${r.name} has been retired and cannot be rented`);
  }
}

/** Rent and deposits are sensitive, so the whole router needs the contracts permission. */
export function contractsRouter(db: Db) {
  const r = Router();
  r.use(requirePermission('contracts'));

  r.get('/', async (req, res) => {
    const locationId = requireLocationId(req);
    const conds = [eq(contracts.locationId, locationId)];
    const status = queryString(req, 'status');
    if (status) {
      if (!(CONTRACT_STATUSES as readonly string[]).includes(status)) throw badRequest('Unknown status');
      conds.push(eq(contracts.status, status as (typeof CONTRACT_STATUSES)[number]));
    }
    const memberId = queryString(req, 'memberId');
    if (memberId) conds.push(eq(contracts.memberId, memberId));
    const rows = await db
      .select({ c: contracts, memberName: users.name, company: members.company, resourceName: resources.name })
      .from(contracts)
      .innerJoin(members, eq(members.id, contracts.memberId))
      .innerJoin(users, eq(users.id, members.userId))
      .leftJoin(resources, eq(resources.id, contracts.resourceId))
      .where(and(...conds))
      .orderBy(desc(contracts.startDate))
      .limit(500)
      .all();
    // Company contracts also carry who is on them and which spaces they share.
    const ids = rows.filter(({ c }) => c.companyName).map(({ c }) => c.id);
    const people = ids.length
      ? await db
          .select({ p: contractPeople, name: users.name, email: users.email, phone: users.phone, deskName: resources.name })
          .from(contractPeople)
          .innerJoin(members, eq(members.id, contractPeople.memberId))
          .innerJoin(users, eq(users.id, members.userId))
          .leftJoin(resources, eq(resources.id, contractPeople.deskResourceId))
          .where(inArray(contractPeople.contractId, ids))
          .orderBy(asc(contractPeople.joinDate), asc(users.name))
          .all()
      : [];
    const shared = ids.length
      ? await db.select({ contractId: contractSpaces.contractId, id: resources.id, name: resources.name, kind: resources.kind, capacity: resources.capacity }).from(contractSpaces).innerJoin(resources, eq(resources.id, contractSpaces.resourceId)).where(inArray(contractSpaces.contractId, ids)).all()
      : [];
    res.json(
      rows.map(({ c, ...rest }) => {
        const mine = people.filter((x) => x.p.contractId === c.id).map((x) => ({ id: x.p.id, memberId: x.p.memberId, name: x.name, email: x.email, phone: x.phone, deskResourceId: x.p.deskResourceId, deskName: x.deskName, joinDate: x.p.joinDate, leaveDate: x.p.leaveDate }));
        const spaces = shared.filter((x) => x.contractId === c.id).map(({ contractId: _c, ...s }) => s);
        const seats = spaces.reduce((s, x) => s + x.capacity, 0);
        const here = mine.filter((x) => !x.leaveDate);
        return { ...c, ...rest, people: mine, spaces, seats, extraPeople: Math.max(0, here.filter((x) => !x.deskResourceId).length - seats) };
      }),
    );
  });

  // ---- Company contracts ---------------------------------------------------------------------------------------------------

  /** Rooms and desks a company could take over those dates, and whether each is free for all of them. */
  r.get('/available-spaces', async (req, res) => {
    const locationId = requireLocationId(req);
    const start = queryString(req, 'startDate');
    const end = queryString(req, 'endDate') || null;
    if (!start || !isValidDate(start) || (end && !isValidDate(end))) throw badRequest('Give the dates as YYYY-MM-DD');
    const loc = await loadLocation(db, locationId);
    const kinds = ['room', 'corporate_room', 'hot_desk', 'dedicated_desk', 'office'];
    const rows = (await db.select().from(resources).where(eq(resources.locationId, locationId)).all()).filter((x) => kinds.includes(x.kind) && x.status === 'available');
    const taken = await db
      .select({ resourceId: resourceAssignments.resourceId })
      .from(resourceAssignments)
      .where(and(or(isNull(resourceAssignments.endDate), gte(resourceAssignments.endDate, start)), end ? lte(resourceAssignments.startDate, end) : undefined))
      .all();
    const from = zonedToUtc(start, '00:00', loc.timezone).toISOString();
    const booked = await db
      .select({ resourceId: bookings.resourceId })
      .from(bookings)
      .where(and(inArray(bookings.status, ['confirmed']), gte(bookings.endsAt, from), end ? lte(bookings.startsAt, zonedToUtc(addDays(end, 1), '00:00', loc.timezone).toISOString()) : undefined))
      .all();
    res.json(
      rows.map((x) => {
        const busy = taken.some((t) => t.resourceId === x.id) ? 'Already rented in that time' : !isAssigned(x.kind) && booked.some((b) => b.resourceId === x.id) ? 'Has bookings in that time' : null;
        return { id: x.id, name: x.name, kind: x.kind, floor: x.floor, capacity: x.capacity, free: !busy, busy };
      }),
    );
  });

  /** What a company would pay each month, worked out by the server so the form and the invoice always agree. */
  r.post('/quote', async (req, res) => {
    const body = parse(z.object({ locationId: z.string(), ...pricing, people: z.array(z.object({ hasDesk: z.boolean() })).max(200), spaceIds: z.array(z.string()).max(50) }), req.body);
    assertLocation(req.user!, body.locationId);
    const spaces = body.spaceIds.length ? await db.select().from(resources).where(and(inArray(resources.id, body.spaceIds), eq(resources.locationId, body.locationId))).all() : [];
    const seats = spaces.reduce((s, x) => s + x.capacity, 0);
    const t = { ...body, startDate: '2000-01-01', endDate: null };
    const people = body.people.map((p, i) => ({ ...p, name: `Person ${i + 1}`, joinDate: '2000-01-01', leaveDate: null }));
    res.json({ seats, ...monthlyTotal(t, body.people, seats), lines: monthCharges(t, people, seats, '2001-01-01', '2001-02-01') });
  });

  r.post('/company', async (req, res) => {
    const body = parse(companyBody, req.body);
    res.status(201).json(await createCompanyContract(db, req.user!, body));
  });

  // Prices and details can change at any time (invoices already sent are not touched); dates only while a draft, then use extend.
  r.patch('/:id/company', async (req, res) => {
    const body = parse(
      z.object({ companyName: z.string().trim().min(1).max(120), companyEmail: z.string().trim().max(200), companyPhone: z.string().trim().max(40), startDate: dateStr, endDate: dateStr.nullable(), ...pricing, advanceCents: money, depositCents: money, notes: z.string().trim().max(1000) }).partial(),
      req.body,
    );
    const c = await db.select().from(contracts).where(eq(contracts.id, idParam(req))).get();
    if (!c || !c.companyName) throw notFound('Contract');
    assertLocation(req.user!, c.locationId);
    if (c.status === 'ended' || c.status === 'cancelled') throw conflict(`This contract is ${c.status}`);
    if (c.status !== 'draft' && (body.startDate !== undefined || body.endDate !== undefined)) throw conflict('Dates can only be changed on a draft. Use Extend to move the end of a running contract.');
    if (c.advanceReceivedAt && body.advanceCents !== undefined && body.advanceCents !== c.advanceCents) throw conflict('The advance was already received, so its amount cannot change');
    if (c.depositStatus !== 'pending' && body.depositCents !== undefined && body.depositCents !== c.depositCents) throw conflict('The security deposit was already received, so its amount cannot change');
    const next = { ...c, ...body };
    if (next.endDate && next.endDate < next.startDate) throw badRequest('End date is before start date');
    const updated = await db.update(contracts).set(body).where(eq(contracts.id, c.id)).returning().get();
    if (body.companyName) for (const p of await db.select({ m: contractPeople.memberId }).from(contractPeople).where(eq(contractPeople.contractId, c.id)).all()) await db.update(members).set({ company: body.companyName }).where(eq(members.id, p.m)).run();
    await refreshRent(db, c.id);
    res.json(updated);
  });

  r.post('/:id/people', async (req, res) => {
    const body = parse(person, req.body);
    res.status(201).json(await addPerson(db, req.user!, idParam(req), body));
  });

  r.post('/:id/people/:personId/leave', async (req, res) => {
    const body = parse(z.object({ date: dateStr.optional() }), req.body);
    await removePerson(db, req.user!, idParam(req), String(req.params.personId), body.date);
    res.status(204).end();
  });

  r.put('/:id/spaces', async (req, res) => {
    const body = parse(z.object({ resourceIds: z.array(z.string()).max(50) }), req.body);
    await setContractSpaces(db, req.user!, idParam(req), body.resourceIds);
    res.status(204).end();
  });

  r.post('/:id/extend', async (req, res) => {
    const body = parse(z.object({ endDate: dateStr }), req.body);
    res.json(await extendContract(db, req.user!, idParam(req), body.endDate));
  });

  r.post('/', async (req, res) => {
    const body = parse(contractFields.partial({ resourceId: true, endDate: true, rentCents: true, depositCents: true, advanceCents: true, notes: true }).extend({ locationId: z.string() }), req.body);
    assertLocation(req.user!, body.locationId);
    const v = { resourceId: null, endDate: null, rentCents: 0, depositCents: 0, advanceCents: 0, notes: '', ...body };
    if (v.endDate && v.endDate < v.startDate) throw badRequest('End date is before start date');
    await checkParties(db, v.locationId, v.memberId, v.resourceId);
    res.status(201).json(await db.insert(contracts).values({ ...v, createdById: req.user!.id }).returning().get());
  });

  // A draft can be changed freely; once it is running only the notes can.
  r.patch('/:id', async (req, res) => {
    const body = parse(contractFields.partial(), req.body);
    const c = await db.select().from(contracts).where(eq(contracts.id, idParam(req))).get();
    if (!c) throw notFound('Contract');
    assertLocation(req.user!, c.locationId);
    if (c.companyName) throw badRequest('Company contracts are changed from the company contract screen');
    if (c.status !== 'draft' && Object.keys(body).some((k) => k !== 'notes')) throw conflict('Only the notes can be changed once a contract has started');
    // Money already taken cannot be rewritten; the ledger would no longer match the contract.
    if (c.advanceReceivedAt && body.advanceCents !== undefined && body.advanceCents !== c.advanceCents) throw conflict('The advance was already received, so its amount cannot change');
    if (c.depositStatus !== 'pending' && body.depositCents !== undefined && body.depositCents !== c.depositCents) throw conflict('The security deposit was already received, so its amount cannot change');
    const next = { ...c, ...body };
    if (next.endDate && next.endDate < next.startDate) throw badRequest('End date is before start date');
    await checkParties(db, c.locationId, next.memberId, next.resourceId);
    res.json(await db.update(contracts).set(body).where(eq(contracts.id, c.id)).returning().get());
  });

  r.post('/:id/activate', async (req, res) => {
    res.json(await activateContract(db, req.user!, idParam(req)));
  });

  r.post('/:id/end', async (req, res) => {
    const body = parse(z.object({ endDate: dateStr.optional() }), req.body);
    res.json(await endContract(db, req.user!, idParam(req), body.endDate));
  });

  r.post('/:id/cancel', async (req, res) => {
    const c = await db.select().from(contracts).where(eq(contracts.id, idParam(req))).get();
    if (!c) throw notFound('Contract');
    assertLocation(req.user!, c.locationId);
    if (c.status !== 'draft') throw conflict('Only a draft can be cancelled. End a running contract instead.');
    if (c.companyName) {
      await discardCompanyDraft(db, req.user!, c.id);
      res.json({ ...c, status: 'cancelled' });
      return;
    }
    if (c.advanceReceivedAt || c.depositStatus !== 'pending') throw conflict('Money was already received on this contract. Start and end it instead, then settle the security deposit.');
    res.json(await db.update(contracts).set({ status: 'cancelled' }).where(eq(contracts.id, c.id)).returning().get());
  });

  // The money movements of one contract's deposit, oldest first.
  r.get('/:id/deposit-entries', async (req, res) => {
    const c = await db.select().from(contracts).where(eq(contracts.id, idParam(req))).get();
    if (!c) throw notFound('Contract');
    assertLocation(req.user!, c.locationId);
    res.json(await db.select().from(depositEntries).where(eq(depositEntries.contractId, c.id)).orderBy(asc(depositEntries.occurredAt)).all());
  });

  // The advance is rent taken up front, so it is income as soon as it is received.
  r.post('/:id/advance', async (req, res) => {
    const body = parse(z.object({ method: z.enum(PAYMENT_METHODS).default('cash'), reference: z.string().trim().max(100).default('') }), req.body);
    const user = req.user!;
    const out = await db.transaction(async (tx) => {
      const c = await tx.select().from(contracts).where(eq(contracts.id, idParam(req))).get();
      if (!c) throw notFound('Contract');
      assertLocation(user, c.locationId);
      if (c.advanceCents <= 0) throw badRequest('This contract has no advance');
      if (c.advanceReceivedAt) throw conflict('The advance was already received');
      if (c.status === 'cancelled') throw conflict('This contract was cancelled');
      const now = new Date().toISOString();
      await tx.insert(depositEntries)
        .values({ locationId: c.locationId, contractId: c.id, kind: 'advance', amountCents: c.advanceCents, method: body.method, reference: body.reference, occurredAt: now, recordedById: user.id })
        .run();
      return tx.update(contracts).set({ advanceReceivedAt: now }).where(eq(contracts.id, c.id)).returning().get();
    });
    res.json(out);
  });

  // A security deposit is money held for the member, not income. Each movement is written to the ledger so it can be matched
  // against cash and the bank; only what the space keeps becomes income, and only when it is kept.
  r.post('/:id/deposit', async (req, res) => {
    const body = parse(
      z.object({
        action: z.enum(['receive', 'refund', 'forfeit']),
        returnedCents: z.number().int().min(0).optional(),
        method: z.enum(PAYMENT_METHODS).default('cash'),
        reference: z.string().trim().max(100).default(''),
      }),
      req.body,
    );
    const user = req.user!;
    const out = await db.transaction(async (tx) => {
      const c = await tx.select().from(contracts).where(eq(contracts.id, idParam(req))).get();
      if (!c) throw notFound('Contract');
      assertLocation(user, c.locationId);
      const now = new Date().toISOString();
      const entry = (kind: 'received' | 'refunded' | 'kept', amountCents: number) =>
        tx
          .insert(depositEntries)
          .values({ locationId: c.locationId, contractId: c.id, kind, amountCents, method: kind === 'kept' ? null : body.method, reference: body.reference, occurredAt: now, recordedById: user.id })
          .run();
      if (body.action === 'receive') {
        if (c.depositCents <= 0) throw badRequest('This contract has no security deposit');
        if (c.depositStatus !== 'pending') throw conflict('The security deposit was already received');
        await entry('received', c.depositCents);
        return tx.update(contracts).set({ depositStatus: 'held' }).where(eq(contracts.id, c.id)).returning().get();
      }
      if (c.depositStatus !== 'held') throw conflict('There is no security deposit being held');
      if (c.status === 'active' || c.status === 'draft') throw conflict('End the contract before settling its security deposit');
      const returned = body.action === 'forfeit' ? 0 : (body.returnedCents ?? c.depositCents);
      if (returned > c.depositCents) throw badRequest('Cannot return more than the security deposit');
      if (returned > 0) await entry('refunded', returned);
      if (returned < c.depositCents) await entry('kept', c.depositCents - returned);
      return tx
        .update(contracts)
        .set({ depositStatus: body.action === 'forfeit' ? 'forfeited' : 'refunded', depositReturnedCents: returned })
        .where(eq(contracts.id, c.id))
        .returning()
        .get();
    });
    res.json(out);
  });

  return r;
}
