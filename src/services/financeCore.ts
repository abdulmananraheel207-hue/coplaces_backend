import { daysBetween, localDate } from '../lib/time.js';

/**
 * The finance definitions in one place, as pure functions over plain rows: no database, no clock, no request.
 *
 * The finance report, the Today page and the finance charts compute every figure with these functions, from the rows
 * financeBooks.ts loads, so they cannot disagree. test/financeCore.test.ts proves the endpoints return what these functions return.
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
  category?: string;
  resourceId?: string | null;
  planId?: string | null;
}

export interface PaymentRow {
  id?: string;
  invoiceId: string;
  amountCents: number;
  method: string;
  paidAt: string;
  createdAt?: string;
}

export interface LedgerRow {
  kind: 'received' | 'refunded' | 'kept' | 'advance' | 'advance_refund';
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

/**
 * What members were billed: invoice totals including the part an advance paid (the "Advance paid" lines added back), since the advance
 * itself is counted as money in when it arrives. Credit lines are not added back: that money was billed on an earlier invoice.
 * This is what the finance report and the Today page call "invoiced".
 */
export function billedCents(invoices: InvoiceRow[], lines: InvoiceLineRow[], days: DayRange) {
  const counted = new Set(invoices.filter((i) => live(i) && inDays(i.issueDate, days)).map((i) => i.id));
  return invoicedCents(invoices, days) - sum(lines.filter((l) => counted.has(l.invoiceId) && l.amountCents < 0 && (l.category ?? 'advance') === 'advance').map((l) => l.amountCents));
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

// ---- Tax collected and income by what was sold ----------------------------------------------------------------------------------

const byPaidOrder = (a: PaymentRow, b: PaymentRow) => a.paidAt.localeCompare(b.paidAt) || (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || (a.id ?? '').localeCompare(b.id ?? '');

/**
 * The tax inside each payment. A payment of part of an invoice carries the same share of its tax; the shares are worked out on the
 * running total of what has been paid, so once an invoice is paid in full its payments carry exactly its tax, whatever the rounding.
 * A reversal takes its share back. Keyed by payment id.
 */
export function paymentTaxCents(invoices: InvoiceRow[], payments: (PaymentRow & { id: string })[]) {
  const byId = new Map(invoices.map((i) => [i.id, i]));
  const out = new Map<string, number>();
  const groups = new Map<string, (PaymentRow & { id: string })[]>();
  for (const p of payments) groups.set(p.invoiceId, [...(groups.get(p.invoiceId) ?? []), p]);
  for (const [invoiceId, list] of groups) {
    const inv = byId.get(invoiceId);
    let paid = 0;
    const taxOf = (x: number) => (inv && inv.totalCents > 0 ? Math.round((Math.min(x, inv.totalCents) * inv.taxCents) / inv.totalCents) : 0);
    for (const p of [...list].sort(byPaidOrder)) {
      const before = taxOf(paid);
      paid += p.amountCents;
      out.set(p.id, taxOf(Math.max(0, paid)) - before);
    }
  }
  return out;
}

/** Income, as finance groups it: what was sold, or the kind of money that came in without an invoice. */
export type IncomeCategory = 'plan' | 'rent' | 'booking' | 'manual' | 'amenity' | 'advance' | 'kept_deposit';
/** The five kinds the finance screens draw. Plans and rent are memberships; bookings and other charges are one group. */
export type IncomeKind = 'subscription' | 'manual' | 'kept_deposit' | 'advance' | 'amenities';
export const INCOME_KIND: Record<IncomeCategory, IncomeKind> = {
  plan: 'subscription',
  rent: 'subscription',
  booking: 'manual',
  manual: 'manual',
  amenity: 'amenities',
  advance: 'advance',
  kept_deposit: 'kept_deposit',
};

/** One piece of income: when it came in, before tax, what it was for, and how it was paid. */
export interface IncomeEntry {
  at: string;
  amountCents: number;
  category: IncomeCategory;
  method: string;
  resourceId: string | null;
  planId: string | null;
}

/** Splits an amount over weights in proportion, rounding so the parts add up to the amount exactly (the last part takes the rest). */
export function splitByWeight(amount: number, weights: number[]): number[] {
  const total = sum(weights);
  if (!weights.length) return [];
  if (total <= 0) return weights.map((_, i) => (i === weights.length - 1 ? amount : 0));
  let given = 0;
  return weights.map((w, i) => {
    if (i === weights.length - 1) return amount - given;
    const part = Math.round((amount * w) / total);
    given += part;
    return part;
  });
}

export interface Books {
  invoices: InvoiceRow[];
  lines: (InvoiceLineRow & { category: string })[];
  payments: (PaymentRow & { id: string })[];
  ledger: (LedgerRow & { method: string | null })[];
  /** Amenity charges collected at the desk before desk collections became receipts: income with no invoice. */
  amenityOrders: AmenityOrderRow[];
}

/**
 * Every piece of income in a window, before tax: each invoice payment shared over the invoice's charges (by line), advances when
 * received, deposits when kept, and amenity charges collected at the desk without an invoice. Adds up to money collected less tax.
 */
export function incomeEntries(b: Books, w: InstantWindow): IncomeEntry[] {
  const tax = paymentTaxCents(b.invoices, b.payments);
  const charges = new Map<string, InvoiceLineRow[]>();
  for (const l of b.lines) if (l.amountCents > 0) charges.set(l.invoiceId, [...(charges.get(l.invoiceId) ?? []), l]);
  const out: IncomeEntry[] = [];
  for (const p of b.payments) {
    if (!inWindow(p.paidAt, w)) continue;
    const net = p.amountCents - (tax.get(p.id) ?? 0);
    const lines = charges.get(p.invoiceId) ?? [];
    if (!lines.length) {
      out.push({ at: p.paidAt, amountCents: net, category: 'manual', method: p.method, resourceId: null, planId: null });
      continue;
    }
    splitByWeight(net, lines.map((l) => l.amountCents)).forEach((part, i) => {
      const l = lines[i]!;
      const category = (['plan', 'rent', 'booking', 'amenity'] as const).find((c) => c === l.category) ?? 'manual';
      out.push({ at: p.paidAt, amountCents: part, category, method: p.method, resourceId: l.resourceId ?? null, planId: l.planId ?? null });
    });
  }
  for (const e of b.ledger) {
    if (!inWindow(e.occurredAt, w)) continue;
    if (e.kind === 'advance') out.push({ at: e.occurredAt, amountCents: e.amountCents, category: 'advance', method: e.method ?? 'cash', resourceId: null, planId: null });
    if (e.kind === 'advance_refund') out.push({ at: e.occurredAt, amountCents: -e.amountCents, category: 'advance', method: e.method ?? 'cash', resourceId: null, planId: null });
    if (e.kind === 'kept') out.push({ at: e.occurredAt, amountCents: e.amountCents, category: 'kept_deposit', method: 'kept_deposit', resourceId: null, planId: null });
  }
  for (const o of b.amenityOrders) {
    if (o.chargeCents > 0 && o.collectedAt && !o.invoiceId && inWindow(o.collectedAt, w)) out.push({ at: o.collectedAt, amountCents: o.chargeCents, category: 'amenity', method: 'cash', resourceId: null, planId: null });
  }
  return out;
}

/** The tax inside the payments made in a window. Collected less this is income. */
export function taxCollectedCents(b: Books, w: InstantWindow) {
  const tax = paymentTaxCents(b.invoices, b.payments);
  return sum(b.payments.filter((p) => inWindow(p.paidAt, w)).map((p) => tax.get(p.id) ?? 0));
}

/**
 * All money in during a window, by how it came: invoice payments by their method, advances by theirs, deposits kept as
 * "kept_deposit" (no money moved: it was received earlier) and old-style desk collections as "other". Adds up to money collected.
 */
export function moneyInByMethod(b: Books, w: InstantWindow) {
  const by = new Map<string, number>();
  const add = (method: string, cents: number) => by.set(method, (by.get(method) ?? 0) + cents);
  for (const p of b.payments) if (inWindow(p.paidAt, w)) add(p.method, p.amountCents);
  for (const e of b.ledger) {
    if (!inWindow(e.occurredAt, w)) continue;
    if (e.kind === 'advance') add(e.method ?? 'cash', e.amountCents);
    if (e.kind === 'advance_refund') add(e.method ?? 'cash', -e.amountCents);
    if (e.kind === 'kept') add('kept_deposit', e.amountCents);
  }
  for (const o of b.amenityOrders) if (o.chargeCents > 0 && o.collectedAt && !o.invoiceId && inWindow(o.collectedAt, w)) add('cash', o.chargeCents);
  return [...by.entries()].filter(([, cents]) => cents !== 0).map(([method, amountCents]) => ({ method, amountCents })).sort((x, y) => y.amountCents - x.amountCents || x.method.localeCompare(y.method));
}

/** Money in (cash basis), the same total as collectedByKind, from the books. */
export const collectedCents = (b: Books, w: InstantWindow) => sum(moneyInByMethod(b, w).map((m) => m.amountCents));

/** The members who owe the most at the end of a day, with the overdue part and the oldest due date. */
export function topDebtors(invoices: InvoiceRow[], payments: PaymentRow[], day: string, tz: string, limit = 10) {
  const by = new Map<string, { memberId: string; owedCents: number; overdueCents: number; oldestDue: string; invoices: number }>();
  for (const i of invoices.filter((x) => live(x) && x.issueDate <= day)) {
    const owed = i.totalCents - sum(payments.filter((p) => p.invoiceId === i.id && localDate(p.paidAt, tz) <= day).map((p) => p.amountCents));
    if (owed <= 0) continue;
    const row = by.get(i.memberId) ?? { memberId: i.memberId, owedCents: 0, overdueCents: 0, oldestDue: i.dueDate, invoices: 0 };
    row.owedCents += owed;
    if (i.dueDate < day) row.overdueCents += owed;
    if (i.dueDate < row.oldestDue) row.oldestDue = i.dueDate;
    row.invoices++;
    by.set(i.memberId, row);
  }
  return [...by.values()].sort((a, b) => b.owedCents - a.owedCents).slice(0, limit);
}

/** Invoices issued in a range by status, with what they came to and what is still owed. "overdue" is the open ones past due on `today`. */
export function invoicesByStatus(invoices: InvoiceRow[], days: DayRange, today: string) {
  const issued = invoices.filter((i) => inDays(i.issueDate, days));
  const row = (list: InvoiceRow[]) => ({ count: list.length, totalCents: sum(list.map((i) => i.totalCents)), owedCents: sum(list.filter(live).map((i) => i.totalCents - i.paidCents)) });
  return {
    open: row(issued.filter((i) => i.status === 'open')),
    paid: row(issued.filter((i) => i.status === 'paid')),
    void: { ...row(issued.filter((i) => i.status === 'void')), owedCents: 0 },
    overdue: row(issued.filter((i) => i.status === 'open' && i.dueDate < today)),
  };
}

// ---- Channels: how money moved, and what is in the till and the bank ------------------------------------------------------------

/** The four ways money moves. Cash is the till; card, online transfer and cleared cheques land in the bank. */
export const CHANNELS = ['cash', 'card', 'bank_transfer', 'cheque'] as const;
export type Channel = (typeof CHANNELS)[number];
export const BANK_CHANNELS: Channel[] = ['card', 'bank_transfer', 'cheque'];

export interface ExpenseRow {
  amountCents: number;
  method: string;
  incurredOn: string;
}

export interface ChannelFlow {
  method: Channel;
  /** Money received for what was sold: invoice payments, advances, old desk amenity cash. */
  salesInCents: number;
  /** Security deposits received: in the till or the bank, but held for the member (a liability, not income). */
  depositsInCents: number;
  /** Money given back: payment reversals, advance refunds, deposit refunds. */
  refundsOutCents: number;
  /** Expenses paid through this channel. */
  expensesOutCents: number;
  /** In less out. */
  netCents: number;
}

const asChannel = (m: string | null | undefined): Channel => ((CHANNELS as readonly string[]).includes(m ?? '') ? (m as Channel) : 'cash');

/**
 * Money in and out of each channel for instants in [start, end) and expense days in `days`. Kept deposits move no money (it came in
 * when the deposit was received), so they are in no channel. Pending and bounced cheques are not in the books at all.
 */
export function channelFlows(b: Books, expenses: ExpenseRow[], w: InstantWindow, days: DayRange): ChannelFlow[] {
  const rows = new Map<Channel, ChannelFlow>(CHANNELS.map((m) => [m, { method: m, salesInCents: 0, depositsInCents: 0, refundsOutCents: 0, expensesOutCents: 0, netCents: 0 }]));
  for (const p of b.payments) {
    if (!inWindow(p.paidAt, w)) continue;
    const r = rows.get(asChannel(p.method))!;
    if (p.amountCents >= 0) r.salesInCents += p.amountCents;
    else r.refundsOutCents += -p.amountCents;
  }
  for (const e of b.ledger) {
    if (!inWindow(e.occurredAt, w)) continue;
    const r = rows.get(asChannel(e.method))!;
    if (e.kind === 'advance') r.salesInCents += e.amountCents;
    if (e.kind === 'received') r.depositsInCents += e.amountCents;
    if (e.kind === 'advance_refund' || e.kind === 'refunded') r.refundsOutCents += e.amountCents;
  }
  for (const o of b.amenityOrders) if (o.chargeCents > 0 && o.collectedAt && !o.invoiceId && inWindow(o.collectedAt, w)) rows.get('cash')!.salesInCents += o.chargeCents;
  for (const x of expenses) if (inDays(x.incurredOn, days)) rows.get(asChannel(x.method))!.expensesOutCents += x.amountCents;
  for (const r of rows.values()) r.netCents = r.salesInCents + r.depositsInCents - r.refundsOutCents - r.expensesOutCents;
  return [...rows.values()];
}

/**
 * What should be in the till and in the bank at the end of `day`: every movement since the space started using the system, in less out.
 * There is no opening balance, so it is what the system recorded, to be counted against the drawer and the bank statement.
 */
export function balancesAsOf(b: Books, expenses: ExpenseRow[], endIso: string, day: string) {
  const flows = channelFlows(b, expenses, { start: '0000', end: endIso }, { from: '0000-01-01', to: day });
  const net = (m: Channel) => flows.find((f) => f.method === m)!.netCents;
  return { cashInHandCents: net('cash'), bankCents: sum(BANK_CHANNELS.map(net)), byChannel: Object.fromEntries(CHANNELS.map((m) => [m, net(m)])) as Record<Channel, number> };
}

// ---- Receivables aging per customer ---------------------------------------------------------------------------------------------

export interface MemberAging {
  memberId: string;
  /** Not yet due. */
  currentCents: number;
  /** 0 to 30 days past due. */
  days1to30Cents: number;
  days31to60Cents: number;
  days61plusCents: number;
  totalCents: number;
  oldestDue: string;
}

/** The aged receivables ledger: what each member owed at the end of `day`, split by how late it was. Largest balance first. */
export function agingByMember(invoices: InvoiceRow[], payments: PaymentRow[], day: string, tz: string): MemberAging[] {
  const by = new Map<string, MemberAging>();
  for (const { i, owed } of owedAsOf(invoices, payments, day, tz)) {
    const row = by.get(i.memberId) ?? { memberId: i.memberId, currentCents: 0, days1to30Cents: 0, days31to60Cents: 0, days61plusCents: 0, totalCents: 0, oldestDue: i.dueDate };
    const late = daysBetween(i.dueDate, day);
    if (late <= 0) row.currentCents += owed;
    else if (late <= 30) row.days1to30Cents += owed;
    else if (late <= 60) row.days31to60Cents += owed;
    else row.days61plusCents += owed;
    row.totalCents += owed;
    if (i.dueDate < row.oldestDue) row.oldestDue = i.dueDate;
    by.set(i.memberId, row);
  }
  return [...by.values()].sort((a, b) => b.totalCents - a.totalCents);
}
