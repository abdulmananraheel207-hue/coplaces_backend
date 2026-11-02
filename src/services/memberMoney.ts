import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { depositEntries, invoiceItems, invoices, locations, members, PAYMENT_METHODS } from '../db/schema.js';
import { loadMember } from '../lib/access.js';
import { assertLocation, assertSees, type AuthUser } from '../lib/auth.js';
import { badRequest, conflict } from '../lib/errors.js';
import { addDays, daysBetween, todayIn } from '../lib/time.js';
import { loadLocation } from '../lib/access.js';
import { creditOpenInvoice } from './billing.js';
import { audit } from './audit.js';

/**
 * A member's advance and security deposit.
 *
 * The advance is rent paid up front: it is income the day it is received, and it is taken off the shift prices on their invoices
 * until it is used up. The security deposit is held for them and is not income; it is settled at the end of their plan period,
 * and only what the space keeps becomes income. Both go in the same ledger the finance reports already read.
 */

type Method = (typeof PAYMENT_METHODS)[number];
export interface MoneyInput {
  advanceCents?: number | undefined;
  depositCents?: number | undefined;
  method: Method;
  reference: string;
}

/** How many days before a plan period ends the deposit may be settled, the same window as renewing. */
const SETTLE_DAYS_BEFORE = 2;

const ACTIONS = { advance: 'advance.receive', received: 'deposit.receive', refunded: 'deposit.refund', kept: 'deposit.keep' } as const;

/** One movement of a member's money: written to the ledger the reports read, and to the audit log. */
async function entry(t: Db, actor: AuthUser, member: { id: string; locationId: string }, kind: 'advance' | 'received' | 'refunded' | 'kept', amountCents: number, method: Method | null, reference: string) {
  await t.insert(depositEntries).values({ locationId: member.locationId, memberId: member.id, kind, amountCents, method, reference, occurredAt: new Date().toISOString(), recordedById: actor.id }).run();
  await audit(t, { organizationId: actor.organizationId, locationId: member.locationId, actorId: actor.id, action: ACTIONS[kind], entity: 'member', entityId: member.id, amountCents, data: { method, reference } });
}

/**
 * Takes what is left of a member's advance off their newest invoice that is still open and unpaid: the invoice of the current plan
 * period for a member with shifts, otherwise their newest monthly invoice. The invoice keeps the tax rate it was issued at.
 */
async function applyToOpenInvoice(t: Db, memberId: string) {
  const m = (await t.select().from(members).where(eq(members.id, memberId)).get())!;
  const left = m.advanceCents - m.advanceUsedCents;
  if (left <= 0) return;
  const inv = await t
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.memberId, memberId),
        eq(invoices.kind, 'subscription'),
        isNull(invoices.contractId),
        m.planStart ? eq(invoices.periodStart, m.planStart) : undefined,
        eq(invoices.status, 'open'),
        eq(invoices.paidCents, 0),
      ),
    )
    .orderBy(desc(invoices.createdAt))
    .get();
  if (!inv) return;
  const took = await creditOpenInvoice(t, inv, { description: 'Advance paid', category: 'advance' }, left);
  if (took > 0) await t.update(members).set({ advanceUsedCents: m.advanceUsedCents + took }).where(eq(members.id, memberId)).run();
}

/** Records an advance and/or a security deposit as received now. Each can be taken once; the advance is taken off the period's open invoice. */
export async function recordMemberMoney(t: Db, actor: AuthUser, memberId: string, input: MoneyInput) {
  const { member } = await loadMember(t, memberId);
  assertSees(actor, member.locationId, 'Member');
  const advance = input.advanceCents ?? 0;
  const deposit = input.depositCents ?? 0;
  if (advance < 0 || deposit < 0) throw badRequest('Amounts cannot be negative');
  if (advance > 0) {
    if (member.advanceReceivedAt) throw conflict('The advance was already received, so it cannot be added again');
    await entry(t, actor, member, 'advance', advance, input.method, input.reference);
    await t.update(members).set({ advanceCents: advance, advanceReceivedAt: new Date().toISOString() }).where(eq(members.id, member.id)).run();
  }
  if (deposit > 0) {
    if (member.depositStatus !== 'pending') throw conflict('The security deposit was already received');
    await entry(t, actor, member, 'received', deposit, input.method, input.reference);
    await t.update(members).set({ depositCents: deposit, depositStatus: 'held' }).where(eq(members.id, member.id)).run();
  }
  if (advance > 0) await applyToOpenInvoice(t, member.id);
}

/**
 * Settles the security deposit: some or all goes back, and anything the space keeps is income. It happens at the end of the plan
 * period (or when the member is no longer active), the same two days' notice as renewing.
 */
export async function settleMemberDeposit(db: Db, actor: AuthUser, memberId: string, input: { action: 'refund' | 'forfeit'; returnedCents?: number | undefined; method: Method; reference: string }) {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const { member } = await loadMember(t, memberId);
    assertSees(actor, member.locationId, 'Member');
    if (member.depositStatus !== 'held') throw conflict('There is no security deposit being held');
    const today = todayIn((await loadLocation(t, member.locationId)).timezone);
    const open = member.status === 'active' && !!member.planEnd && daysBetween(today, member.planEnd) > SETTLE_DAYS_BEFORE;
    if (open) throw conflict(`The security deposit is settled at the end of the plan period. It opens on ${addDays(member.planEnd!, -SETTLE_DAYS_BEFORE)}`);
    const returned = input.action === 'forfeit' ? 0 : (input.returnedCents ?? member.depositCents);
    if (returned > member.depositCents) throw badRequest('Cannot return more than the security deposit');
    if (returned > 0) await entry(t, actor, member, 'refunded', returned, input.method, input.reference);
    if (returned < member.depositCents) await entry(t, actor, member, 'kept', member.depositCents - returned, null, input.reference);
    return t.update(members).set({ depositStatus: returned === 0 ? 'forfeited' : 'refunded', depositReturnedCents: returned }).where(eq(members.id, member.id)).returning().get();
  });
}
