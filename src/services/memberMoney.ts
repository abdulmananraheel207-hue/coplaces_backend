import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { depositEntries, invoiceItems, invoices, locations, members, PAYMENT_METHODS } from '../db/schema.js';
import { loadMember } from '../lib/access.js';
import { assertLocation, type AuthUser } from '../lib/auth.js';
import { badRequest, conflict } from '../lib/errors.js';
import { addDays, daysBetween, todayIn } from '../lib/time.js';
import { loadLocation } from '../lib/access.js';
import { calcTotals } from './billing.js';

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

const entry = (t: Db, actor: AuthUser, member: { id: string; locationId: string }, kind: 'advance' | 'received' | 'refunded' | 'kept', amountCents: number, method: Method | null, reference: string) =>
  t.insert(depositEntries).values({ locationId: member.locationId, memberId: member.id, kind, amountCents, method, reference, occurredAt: new Date().toISOString(), recordedById: actor.id }).run();

/** Takes what is left of a member's advance off an invoice that is still open and unpaid. */
async function applyToOpenInvoice(t: Db, memberId: string) {
  const m = (await t.select().from(members).where(eq(members.id, memberId)).get())!;
  const left = m.advanceCents - m.advanceUsedCents;
  if (left <= 0 || !m.planStart) return;
  const inv = await t
    .select()
    .from(invoices)
    .where(and(eq(invoices.memberId, memberId), eq(invoices.kind, 'subscription'), eq(invoices.periodStart, m.planStart), eq(invoices.status, 'open'), eq(invoices.paidCents, 0)))
    .orderBy(desc(invoices.createdAt))
    .get();
  if (!inv || inv.subtotalCents <= 0) return;
  const credit = Math.min(left, inv.subtotalCents);
  const loc = (await t.select().from(locations).where(eq(locations.id, inv.locationId)).get())!;
  const totals = calcTotals([{ description: '', quantity: 1, unitPriceCents: inv.subtotalCents - credit }], loc.taxRateBps);
  await t.insert(invoiceItems).values({ invoiceId: inv.id, description: 'Advance paid', quantity: 1, unitPriceCents: -credit, amountCents: -credit }).run();
  await t.update(invoices).set({ ...totals, status: totals.totalCents === 0 ? 'paid' : 'open' }).where(eq(invoices.id, inv.id)).run();
  await t.update(members).set({ advanceUsedCents: m.advanceUsedCents + credit }).where(eq(members.id, memberId)).run();
}

/** Records an advance and/or a security deposit as received now. Each can be taken once; the advance is taken off the period's open invoice. */
export async function recordMemberMoney(t: Db, actor: AuthUser, memberId: string, input: MoneyInput) {
  const { member } = await loadMember(t, memberId);
  assertLocation(actor, member.locationId);
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

/** What is left of the advance, to take off the next invoice, and the line that does it. Updates how much has been used. */
export async function advanceCredit(t: Db, memberId: string, grossCents: number) {
  const m = await t.select().from(members).where(eq(members.id, memberId)).get();
  const left = m ? m.advanceCents - m.advanceUsedCents : 0;
  const credit = Math.min(Math.max(left, 0), grossCents);
  if (credit <= 0 || !m) return null;
  await t.update(members).set({ advanceUsedCents: m.advanceUsedCents + credit }).where(eq(members.id, memberId)).run();
  return { description: 'Advance paid', quantity: 1, unitPriceCents: -credit };
}

/** When an unpaid invoice is voided, the advance it used goes back to the member to be used on the replacement. */
export async function releaseAdvance(db: Db, invoiceId: string, memberId: string) {
  const used = (await db.select({ n: sql<number>`coalesce(sum(-${invoiceItems.amountCents}), 0)` }).from(invoiceItems).where(and(eq(invoiceItems.invoiceId, invoiceId), lt(invoiceItems.amountCents, 0))).get())?.n ?? 0;
  if (used <= 0) return;
  const m = await db.select().from(members).where(eq(members.id, memberId)).get();
  if (m) await db.update(members).set({ advanceUsedCents: Math.max(0, m.advanceUsedCents - used) }).where(eq(members.id, memberId)).run();
}

/**
 * Settles the security deposit: some or all goes back, and anything the space keeps is income. It happens at the end of the plan
 * period (or when the member is no longer active), the same two days' notice as renewing.
 */
export async function settleMemberDeposit(db: Db, actor: AuthUser, memberId: string, input: { action: 'refund' | 'forfeit'; returnedCents?: number | undefined; method: Method; reference: string }) {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const { member } = await loadMember(t, memberId);
    assertLocation(actor, member.locationId);
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
