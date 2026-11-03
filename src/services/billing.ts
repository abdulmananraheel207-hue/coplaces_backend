import { and, asc, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { Db, DbLike } from '../db/client.js';
import { LINE_CATEGORIES, amenityOrders, bookings, contractPeople, contracts, invoiceItems, invoices, locations, members, payments, plans, resources, users } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { INVOICE_MAX, MONEY_MAX, QUANTITY_MAX } from '../lib/money.js';
import { addDays, localDate, localTime, monthRange, todayIn } from '../lib/time.js';
import { loadLocation } from '../lib/access.js';
import { monthCharges } from './contractPricing.js';
import { seatsOf } from './companyContracts.js';
import { audit } from './audit.js';

export type Invoice = typeof invoices.$inferSelect;
export type PaymentMethod = (typeof payments.$inferSelect)['method'];

export interface LineItem {
  description: string;
  quantity: number;
  unitPriceCents: number;
  bookingId?: string | undefined;
  /** An amenity order this line bills, so the order is not billed again. */
  amenityOrderId?: string | undefined;
  /** What the line is for; `manual` when not given. */
  category?: LineCategory | undefined;
  resourceId?: string | null | undefined;
  planId?: string | null | undefined;
}

export type LineCategory = (typeof LINE_CATEGORIES)[number];

export interface NewInvoice {
  locationId: string;
  memberId: string;
  kind: 'subscription' | 'manual';
  issueDate: string;
  dueDate: string;
  periodStart?: string | undefined;
  items: LineItem[];
  notes?: string | undefined;
  /** The contract a rent invoice is for. */
  contractId?: string | undefined;
  /** Who made it, for the audit log. Every invoice made on someone's behalf is logged. */
  actorId?: string | undefined;
}

/** Refuses lines whose amounts, or whose total, could not be held exactly. Checked before anything is multiplied. */
export function assertSafeLines(items: LineItem[]) {
  let total = 0;
  for (const i of items) {
    if (!Number.isSafeInteger(i.quantity) || i.quantity < 1 || i.quantity > QUANTITY_MAX) throw badRequest('A line quantity must be a whole number from 1 to 10,000');
    if (!Number.isSafeInteger(i.unitPriceCents) || Math.abs(i.unitPriceCents) > MONEY_MAX) throw badRequest('A line price is too large');
    if (Math.abs(i.unitPriceCents) > INVOICE_MAX / i.quantity) throw badRequest('That line comes to more than an invoice can hold');
    total += i.quantity * i.unitPriceCents;
    if (Math.abs(total) > INVOICE_MAX) throw badRequest('That invoice comes to more than an invoice can hold');
  }
}

export function calcTotals(items: LineItem[], taxRateBps: number) {
  const subtotalCents = items.reduce((s, i) => s + i.quantity * i.unitPriceCents, 0);
  const taxCents = Math.round((subtotalCents * taxRateBps) / 10_000);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

export async function createInvoice(db: DbLike, input: NewInvoice): Promise<Invoice> {
  if (input.items.length === 0) throw badRequest('An invoice needs at least one line item');
  assertSafeLines(input.items);
  const loc = await db.select().from(locations).where(eq(locations.id, input.locationId)).get();
  if (!loc) throw notFound('Location');

  const { seq } = (await db
    .update(locations)
    .set({ invoiceSeq: sql`${locations.invoiceSeq} + 1` })
    .where(eq(locations.id, loc.id))
    .returning({ seq: locations.invoiceSeq })
    .get())!;
  const totals = calcTotals(input.items, loc.taxRateBps);

  const invoice = await db
    .insert(invoices)
    .values({
      locationId: loc.id,
      memberId: input.memberId,
      number: `${loc.code}-${String(seq).padStart(5, '0')}`,
      kind: input.kind,
      status: totals.totalCents === 0 ? 'paid' : 'open',
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      periodStart: input.periodStart ?? null,
      taxRateBps: loc.taxRateBps,
      contractId: input.contractId ?? null,
      notes: input.notes ?? '',
      ...totals,
    })
    .returning()
    .get();

  for (const item of input.items) {
    await db.insert(invoiceItems)
      .values({
        invoiceId: invoice.id,
        description: item.description,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        amountCents: item.quantity * item.unitPriceCents,
        bookingId: item.bookingId ?? null,
        category: item.category ?? 'manual',
        resourceId: item.resourceId ?? null,
        planId: item.planId ?? null,
      })
      .run();
    if (item.bookingId) {
      await db.update(bookings).set({ invoiceId: invoice.id }).where(eq(bookings.id, item.bookingId)).run();
    }
  }
  const amenityIds = input.items.flatMap((i) => (i.amenityOrderId ? [i.amenityOrderId] : []));
  if (amenityIds.length) await db.update(amenityOrders).set({ invoiceId: invoice.id }).where(inArray(amenityOrders.id, amenityIds)).run();
  if (input.actorId) {
    await audit(db, {
      organizationId: loc.organizationId,
      locationId: loc.id,
      actorId: input.actorId,
      action: 'invoice.create',
      entity: 'invoice',
      entityId: invoice.id,
      amountCents: invoice.totalCents,
      data: { number: invoice.number, kind: invoice.kind, memberId: invoice.memberId, contractId: invoice.contractId, items: input.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPriceCents: i.unitPriceCents, category: i.category ?? 'manual' })) },
    });
  }
  return invoice;
}

