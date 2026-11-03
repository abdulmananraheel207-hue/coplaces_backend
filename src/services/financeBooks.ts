import { and, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { amenityOrders, contracts, depositEntries, invoiceItems, invoices, members, payments } from '../db/schema.js';
import type { Books } from './financeCore.js';

/**
 * Reads a location's books. Only money that has arrived is in them: a cheque counts once it clears, dated the day it cleared, and a
 * bounced cheque never. Reads a location's books: every invoice with its lines, every payment and reversal, the advance and deposit ledger, and the amenity
 * charges that were collected at the desk without an invoice. Four reads, whatever the size of the period, so the report, the Today
 * page and the charts all compute from the same rows with the same functions (financeCore.ts).
 */
export async function loadBooks(db: Db, locationId: string): Promise<Books> {
  const [inv, lines, pays, ledger, desk] = await Promise.all([
    db.select().from(invoices).where(eq(invoices.locationId, locationId)).all(),
    db
      .select({ invoiceId: invoiceItems.invoiceId, amountCents: invoiceItems.amountCents, category: invoiceItems.category, resourceId: invoiceItems.resourceId, planId: invoiceItems.planId })
      .from(invoiceItems)
      .innerJoin(invoices, eq(invoices.id, invoiceItems.invoiceId))
      .where(eq(invoices.locationId, locationId))
      .all(),
    db
      .select({ id: payments.id, invoiceId: payments.invoiceId, amountCents: payments.amountCents, method: payments.method, paidAt: sql<string>`coalesce(${payments.clearedAt}, ${payments.paidAt})`, createdAt: payments.createdAt })
      .from(payments)
      .where(and(eq(payments.locationId, locationId), eq(payments.status, 'cleared')))
      .all(),
    db
      .select({ kind: depositEntries.kind, amountCents: depositEntries.amountCents, occurredAt: sql<string>`coalesce(${depositEntries.clearedAt}, ${depositEntries.occurredAt})`, method: depositEntries.method })
      .from(depositEntries)
      .where(and(eq(depositEntries.locationId, locationId), eq(depositEntries.status, 'cleared')))
      .all(),
    db
      .select({ chargeCents: amenityOrders.chargeCents, collectedAt: amenityOrders.collectedAt, invoiceId: amenityOrders.invoiceId })
      .from(amenityOrders)
      .where(and(eq(amenityOrders.locationId, locationId), isNotNull(amenityOrders.collectedAt), isNull(amenityOrders.invoiceId), gt(amenityOrders.chargeCents, 0)))
      .all(),
  ]);
  return { invoices: inv, lines, payments: pays, ledger, amenityOrders: desk };
}

/** Advances received and credit given that invoices have not used yet, at a location, now. */
export async function unappliedOf(db: Db, locationId: string) {
  const [m, c] = await Promise.all([
    db.select({ advanceCents: members.advanceCents, advanceUsedCents: members.advanceUsedCents, creditCents: members.creditCents, creditUsedCents: members.creditUsedCents }).from(members).where(eq(members.locationId, locationId)).all(),
    db
      .select({ advanceCents: contracts.advanceCents, advanceUsedCents: contracts.advanceUsedCents, advanceReceivedAt: contracts.advanceReceivedAt })
      .from(contracts)
      .where(and(eq(contracts.locationId, locationId), inArray(contracts.status, ['draft', 'active', 'ended']), isNotNull(contracts.advanceReceivedAt)))
      .all(),
  ]);
  return { members: m, contracts: c };
}
