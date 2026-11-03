import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db, DbLike } from '../db/client.js';
import { MONEY_STATUSES, contracts, depositEntries, invoices, members, payments, users } from '../db/schema.js';
import type { AuthUser } from '../lib/auth.js';
import { assertSees } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { applyContractAdvanceToOpenInvoice, bouncePayment, clearPayment } from './billing.js';
import { applyToOpenInvoice } from './memberMoney.js';
import { audit } from './audit.js';
import { loadLocation } from '../lib/access.js';
import { todayIn, zonedToUtc } from '../lib/time.js';

/**
 * Cheques. A cheque is money promised, not money received: it is recorded as `pending`, counts towards nothing (not the invoice, not
 * money in, not the bank, not the advance or deposit) until it clears, and then counts on the day it cleared. A bounced cheque never
 * counts. Two kinds of cheque come in: payments on invoices (the `payments` table) and advances or security deposits (the ledger).
 * Cheques the space writes (refunds, expenses) leave at once and have no status.
 */

export type ChequeSource = 'payment' | 'entry';
type Status = (typeof MONEY_STATUSES)[number];

/** A cheque for an advance or a deposit that is still waiting to clear, for one member or contract. */
export async function pendingEntry(t: DbLike, who: { memberId?: string; contractId?: string }, kind: 'advance' | 'received') {
  return t
    .select()
    .from(depositEntries)
    .where(
      and(
        who.contractId ? eq(depositEntries.contractId, who.contractId) : eq(depositEntries.memberId, who.memberId!),
        eq(depositEntries.kind, kind),
        eq(depositEntries.status, 'pending'),
      ),
    )
    .get();
}

/**
 * Every cheque that came in at a location, newest first: invoice payments and advances/deposits, in one list.
 * `status` narrows it (pending is what the owner is still waiting for).
 */
export async function listCheques(db: Db, locationId: string, status?: Status) {
  const [pays, entries] = await Promise.all([
    db
      .select({ p: payments, invoiceNumber: invoices.number, memberName: users.name })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .innerJoin(members, eq(members.id, payments.memberId))
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(payments.locationId, locationId), eq(payments.method, 'cheque'), status ? eq(payments.status, status) : undefined))
      .orderBy(desc(payments.paidAt))
      .limit(500)
      .all(),
    db
      .select({ e: depositEntries, memberName: users.name, companyName: contracts.companyName })
      .from(depositEntries)
      .leftJoin(contracts, eq(contracts.id, depositEntries.contractId))
      .leftJoin(members, eq(members.id, depositEntries.memberId))
      .leftJoin(users, eq(users.id, members.userId))
      .where(and(eq(depositEntries.locationId, locationId), eq(depositEntries.method, 'cheque'), inArray(depositEntries.kind, ['advance', 'received']), status ? eq(depositEntries.status, status) : undefined))
      .orderBy(desc(depositEntries.occurredAt))
      .limit(500)
      .all(),
  ]);
  // A contract's own payer, for the ledger rows that are on a contract.
  const contractIds = [...new Set(entries.map((x) => x.e.contractId).filter((x): x is string => !!x))];
  const payers = contractIds.length
    ? await db.select({ id: contracts.id, name: users.name }).from(contracts).innerJoin(members, eq(members.id, contracts.memberId)).innerJoin(users, eq(users.id, members.userId)).where(inArray(contracts.id, contractIds)).all()
    : [];
  const rows = [
    ...pays.map(({ p, invoiceNumber, memberName }) => ({
      source: 'payment' as const,
      id: p.id,
      kind: 'invoice' as const,
      who: memberName,
      memberId: p.memberId,
      contractId: null as string | null,
      invoiceId: p.invoiceId,
      invoiceNumber,
      amountCents: p.amountCents,
      reference: p.reference,
      receivedAt: p.paidAt,
      status: p.status,
      clearedAt: p.clearedAt,
      bouncedAt: p.bouncedAt,
    })),
    ...entries.map(({ e, memberName, companyName }) => ({
      source: 'entry' as const,
      id: e.id,
      kind: e.kind === 'advance' ? ('advance' as const) : ('deposit' as const),
      who: companyName || payers.find((x) => x.id === e.contractId)?.name || memberName || '',
      memberId: e.memberId,
      contractId: e.contractId,
      invoiceId: null as string | null,
      invoiceNumber: null as string | null,
      amountCents: e.amountCents,
      reference: e.reference,
      receivedAt: e.occurredAt,
      status: e.status,
      clearedAt: e.clearedAt,
      bouncedAt: e.bouncedAt,
    })),
  ];
  return rows.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

async function loadEntry(t: DbLike, actor: AuthUser, id: string) {
  const e = await t.select().from(depositEntries).where(eq(depositEntries.id, id)).get();
  if (!e || e.method !== 'cheque' || (e.kind !== 'advance' && e.kind !== 'received')) throw notFound('Cheque');
  assertSees(actor, e.locationId, 'Cheque');
  return e;
}