const orgOf = async (db: DbLike, locationId: string) => (await db.select({ o: locations.organizationId }).from(locations).where(eq(locations.id, locationId)).get())?.o ?? null;

/** Re-derives paidCents and status from the payments ledger. Only cleared money counts: a cheque waiting to clear does not pay anything. */
export async function recomputeInvoice(db: DbLike, invoiceId: string): Promise<Invoice> {
  const inv = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!inv) throw notFound('Invoice');
  const { paid } = (await db
    .select({ paid: sql<number>`coalesce(sum(${payments.amountCents}), 0)` })
    .from(payments)
    .where(and(eq(payments.invoiceId, invoiceId), eq(payments.status, 'cleared')))
    .get())!;
  const status = inv.status === 'void' ? 'void' : paid >= inv.totalCents ? 'paid' : 'open';
  return db.update(invoices).set({ paidCents: paid, status }).where(eq(invoices.id, invoiceId)).returning().get();
}

export function recordPayment(
  db: Db,
  p: {
    invoiceId: string;
    amountCents: number;
    method: PaymentMethod;
    paidAt: string;
    reference: string;
    notes: string;
    recordedById: string;
  },
) {
  return db.transaction(async (tx) => {
    const inv = await tx.select().from(invoices).where(eq(invoices.id, p.invoiceId)).get();
    if (!inv) throw notFound('Invoice');
    if (inv.status === 'void') throw conflict('This invoice is void');
    const waiting = await pendingChequesCents(tx, inv.id);
    const balance = inv.totalCents - inv.paidCents - waiting;
    if (inv.totalCents - inv.paidCents <= 0) throw conflict('This invoice is already paid');
    if (balance <= 0) throw conflict('A cheque for the rest of this invoice is waiting to clear');
    if (p.amountCents > balance) throw badRequest(`Payment exceeds the balance due (${balance} cents)`);

    // A cheque counts only once it clears; everything else has arrived.
    const cheque = p.method === 'cheque';
    const payment = await tx
      .insert(payments)
      .values({ ...p, locationId: inv.locationId, memberId: inv.memberId, status: cheque ? 'pending' : 'cleared', clearedAt: cheque ? null : p.paidAt })
      .returning()
      .get();
    await audit(tx, { organizationId: await orgOf(tx, inv.locationId), locationId: inv.locationId, actorId: p.recordedById, action: 'payment.record', entity: 'payment', entityId: payment.id, amountCents: payment.amountCents, data: { invoiceId: inv.id, number: inv.number, method: p.method, paidAt: p.paidAt, reference: p.reference, status: payment.status } });
    return { payment, invoice: await recomputeInvoice(tx, inv.id) };
  });
}

/**
 * Takes a payment back. Nothing is deleted: a reversal row with the negative amount is written, dated now, and the original is
 * marked reversed. So the month the money came in keeps its figures, and the month it went back shows it going back.
 */
