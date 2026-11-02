import { daysBetween, localDate } from '../lib/time.js';

/**
 * The finance definitions in one place, as pure functions over plain rows: no database, no clock, no request.
 *
 * STAGE 1A SCAFFOLD. Nothing calls these yet; reports.ts, the dashboard, a member's balance and /me/summary still compute their own
 * figures. test/financeCore.test.ts proves each function here returns exactly what the endpoint returns today (characterization), and
 * documents where a definition differs from what is right. The fixes in later stages move the endpoints onto these functions.
 *
 * Conventions: money in integer minor units; `day` is 'YYYY-MM-DD' in the location's timezone; instants are ISO UTC strings.
 */

// ---- Row shapes (the columns each definition needs, nothing more) ---------------------------------------------------------------

export interface InvoiceRow {
  id: string;
  memberId: string;
  kind: 'subscription' | 'manual';
  status: 'open' | 'paid' | 'void';
  issueDate: string;
  dueDate: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
}

export interface InvoiceLineRow {
  invoiceId: string;
  amountCents: number;
}

export interface PaymentRow {
  invoiceId: string;
  amountCents: number;
  method: string;
  paidAt: string;
}

export interface LedgerRow {
  kind: 'received' | 'refunded' | 'kept' | 'advance';
  amountCents: number;
  occurredAt: string;
}

export interface AmenityOrderRow {
  chargeCents: number;
  collectedAt: string | null;
  invoiceId: string | null;
}

/** Local calendar days, both ends included. */
export interface DayRange {
  from: string;
  to: string;
}

