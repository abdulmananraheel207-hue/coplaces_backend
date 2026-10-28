import { Router } from 'express';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { CONTRACT_STATUSES, PAYMENT_METHODS, contracts, depositEntries, members, resources, users } from '../db/schema.js';
import { loadMember, requireLocationId } from '../lib/access.js';
import { assertLocation } from '../lib/auth.js';
import { requirePermission } from '../lib/permissions.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { idParam, queryString } from '../lib/http.js';
import { isValidDate } from '../lib/time.js';
import { parse } from '../lib/validate.js';
import { activateContract, endContract } from '../services/contracts.js';

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
    res.json(rows.map(({ c, ...rest }) => ({ ...c, ...rest })));
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