export function reversePayment(db: Db, paymentId: string, actorId: string, reason = '') {
  return db.transaction(async (tx) => {
    const pay = await tx.select().from(payments).where(eq(payments.id, paymentId)).get();
    if (!pay) throw notFound('Payment');
    if (pay.reversesPaymentId) throw conflict('This is a reversal; it cannot be reversed itself');
    if (pay.reversedAt) throw conflict('This payment was already reversed');
    if (pay.status === 'pending') throw conflict('This cheque has not cleared yet. Mark it bounced instead');
    if (pay.status === 'bounced') throw conflict('This cheque bounced, so there is nothing to take back');
    const now = new Date().toISOString();
    const reversal = await tx
      .insert(payments)
      .values({
        locationId: pay.locationId,
        invoiceId: pay.invoiceId,
        memberId: pay.memberId,
        amountCents: -pay.amountCents,
        method: pay.method,
        paidAt: now,
        reference: pay.reference,
        notes: reason || 'Payment reversed',
        recordedById: actorId,
        reversesPaymentId: pay.id,
        clearedAt: now,
      })
      .returning()
      .get();
    await tx.update(payments).set({ reversedAt: now, reversedById: actorId }).where(eq(payments.id, pay.id)).run();
    await audit(tx, { organizationId: await orgOf(tx, pay.locationId), locationId: pay.locationId, actorId, action: 'payment.reverse', entity: 'payment', entityId: pay.id, amountCents: pay.amountCents, data: { reversalId: reversal.id, invoiceId: pay.invoiceId, method: pay.method, paidAt: pay.paidAt, reason } });
    return recomputeInvoice(tx, pay.invoiceId);
  });
}

/** What the cheques on an invoice that have not cleared yet come to. They hold that part of the balance until they clear or bounce. */
export async function pendingChequesCents(db: DbLike, invoiceId: string) {
  const row = await db
    .select({ v: sql<number>`coalesce(sum(${payments.amountCents}), 0)` })
    .from(payments)
    .where(and(eq(payments.invoiceId, invoiceId), eq(payments.status, 'pending')))
    .get();
  return row?.v ?? 0;
}

/**
 * A cheque on an invoice cleared: from now it pays the invoice, and the books count the money on the day it cleared (`clearedAt`,
 * not before the cheque was received and not in the future).
 */
export function clearPayment(db: Db, paymentId: string, actorId: string, clearedAt: string) {
  return db.transaction(async (tx) => {
    const pay = await tx.select().from(payments).where(eq(payments.id, paymentId)).get();
    if (!pay) throw notFound('Payment');
    if (pay.status !== 'pending') throw conflict(pay.status === 'cleared' ? 'This cheque has already cleared' : 'This cheque bounced');
    if (clearedAt.slice(0, 10) < pay.paidAt.slice(0, 10)) throw badRequest('A cheque cannot clear before it was received');
    if (clearedAt < pay.paidAt) clearedAt = pay.paidAt;
    await tx.update(payments).set({ status: 'cleared', clearedAt }).where(eq(payments.id, pay.id)).run();
    await audit(tx, { organizationId: await orgOf(tx, pay.locationId), locationId: pay.locationId, actorId, action: 'cheque.clear', entity: 'payment', entityId: pay.id, amountCents: pay.amountCents, data: { invoiceId: pay.invoiceId, reference: pay.reference, clearedAt } });
    return recomputeInvoice(tx, pay.invoiceId);
  });
}

