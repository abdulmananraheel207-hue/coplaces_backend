import { and, asc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { Db, DbLike } from '../db/client.js';
import { bookings, invoiceItems, invoices, locations, members, payments, plans, resources } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { addDays, localDate, localTime, monthRange, todayIn } from '../lib/time.js';
import { loadLocation } from '../lib/access.js';

export type Invoice = typeof invoices.$inferSelect;
export type PaymentMethod = (typeof payments.$inferSelect)['method'];

export interface LineItem {
  description: string;
  quantity: number;
  unitPriceCents: number;
  bookingId?: string | undefined;
}

export interface NewInvoice {
  locationId: string;
  memberId: string;
  kind: 'subscription' | 'manual';
  issueDate: string;
  dueDate: string;
  periodStart?: string | undefined;
  items: LineItem[];
  notes?: string | undefined;
}

export function calcTotals(items: LineItem[], taxRateBps: number) {
  const subtotalCents = items.reduce((s, i) => s + i.quantity * i.unitPriceCents, 0);
  const taxCents = Math.round((subtotalCents * taxRateBps) / 10_000);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

export async function createInvoice(db: DbLike, input: NewInvoice): Promise<Invoice> {
  if (input.items.length === 0) throw badRequest('An invoice needs at least one line item');
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
      })
      .run();
    if (item.bookingId) {
      await db.update(bookings).set({ invoiceId: invoice.id }).where(eq(bookings.id, item.bookingId)).run();
    }
  }
  return invoice;
}

/** Re-derives paidCents and status from the payments ledger. */
export async function recomputeInvoice(db: DbLike, invoiceId: string): Promise<Invoice> {
  const inv = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!inv) throw notFound('Invoice');
  const { paid } = (await db
    .select({ paid: sql<number>`coalesce(sum(${payments.amountCents}), 0)` })
    .from(payments)
    .where(eq(payments.invoiceId, invoiceId))
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
    const balance = inv.totalCents - inv.paidCents;
    if (balance <= 0) throw conflict('This invoice is already paid');
    if (p.amountCents > balance) throw badRequest(`Payment exceeds the balance due (${balance} cents)`);

    const payment = await tx
      .insert(payments)
      .values({ ...p, locationId: inv.locationId, memberId: inv.memberId })
      .returning()
      .get();
    return { payment, invoice: await recomputeInvoice(tx, inv.id) };
  });
}

export function deletePayment(db: Db, paymentId: string) {
  return db.transaction(async (tx) => {
    const pay = await tx.select().from(payments).where(eq(payments.id, paymentId)).get();
    if (!pay) throw notFound('Payment');
    await tx.delete(payments).where(eq(payments.id, paymentId)).run();
    return recomputeInvoice(tx, pay.invoiceId);
  });
}

export function voidInvoice(db: Db, invoiceId: string) {
  return db.transaction(async (tx) => {
    const inv = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
    if (!inv) throw notFound('Invoice');
    if (inv.status === 'void') throw conflict('Invoice is already void');
    if (inv.paidCents > 0) throw conflict('Remove the payments on this invoice before voiding it');
    // Release bookings so they can be billed on a replacement invoice.
    await tx.update(bookings).set({ invoiceId: null }).where(eq(bookings.invoiceId, inv.id)).run();
    return tx.update(invoices).set({ status: 'void' }).where(eq(invoices.id, inv.id)).returning().get();
  });
}

/**
 * Bills every active member for `month` ('YYYY-MM'): the monthly plan fee plus any unbilled paid bookings.
 * Idempotent: a member with a non-void subscription invoice for the month is skipped.
 */
export function generateSubscriptionInvoices(
  db: Db,
  opts: { locationId: string; month: string; dueInDays: number },
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    const loc = await loadLocation(tx as unknown as Db, opts.locationId);
    const range = monthRange(opts.month, loc.timezone);
    const today = todayIn(loc.timezone, now);
    const issueDate = today;
    const dueDate = addDays(today, opts.dueInDays);
    const monthLabel = new Date(`${range.firstDay}T12:00:00Z`).toLocaleString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });

    const candidates = (await tx
      .select({ member: members, plan: plans })
      .from(members)
      .leftJoin(plans, eq(plans.id, members.planId))
      .where(and(eq(members.locationId, loc.id), eq(members.status, 'active')))
      .all())
      .filter(({ member }) => member.startDate < range.nextFirstDay && (!member.endDate || member.endDate >= range.firstDay));

    const created: Invoice[] = [];
    let skipped = 0;
    for (const { member, plan } of candidates) {
      const existing = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(
            eq(invoices.memberId, member.id),
            eq(invoices.kind, 'subscription'),
            eq(invoices.periodStart, range.firstDay),
            ne(invoices.status, 'void'),
          ),
        )
        .get();
      if (existing) {
        skipped++;
        continue;
      }

      const items: LineItem[] = [];
      if (plan && plan.interval === 'month' && plan.priceCents > 0) {
        items.push({ description: `${plan.name} membership — ${monthLabel}`, quantity: 1, unitPriceCents: plan.priceCents });
      }

      const unbilled = (await tx
        .select({ booking: bookings, resourceName: resources.name })
        .from(bookings)
        .innerJoin(resources, eq(resources.id, bookings.resourceId))
        .where(
          and(
            eq(bookings.memberId, member.id),
            isNull(bookings.invoiceId),
            inArray(bookings.status, ['confirmed', 'completed']),
            lt(bookings.startsAt, range.end),
            lt(bookings.startsAt, now.toISOString()),
          ),
        )
        .orderBy(asc(bookings.startsAt))
        .all())
        .filter(({ booking }) => booking.priceCents > 0);
      for (const { booking, resourceName } of unbilled) {
        const day = localDate(booking.startsAt, loc.timezone);
        const span = `${localTime(booking.startsAt, loc.timezone)}–${localTime(booking.endsAt, loc.timezone)}`;
        items.push({
          description: `${resourceName} booking, ${day} ${span}`,
          quantity: 1,
          unitPriceCents: booking.priceCents,
          bookingId: booking.id,
        });
      }

      if (items.length === 0) {
        skipped++;
        continue;
      }
      created.push(
        await createInvoice(tx, {
          locationId: loc.id,
          memberId: member.id,
          kind: 'subscription',
          issueDate,
          dueDate,
          periodStart: range.firstDay,
          items,
        }),
      );
    }
    return { created, skipped };
  });
}

export function withBalance<T extends Invoice>(inv: T, today: string) {
  return {
    ...inv,
    balanceCents: inv.status === 'void' ? 0 : inv.totalCents - inv.paidCents,
    overdue: inv.status === 'open' && inv.dueDate < today,
  };
}