/**
 * An advance or deposit cheque cleared. Only now is the money taken: the advance becomes the member's (or the contract's) and comes off
 * their open invoice, the deposit is held. Counted in the books on `clearedAt`.
 */
async function clearEntry(db: Db, actor: AuthUser, id: string, clearedAt: string) {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const e = await loadEntry(t, actor, id);
    if (e.status !== 'pending') throw conflict(e.status === 'cleared' ? 'This cheque has already cleared' : 'This cheque bounced');
    if (clearedAt.slice(0, 10) < e.occurredAt.slice(0, 10)) throw badRequest('A cheque cannot clear before it was received');
    if (clearedAt < e.occurredAt) clearedAt = e.occurredAt;
    await t.update(depositEntries).set({ status: 'cleared', clearedAt }).where(eq(depositEntries.id, e.id)).run();
    if (e.contractId) {
      if (e.kind === 'advance') {
        await t.update(contracts).set({ advanceReceivedAt: clearedAt }).where(eq(contracts.id, e.contractId)).run();
        await applyContractAdvanceToOpenInvoice(t, e.contractId);
      } else await t.update(contracts).set({ depositStatus: 'held' }).where(eq(contracts.id, e.contractId)).run();
    } else if (e.memberId) {
      if (e.kind === 'advance') {
        await t.update(members).set({ advanceCents: e.amountCents, advanceReceivedAt: clearedAt }).where(eq(members.id, e.memberId)).run();
        await applyToOpenInvoice(t, e.memberId);
      } else await t.update(members).set({ depositCents: e.amountCents, depositStatus: 'held' }).where(eq(members.id, e.memberId)).run();
    }
    await audit(t, { organizationId: actor.organizationId, locationId: e.locationId, actorId: actor.id, action: 'cheque.clear', entity: e.contractId ? 'contract' : 'member', entityId: (e.contractId ?? e.memberId)!, amountCents: e.amountCents, data: { entryId: e.id, kind: e.kind, reference: e.reference, clearedAt } });
    return t.select().from(depositEntries).where(eq(depositEntries.id, e.id)).get();
  });
}

/** An advance or deposit cheque bounced. Nothing was ever taken, so it can simply be received again (in any channel). */
async function bounceEntry(db: Db, actor: AuthUser, id: string, reason: string) {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const e = await loadEntry(t, actor, id);
    if (e.status !== 'pending') throw conflict(e.status === 'cleared' ? 'This cheque has already cleared' : 'This cheque already bounced');
    const now = new Date().toISOString();
    await t.update(depositEntries).set({ status: 'bounced', bouncedAt: now }).where(eq(depositEntries.id, e.id)).run();
    await audit(t, { organizationId: actor.organizationId, locationId: e.locationId, actorId: actor.id, action: 'cheque.bounce', entity: e.contractId ? 'contract' : 'member', entityId: (e.contractId ?? e.memberId)!, amountCents: e.amountCents, data: { entryId: e.id, kind: e.kind, reference: e.reference, reason } });
    return t.select().from(depositEntries).where(eq(depositEntries.id, e.id)).get();
  });
}

/** The instant a cheque cleared: now for today (or no day given), midday local time for an earlier day. */
async function clearedInstant(db: Db, locationId: string, clearedOn: string | undefined, now = new Date()) {
  if (!clearedOn) return now.toISOString();
  const { timezone } = await loadLocation(db, locationId);
  const today = todayIn(timezone, now);
  if (clearedOn > today) throw badRequest('A cheque cannot clear in the future');
  return clearedOn === today ? now.toISOString() : zonedToUtc(clearedOn, '12:00', timezone).toISOString();
}

/** Marks any cheque cleared, whichever table it is in, on `clearedOn` (a local day; today if left out). */
export async function clearCheque(db: Db, actor: AuthUser, source: ChequeSource, id: string, clearedOn?: string) {
  if (source === 'entry') {
    const e = await loadEntry(db, actor, id);
    return { entry: await clearEntry(db, actor, id, await clearedInstant(db, e.locationId, clearedOn)) };
  }
  const p = await db.select().from(payments).where(eq(payments.id, id)).get();
  if (!p || p.method !== 'cheque') throw notFound('Cheque');
  assertSees(actor, p.locationId, 'Cheque');
  return { invoice: await clearPayment(db, p.id, actor.id, await clearedInstant(db, p.locationId, clearedOn)) };
}

/** Marks any cheque bounced, whichever table it is in. */
export async function bounceCheque(db: Db, actor: AuthUser, source: ChequeSource, id: string, reason: string) {
  if (source === 'entry') return { entry: await bounceEntry(db, actor, id, reason) };
  const p = await db.select().from(payments).where(eq(payments.id, id)).get();
  if (!p || p.method !== 'cheque') throw notFound('Cheque');
  assertSees(actor, p.locationId, 'Cheque');
  return { invoice: await bouncePayment(db, p.id, actor.id, reason) };
}