/** A cheque on an invoice bounced: it never paid anything, so the invoice stays open for the full balance. */
export function bouncePayment(db: Db, paymentId: string, actorId: string, reason = '') {
  return db.transaction(async (tx) => {
    const pay = await tx.select().from(payments).where(eq(payments.id, paymentId)).get();
    if (!pay) throw notFound('Payment');
    if (pay.status !== 'pending') throw conflict(pay.status === 'cleared' ? 'This cheque has already cleared. Reverse the payment instead' : 'This cheque already bounced');
    const now = new Date().toISOString();
    await tx.update(payments).set({ status: 'bounced', bouncedAt: now, notes: reason ? `${pay.notes ? `${pay.notes}. ` : ''}Bounced: ${reason}` : pay.notes }).where(eq(payments.id, pay.id)).run();
    await audit(tx, { organizationId: await orgOf(tx, pay.locationId), locationId: pay.locationId, actorId, action: 'cheque.bounce', entity: 'payment', entityId: pay.id, amountCents: pay.amountCents, data: { invoiceId: pay.invoiceId, reference: pay.reference, reason } });
    return recomputeInvoice(tx, pay.invoiceId);
  });
}

/**
 * Gives back what an invoice's advance and credit lines took, to whoever it came from: the contract for a contract's rent invoice,
 * otherwise the member. Used when an invoice is voided.
 */
async function releaseCredits(tx: DbLike, inv: Invoice) {
  const lines = await tx.select().from(invoiceItems).where(and(eq(invoiceItems.invoiceId, inv.id), lt(invoiceItems.amountCents, 0))).all();
  const taken = (category: LineCategory) => -lines.filter((l) => l.category === category).reduce((sum, l) => sum + l.amountCents, 0);
  const advance = taken('advance');
  const credit = taken('credit');
  if (advance > 0 && inv.contractId) await tx.update(contracts).set({ advanceUsedCents: sql`max(0, ${contracts.advanceUsedCents} - ${advance})` }).where(eq(contracts.id, inv.contractId)).run();
  else if (advance > 0) await tx.update(members).set({ advanceUsedCents: sql`max(0, ${members.advanceUsedCents} - ${advance})` }).where(eq(members.id, inv.memberId)).run();
  if (credit > 0) await tx.update(members).set({ creditUsedCents: sql`max(0, ${members.creditUsedCents} - ${credit})` }).where(eq(members.id, inv.memberId)).run();
}

/** Voids an unpaid invoice. Works inside a transaction too (it then runs as a savepoint of it). */
export function voidInvoice(db: DbLike, invoiceId: string, actorId?: string) {
  return (db as Db).transaction(async (tx) => {
    const inv = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
    if (!inv) throw notFound('Invoice');
    if (inv.status === 'void') throw conflict('Invoice is already void');
    if (inv.paidCents > 0) throw conflict('Reverse the payments on this invoice before voiding it');
    if ((await pendingChequesCents(tx, inv.id)) > 0) throw conflict('A cheque on this invoice is waiting to clear. Mark it cleared or bounced first');
    // Release bookings and amenities so they can be billed on a replacement invoice.
    await tx.update(bookings).set({ invoiceId: null }).where(eq(bookings.invoiceId, inv.id)).run();
    await tx.update(amenityOrders).set({ invoiceId: null }).where(eq(amenityOrders.invoiceId, inv.id)).run();
    // Whatever advance or credit this invoice used goes back, for the next invoice.
    await releaseCredits(tx, inv);
    if (actorId) await audit(tx, { organizationId: await orgOf(tx, inv.locationId), locationId: inv.locationId, actorId, action: 'invoice.void', entity: 'invoice', entityId: inv.id, amountCents: inv.totalCents, data: { number: inv.number } });
    return tx.update(invoices).set({ status: 'void' }).where(eq(invoices.id, inv.id)).returning().get();
  });
}

/**
 * Takes what is left of a member's advance, then of their credit, off an invoice's lines: advance first (rent paid up front), then
 * credit (paid periods they did not use). Returns the lines to add and records how much of each was used. Never more than `grossCents`.
 */
export async function takeMemberCredits(tx: DbLike, memberId: string, grossCents: number): Promise<LineItem[]> {
  const m = await tx.select().from(members).where(eq(members.id, memberId)).get();
  if (!m || grossCents <= 0) return [];
  const lines: LineItem[] = [];
  const advance = Math.min(Math.max(0, m.advanceCents - m.advanceUsedCents), grossCents);
  const credit = Math.min(Math.max(0, m.creditCents - m.creditUsedCents), grossCents - advance);
  if (advance > 0) lines.push({ description: 'Advance paid', quantity: 1, unitPriceCents: -advance, category: 'advance' });
  if (credit > 0) lines.push({ description: 'Credit from an earlier invoice', quantity: 1, unitPriceCents: -credit, category: 'credit' });
  if (advance > 0 || credit > 0) await tx.update(members).set({ advanceUsedCents: m.advanceUsedCents + advance, creditUsedCents: m.creditUsedCents + credit }).where(eq(members.id, memberId)).run();
  return lines;
}