/** A UTC window [start, end), as the report and dashboard build from a DayRange or a month. */
export interface InstantWindow {
  start: string;
  end: string;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const inDays = (day: string, r: DayRange) => day >= r.from && day <= r.to;
const inWindow = (iso: string, w: InstantWindow) => iso >= w.start && iso < w.end;
const live = (i: InvoiceRow) => i.status !== 'void';

// ---- Tax ------------------------------------------------------------------------------------------------------------------------

/** Tax on an invoice's subtotal: once per invoice, rounded half away from zero to the minor unit. Same as calcTotals in billing.ts. */
export const invoiceTaxCents = (subtotalCents: number, taxRateBps: number) => Math.round((subtotalCents * taxRateBps) / 10_000);

/** Tax on the invoices issued in a range, as stored on them. No endpoint reports this today (R2). */
export const taxInvoicedCents = (invoices: InvoiceRow[], days: DayRange) => sum(invoices.filter((i) => live(i) && inDays(i.issueDate, days)).map((i) => i.taxCents));

// ---- Invoiced ---------------------------------------------------------------------------------------------------------------------

/** What the finance report and the dashboard call "invoiced": non-void invoice totals by issue date. Net of any advance line (R1). */
export const invoicedCents = (invoices: InvoiceRow[], days: DayRange) => sum(invoices.filter((i) => live(i) && inDays(i.issueDate, days)).map((i) => i.totalCents));

/** What members were billed including the part an advance paid (the negative "Advance paid" lines added back). The R1 definition. */
export function billedCents(invoices: InvoiceRow[], lines: InvoiceLineRow[], days: DayRange) {
  const counted = new Set(invoices.filter((i) => live(i) && inDays(i.issueDate, days)).map((i) => i.id));
  return invoicedCents(invoices, days) - sum(lines.filter((l) => counted.has(l.invoiceId) && l.amountCents < 0).map((l) => l.amountCents));
}

// ---- Collected (cash basis) -----------------------------------------------------------------------------------------------------

export interface CollectedByKind {
  subscription: number;
  manual: number;
  kept_deposit: number;
  advance: number;
  amenities: number;
  total: number;
}

/**
 * Money that came in during a window, by kind, as the finance report's incomeByKind and the dashboard's "collected this month" count
 * it: invoice payments (split by the invoice's kind), advances when received, deposits when kept, amenity charges when collected at
 * the desk. Received and refunded deposits are not income. Tax is included (R2).
 */
export function collectedByKind(
  input: { payments: PaymentRow[]; invoiceKind: (invoiceId: string) => 'subscription' | 'manual' | undefined; ledger: LedgerRow[]; amenityOrders: AmenityOrderRow[] },
  w: InstantWindow,
): CollectedByKind {
  const pays = input.payments.filter((p) => inWindow(p.paidAt, w));
  const ledger = (kind: LedgerRow['kind']) => sum(input.ledger.filter((e) => e.kind === kind && inWindow(e.occurredAt, w)).map((e) => e.amountCents));
  const out = {
    subscription: sum(pays.filter((p) => input.invoiceKind(p.invoiceId) === 'subscription').map((p) => p.amountCents)),
    manual: sum(pays.filter((p) => input.invoiceKind(p.invoiceId) === 'manual').map((p) => p.amountCents)),
    kept_deposit: ledger('kept'),
    advance: ledger('advance'),
    amenities: sum(input.amenityOrders.filter((o) => o.chargeCents > 0 && o.collectedAt !== null && inWindow(o.collectedAt, w)).map((o) => o.chargeCents)),
  };
  return { ...out, total: out.subscription + out.manual + out.kept_deposit + out.advance + out.amenities };
}

/** Invoice payments by method in a window, as the report's paymentsByMethod (other income has no method there: L3). */
export function paymentsByMethod(payments: PaymentRow[], w: InstantWindow) {
  const by = new Map<string, number>();
  for (const p of payments.filter((x) => inWindow(x.paidAt, w))) by.set(p.method, (by.get(p.method) ?? 0) + p.amountCents);
  return [...by.entries()].map(([method, amountCents]) => ({ method, amountCents })).sort((a, b) => b.amountCents - a.amountCents);
}

// ---- Outstanding, overdue and aging ---------------------------------------------------------------------------------------------

/** What is owed right now, as the dashboard, the invoice list and a member's balance compute it: open invoices' total less paid. */
export const outstandingCents = (invoices: InvoiceRow[]) => sum(invoices.filter((i) => i.status === 'open').map((i) => i.totalCents - i.paidCents));

/** Overdue now: open invoices whose due date is before `today`. Same as the dashboard and a member's balance. */
export const overdueCents = (invoices: InvoiceRow[], today: string) => sum(invoices.filter((i) => i.status === 'open' && i.dueDate < today).map((i) => i.totalCents - i.paidCents));

export interface AgingBucket {
  count: number;
  amountCents: number;
}
export interface Aging {
  current: AgingBucket;
  days1to30: AgingBucket;
  days31to60: AgingBucket;
  days61plus: AgingBucket;
}

function bucket(rows: { owed: number; dueDate: string }[], day: string): Aging {
  const aging: Aging = { current: { count: 0, amountCents: 0 }, days1to30: { count: 0, amountCents: 0 }, days31to60: { count: 0, amountCents: 0 }, days61plus: { count: 0, amountCents: 0 } };
  for (const r of rows) {
    const late = daysBetween(r.dueDate, day);
    const b = late <= 0 ? aging.current : late <= 30 ? aging.days1to30 : late <= 60 ? aging.days31to60 : aging.days61plus;
    b.count++;
    b.amountCents += r.owed;
  }
  return aging;
}

/** Receivables aging as the finance report computes it: every open invoice now, by days past due on `today` (any end date: R4a). */
export const agingNow = (invoices: InvoiceRow[], today: string) => bucket(invoices.filter((i) => i.status === 'open').map((i) => ({ owed: i.totalCents - i.paidCents, dueDate: i.dueDate })), today);

/** What each invoice issued by the end of `day` still owed then, counting only payments made by then (local days). */
function owedAsOf(invoices: InvoiceRow[], payments: PaymentRow[], day: string, tz: string) {
  return invoices
    .filter((i) => live(i) && i.issueDate <= day)
    .map((i) => ({ i, owed: i.totalCents - sum(payments.filter((p) => p.invoiceId === i.id && localDate(p.paidAt, tz) <= day).map((p) => p.amountCents)) }))
    .filter((x) => x.owed > 0);
}

/** Outstanding at the end of a day. Equals outstandingCents for today unless a payment or invoice is dated after today. */
export const outstandingAsOf = (invoices: InvoiceRow[], payments: PaymentRow[], day: string, tz: string) => sum(owedAsOf(invoices, payments, day, tz).map((x) => x.owed));

/** Overdue at the end of a day. */
export const overdueAsOf = (invoices: InvoiceRow[], payments: PaymentRow[], day: string, tz: string) => sum(owedAsOf(invoices, payments, day, tz).filter((x) => x.i.dueDate < day).map((x) => x.owed));

/** Aging at the end of a day: the R4a definition. */
export const agingAsOf = (invoices: InvoiceRow[], payments: PaymentRow[], day: string, tz: string) => bucket(owedAsOf(invoices, payments, day, tz).map((x) => ({ owed: x.owed, dueDate: x.i.dueDate })), day);

// ---- Deposits and advances ------------------------------------------------------------------------------------------------------

/** Security deposits held: received less refunded less kept, for entries before `beforeIso`. The report passes "now" (R4b). */
export function depositsHeldCents(ledger: LedgerRow[], beforeIso: string) {
  const k = (kind: LedgerRow['kind']) => sum(ledger.filter((e) => e.kind === kind && e.occurredAt < beforeIso).map((e) => e.amountCents));
  return k('received') - k('refunded') - k('kept');
}

/** Deposits held at the end of a local day: the R4b definition. */
export function depositsHeldAsOf(ledger: LedgerRow[], day: string, tz: string) {
  const k = (kind: LedgerRow['kind']) => sum(ledger.filter((e) => e.kind === kind && localDate(e.occurredAt, tz) <= day).map((e) => e.amountCents));
  return k('received') - k('refunded') - k('kept');
}

/** Advances received but not yet taken off any invoice: members' and contracts' (each tracks what its invoices used). */
export function advancesUnappliedCents(input: { members: { advanceCents: number; advanceUsedCents: number }[]; contracts: { advanceCents: number; advanceUsedCents: number; advanceReceivedAt: string | null }[] }) {
  return sum(input.members.map((m) => Math.max(0, m.advanceCents - m.advanceUsedCents))) + sum(input.contracts.filter((c) => c.advanceReceivedAt).map((c) => Math.max(0, c.advanceCents - c.advanceUsedCents)));
}

/** Credit members have from paid periods they did not use, not yet taken off an invoice. */
export const creditsUnappliedCents = (members: { creditCents: number; creditUsedCents: number }[]) => sum(members.map((m) => Math.max(0, m.creditCents - m.creditUsedCents)));

// ---- A member's balance ---------------------------------------------------------------------------------------------------------

/** What GET /members/:id and /me/summary show: open invoices' balance and the overdue part. Amenities owed are a separate figure. */
export function memberBalance(invoices: InvoiceRow[], memberId: string, today: string) {
  const mine = invoices.filter((i) => i.memberId === memberId);
  return { balanceDueCents: outstandingCents(mine), overdueCents: overdueCents(mine, today) };
}

/** Amenity charges not collected and not on an invoice, as amenityOwed and the report's amenities.owedCents. */
export const amenitiesOwedCents = (orders: AmenityOrderRow[]) => sum(orders.filter((o) => o.chargeCents > 0 && o.collectedAt === null && o.invoiceId === null).map((o) => o.chargeCents));