/** Takes what is left of a contract's advance off its invoice's lines. */
async function takeContractAdvance(tx: DbLike, contractId: string, grossCents: number): Promise<LineItem[]> {
  const c = (await tx.select().from(contracts).where(eq(contracts.id, contractId)).get())!;
  const left = c.advanceReceivedAt ? Math.max(0, c.advanceCents - c.advanceUsedCents) : 0;
  const take = Math.min(left, grossCents);
  if (take <= 0) return [];
  await tx.update(contracts).set({ advanceUsedCents: c.advanceUsedCents + take }).where(eq(contracts.id, c.id)).run();
  return [{ description: 'Advance paid', quantity: 1, unitPriceCents: -take, category: 'advance' }];
}

const gross = (items: LineItem[]) => items.reduce((sum, i) => sum + i.quantity * i.unitPriceCents, 0);

/**
 * Adds an advance or credit line to an invoice that already exists and has nothing paid on it, up to its subtotal, and works its totals
 * out again at the rate it was issued at. Returns how much was taken off. For money that arrives after its invoice was made.
 */
export async function creditOpenInvoice(tx: DbLike, inv: Invoice, line: { description: string; category: 'advance' | 'credit' }, maxCents: number) {
  if (inv.status !== 'open' || inv.paidCents !== 0 || inv.subtotalCents <= 0 || maxCents <= 0) return 0;
  const take = Math.min(maxCents, inv.subtotalCents);
  const rate = inv.taxRateBps ?? (await tx.select({ r: locations.taxRateBps }).from(locations).where(eq(locations.id, inv.locationId)).get())!.r;
  await tx.insert(invoiceItems).values({ invoiceId: inv.id, description: line.description, quantity: 1, unitPriceCents: -take, amountCents: -take, category: line.category }).run();
  const totals = calcTotals([{ description: '', quantity: 1, unitPriceCents: inv.subtotalCents - take }], rate);
  await tx.update(invoices).set({ ...totals, status: totals.totalCents === 0 ? 'paid' : 'open' }).where(eq(invoices.id, inv.id)).run();
  return take;
}

/** A contract's advance received after its invoice was made comes off the newest open, unpaid invoice of that contract. */
export async function applyContractAdvanceToOpenInvoice(tx: DbLike, contractId: string) {
  const c = (await tx.select().from(contracts).where(eq(contracts.id, contractId)).get())!;
  const left = c.advanceReceivedAt ? c.advanceCents - c.advanceUsedCents : 0;
  if (left <= 0) return;
  const inv = await tx.select().from(invoices).where(and(eq(invoices.contractId, c.id), eq(invoices.status, 'open'), eq(invoices.paidCents, 0))).orderBy(desc(invoices.createdAt)).get();
  if (!inv) return;
  const took = await creditOpenInvoice(tx, inv, { description: 'Advance paid', category: 'advance' }, left);
  if (took > 0) await tx.update(contracts).set({ advanceUsedCents: c.advanceUsedCents + took }).where(eq(contracts.id, c.id)).run();
}

/**
 * Monthly billing for `month` ('YYYY-MM'). Two kinds of invoice, each made at most once for the month, so running it again bills nothing new.
 *
 * 1. Every contract (single member or company) that runs during the month: its rent for the days it runs, and for a company the
 *    unbilled bookings and amenities of the people on it that month, less what is left of the contract's advance. One per contract per
 *    month, found by `invoices.contractId`, whoever the contact is now.
 * 2. Every member who is not on a company contract that month: the price of a plan from before shifts (active members only; plans with
 *    shifts bill each period when it starts), then their unbilled bookings and amenities, less what is left of their advance and credit.
 *    Cancelled and paused members are billed for bookings and amenities they had, never for a plan.
 */
export function generateSubscriptionInvoices(
  db: Db,
  opts: { locationId: string; month: string; dueInDays: number; actorId?: string | undefined },
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    const loc = await loadLocation(tx as unknown as Db, opts.locationId);
    const range = monthRange(opts.month, loc.timezone);
    const today = todayIn(loc.timezone, now);
    const issueDate = today;
    const dueDate = addDays(today, opts.dueInDays);
    const monthLabel = new Date(`${range.firstDay}T12:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const lastDay = addDays(range.nextFirstDay, -1);
    const base = { locationId: loc.id, kind: 'subscription' as const, issueDate, dueDate, periodStart: range.firstDay, actorId: opts.actorId };
    const created: Invoice[] = [];
    let skipped = 0;

    // ---- 1. Contracts
    const running = (await tx.select().from(contracts).where(and(eq(contracts.locationId, loc.id), inArray(contracts.status, ['active', 'ended']))).all()).filter(
      (c) => c.startDate < range.nextFirstDay && (!c.endDate || c.endDate >= range.firstDay),
    );
    const covers = (p: { joinDate: string; leaveDate: string | null }) => p.joinDate <= lastDay && (!p.leaveDate || p.leaveDate >= range.firstDay);
    const employees = new Set<string>();
    const peopleOf = new Map<string, { p: typeof contractPeople.$inferSelect; name: string }[]>();
    for (const c of running.filter((x) => x.companyName)) {
      const people = await tx
        .select({ p: contractPeople, name: users.name })
        .from(contractPeople)
        .innerJoin(members, eq(members.id, contractPeople.memberId))
        .innerJoin(users, eq(users.id, members.userId))
        .where(eq(contractPeople.contractId, c.id))
        .all();
      peopleOf.set(c.id, people);
      for (const x of people) if (covers(x.p)) employees.add(x.p.memberId);
    }

    for (const c of running) {
      const done = await tx.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.contractId, c.id), eq(invoices.periodStart, range.firstDay), ne(invoices.status, 'void'))).get();
      if (done) {
        skipped++;
        continue;
      }
      const items: LineItem[] = [];
      if (c.companyName) {
        const people = peopleOf.get(c.id) ?? [];
        const rent = monthCharges(
          { pricingMode: c.pricingMode, pricePerMemberCents: c.pricePerMemberCents, extraMemberCents: c.extraMemberCents, fixedPriceCents: c.fixedPriceCents, startDate: c.startDate, endDate: c.endDate },
          people.map(({ p, name }) => ({ name, joinDate: p.joinDate, leaveDate: p.leaveDate, hasDesk: !!p.deskResourceId })),
          await seatsOf(tx as unknown as Db, c.id),
          range.firstDay,
          range.nextFirstDay,
        );
        items.push(...rent.map((l) => ({ description: `${c.companyName}: ${l.description} — ${monthLabel}`, quantity: 1, unitPriceCents: l.amountCents, category: 'rent' as const })));
        const here = people.filter((x) => covers(x.p)).map((x) => x.p.memberId);
        if (here.length) {
          items.push(...(await bookingItems(tx, here, range, loc.timezone, now)));
          items.push(...(await amenityItems(tx, here)));
        }
      } else if (c.rentCents > 0) {
        // A single member's rent, by the day for a month the contract starts or ends in, like a company's.
        const space = c.resourceId ? (await tx.select({ n: resources.name }).from(resources).where(eq(resources.id, c.resourceId)).get())?.n : undefined;
        const rent = monthCharges({ pricingMode: 'fixed', pricePerMemberCents: 0, extraMemberCents: 0, fixedPriceCents: c.rentCents, startDate: c.startDate, endDate: c.endDate }, [], 0, range.firstDay, range.nextFirstDay);
        items.push(...rent.map((l) => ({ description: `Rent${space ? `: ${space}` : ''}${l.description.replace('Space rent', '')} — ${monthLabel}`, quantity: 1, unitPriceCents: l.amountCents, category: 'rent' as const, resourceId: c.resourceId })));
      }
      if (!items.length) {
        skipped++;
        continue;
      }
      items.push(...(await takeContractAdvance(tx, c.id, gross(items))));
      created.push(await createInvoice(tx, { ...base, memberId: c.memberId, contractId: c.id, items }));
    }

    // ---- 2. Members
    const candidates = (await tx.select({ member: members, plan: plans }).from(members).leftJoin(plans, eq(plans.id, members.planId)).where(eq(members.locationId, loc.id)).all()).filter(
      ({ member }) => member.startDate < range.nextFirstDay && !employees.has(member.id),
    );
    for (const { member, plan } of candidates) {
      const existing = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.memberId, member.id), eq(invoices.kind, 'subscription'), eq(invoices.periodStart, range.firstDay), isNull(invoices.contractId), ne(invoices.status, 'void')))
        .get();
      if (existing) {
        skipped++;
        continue;
      }
      const items: LineItem[] = [];
      // A plan with shifts bills each period when it starts; the plan's own price is only for plans from before shifts.
      const plansThisMonth = member.status === 'active' && (!member.endDate || member.endDate >= range.firstDay);
      if (plansThisMonth && plan && plan.interval === 'month' && plan.priceCents > 0 && !member.planStart) {
        items.push({ description: `${plan.name} membership — ${monthLabel}`, quantity: 1, unitPriceCents: plan.priceCents, category: 'plan', planId: plan.id });
      }
      items.push(...(await bookingItems(tx, [member.id], range, loc.timezone, now)));
      items.push(...(await amenityItems(tx, [member.id])));
      if (items.length === 0) {
        skipped++;
        continue;
      }
      items.push(...(await takeMemberCredits(tx, member.id, gross(items))));
      created.push(await createInvoice(tx, { ...base, memberId: member.id, items }));
    }
    return { created, skipped };
  });
}

/** Paid bookings that have happened and are not on an invoice yet, as invoice lines. */
async function bookingItems(tx: DbLike, memberIds: string[], range: { end: string }, tz: string, now: Date): Promise<LineItem[]> {
  const unbilled = (await tx
    .select({ booking: bookings, resourceName: resources.name })
    .from(bookings)
    .innerJoin(resources, eq(resources.id, bookings.resourceId))
    .where(and(inArray(bookings.memberId, memberIds), isNull(bookings.invoiceId), inArray(bookings.status, ['confirmed', 'completed']), lt(bookings.startsAt, range.end), lt(bookings.startsAt, now.toISOString())))
    .orderBy(asc(bookings.startsAt))
    .all()).filter(({ booking }) => booking.priceCents > 0);
  return unbilled.map(({ booking, resourceName }) => ({
    description: `${resourceName} booking, ${localDate(booking.startsAt, tz)} ${localTime(booking.startsAt, tz)}–${localTime(booking.endsAt, tz)}`,
    quantity: 1,
    unitPriceCents: booking.priceCents,
    bookingId: booking.id,
    category: 'booking' as const,
    resourceId: booking.resourceId,
  }));
}

/** What members were charged for amenities beyond their free amount, not yet collected or on an invoice, as invoice lines. */
export async function amenityItems(tx: DbLike, memberIds: string[]): Promise<LineItem[]> {
  const owed = await tx
    .select()
    .from(amenityOrders)
    .where(and(inArray(amenityOrders.memberId, memberIds), isNull(amenityOrders.invoiceId), isNull(amenityOrders.collectedAt), sql`${amenityOrders.chargeCents} > 0`))
    .orderBy(asc(amenityOrders.date), asc(amenityOrders.createdAt))
    .all();
  return owed.map((o) => {
    const paid = o.quantity - o.freeQuantity;
    return { description: `${o.name}, ${o.date}`, quantity: paid, unitPriceCents: Math.round(o.chargeCents / paid), amenityOrderId: o.id, category: 'amenity' as const };
  });
}

export function withBalance<T extends Invoice>(inv: T, today: string) {
  return {
    ...inv,
    balanceCents: inv.status === 'void' ? 0 : inv.totalCents - inv.paidCents,
    overdue: inv.status === 'open' && inv.dueDate < today,
  };
}
