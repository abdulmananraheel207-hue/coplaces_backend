import { eq } from 'drizzle-orm';
import { amenityOrders, depositEntries, expenses, invoiceItems, invoices, members, payments } from '../../src/db/schema.js';
import { addDays, addMonths, zonedToUtc } from '../../src/lib/time.js';
import type { Ctx } from '../helpers.js';
import { TZ } from '../helpers.js';
import { acme, financeReport, generate, manualInvoice, ownerOf, planMember, planWithShifts, sum, today, type Agent } from './finance.js';

/**
 * The reconciliation check.
 *
 * `buildReconciliationScenario` fills a location with the cases that break finance code: part payments, a void, a backdated payment,
 * payments either side of midnight at a month end, an overdue invoice, an advance used on an invoice, contract deposits kept and
 * refunded, amenities collected at the desk and on an invoice, a company contract with an advance, and expenses in two months.
 *
 * `reconcile` then reads the same money from the database rows directly (with its own local-date code, not the application's) and
 * compares it with every screen that shows it: the finance report (totals, monthly series, profit and loss, income by kind, payments by
 * method, aging, deposits, amenities), the Today page, the invoice and payment and expense lists, and each member's balance.
 *
 * Each check carries the id of the known bug that makes it wrong today (`bug`), or none. Checks without a bug must hold now; each bug's
 * checks are asserted together in one `it.fails`, so fixing a bug flips exactly one test.
 */

export interface Check {
  label: string;
  actual: unknown;
  expected: unknown;
  /** The known bug that makes this check wrong today, as in finance-bugs.test.ts. */
  bug?: string;
}

const localDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

export interface Scenario {
  owner: Agent;
  locationId: string;
  from: string;
  to: string;
  previousMonth: string;
  companyMemberId: string;
}

export async function buildReconciliationScenario(ctx: Ctx): Promise<Scenario> {
  const owner = await ownerOf(ctx);
  const L = ctx.loc.id;
  const t = today();
  const prev = addMonths(t.slice(0, 7), -1);
  const prevLast = addDays(`${t.slice(0, 7)}-01`, -1);
  const at = (date: string, time: string) => zonedToUtc(date, time, TZ).toISOString();
  const pay = (invoiceId: string, amountCents: number, paidAt?: string, method = 'cash') =>
    owner.post(`/api/invoices/${invoiceId}/payments`).send({ amountCents, method, ...(paidAt ? { paidAt } : {}) }).expect(201);

  // Legacy-plan members billed for last month, and a company with an advance.
  await ctx.db.update(members).set({ startDate: `${prev}-01` }).where(eq(members.locationId, L)).run();
  const company = await acme(ctx, owner, prev, { advanceCents: 1_000_000 });
  await owner.post(`/api/contracts/${company.id}/advance`).send({ method: 'bank_transfer' }).expect(200);
  const gen = (await generate(owner, L, prev)).body.invoices as { id: string; memberId: string; totalCents: number }[];
  const proBill = gen.find((i) => i.memberId === ctx.pro.member.id)!; // 20,000 + 10%
  const basicBill = gen.find((i) => i.memberId === ctx.basic.member.id)!; // 5,000 + 10%
  const companyBill = gen.find((i) => i.memberId === company.memberId)!;

  // Part payment backdated into last month, the rest today; a void; a company part payment.
  await pay(proBill.id, 10_000, at(`${prev}-15`, '12:00'));
  await pay(proBill.id, proBill.totalCents - 10_000, undefined, 'card');
  await owner.post(`/api/invoices/${basicBill.id}/void`).expect(200);
  await pay(companyBill.id, 500_000, undefined, 'bank_transfer');

  // Payments a minute either side of midnight at the month end.
  const manual = await manualInvoice(owner, ctx.basic.member.id, 3_000); // 3,300
  await pay(manual.id, 1_000, at(prevLast, '23:59'));
  await pay(manual.id, 1_000, at(`${t.slice(0, 7)}-01`, '00:01'), 'jazzcash');

  // An invoice that is overdue and untouched.
  await manualInvoice(owner, ctx.pro.member.id, 7_000, { issueDate: `${prev}-01`, dueDate: `${prev}-05` });

  // A plan member whose advance comes off the shift invoice, then a part payment.
  const p = await planWithShifts(ctx, owner, 'Recon');
  const planned = await planMember(ctx, owner, p, { advanceCents: 200_000, method: 'easypaisa' });
  const planBill = (await ctx.db.select().from(invoices).where(eq(invoices.memberId, planned.id)).all())[0]!;
  await pay(planBill.id, 100_000);

  // A contract deposit received, then partly refunded (the rest kept); another still held.
  const ended = (await owner.post('/api/contracts').send({ locationId: L, memberId: ctx.pro.member.id, startDate: `${prev}-01`, depositCents: 50_000 }).expect(201)).body;
  await owner.post(`/api/contracts/${ended.id}/deposit`).send({ action: 'receive', method: 'cash' }).expect(200);
  await owner.post(`/api/contracts/${ended.id}/activate`).expect(200);
  await owner.post(`/api/contracts/${ended.id}/end`).send({}).expect(200);
  await owner.post(`/api/contracts/${ended.id}/deposit`).send({ action: 'refund', returnedCents: 20_000, method: 'cash' }).expect(200);
  const held = (await owner.post('/api/contracts').send({ locationId: L, memberId: ctx.basic.member.id, startDate: t, depositCents: 40_000 }).expect(201)).body;
  await owner.post(`/api/contracts/${held.id}/deposit`).send({ action: 'receive', method: 'card' }).expect(200);

  // Amenities: collected at the desk for one member, put on an invoice and paid for another.
  const tea = (await owner.post('/api/amenities').send({ locationId: L, name: 'Tea', priceCents: 200 }).expect(201)).body;
  await owner.post('/api/amenities/orders').send({ memberId: ctx.pro.member.id, amenityId: tea.id, quantity: 3 }).expect(201);
  await owner.post('/api/amenities/collect').send({ memberId: ctx.pro.member.id }).expect(200);
  await owner.post('/api/amenities/orders').send({ memberId: ctx.basic.member.id, amenityId: tea.id, quantity: 2 }).expect(201);
  const teaBill = (await owner.post('/api/amenities/invoice').send({ memberId: ctx.basic.member.id }).expect(201)).body;
  await pay(teaBill.id, teaBill.totalCents);

  // Costs in both months.
  await owner.post('/api/expenses').send({ locationId: L, category: 'rent', amountCents: 100_000, incurredOn: `${prev}-15` }).expect(201);
  await owner.post('/api/expenses').send({ locationId: L, category: 'supplies', amountCents: 5_000, incurredOn: t }).expect(201);

  return { owner, locationId: L, from: `${prev}-01`, to: t, previousMonth: prev, companyMemberId: company.memberId };
}

export async function reconcile(ctx: Ctx, s: Scenario): Promise<Check[]> {
  const { owner, locationId: L, from, to } = s;
  const checks: Check[] = [];
  const check = (label: string, actual: unknown, expected: unknown, bug?: string) => checks.push({ label, actual, expected, ...(bug ? { bug } : {}) });
  const inRange = (day: string, a = from, b = to) => day >= a && day <= b;

  // ---- the books, straight from the rows
  const pays = await ctx.db.select().from(payments).where(eq(payments.locationId, L)).all();
  const invs = await ctx.db.select().from(invoices).where(eq(invoices.locationId, L)).all();
  const live = invs.filter((i) => i.status !== 'void');
  const items = await ctx.db.select().from(invoiceItems).all();
  const moves = await ctx.db.select().from(depositEntries).where(eq(depositEntries.locationId, L)).all();
  const orders = await ctx.db.select().from(amenityOrders).where(eq(amenityOrders.locationId, L)).all();
  const costs = await ctx.db.select().from(expenses).where(eq(expenses.locationId, L)).all();

  const paysIn = pays.filter((p) => inRange(localDay(p.paidAt)));
  const movesIn = (kind: string) => moves.filter((m) => m.kind === kind && inRange(localDay(m.occurredAt)));
  const deskIn = orders.filter((o) => o.chargeCents > 0 && o.collectedAt && !o.invoiceId && inRange(localDay(o.collectedAt)));
  const payIn = sum(paysIn.map((p) => p.amountCents));
  const kept = sum(movesIn('kept').map((m) => m.amountCents));
  const advanced = sum(movesIn('advance').map((m) => m.amountCents));
  const desk = sum(deskIn.map((o) => o.chargeCents));
  const collected = payIn + kept + advanced + desk;
  const spent = sum(costs.filter((e) => inRange(e.incurredOn)).map((e) => e.amountCents));
  const invoiced = sum(live.filter((i) => inRange(i.issueDate)).map((i) => i.totalCents));
  const advanceLines = (inv: (typeof invs)[number]) => -sum(items.filter((l) => l.invoiceId === inv.id && l.amountCents < 0 && l.category === 'advance').map((l) => l.amountCents));
  /** What members were billed: invoice totals with the part an advance paid added back (the advance is money in when received). */
  const billed = invoiced + sum(live.filter((i) => inRange(i.issueDate)).map(advanceLines));
  const openBalance = sum(live.filter((i) => i.status === 'open').map((i) => i.totalCents - i.paidCents));

  /** The tax inside each payment, worked out again here: each invoice's tax shared over its payments on the running total paid. */
  const taxIn = new Map<string, number>();
  for (const i of invs) {
    let paid = 0;
    const taxOf = (x: number) => (i.totalCents > 0 ? Math.round((Math.min(x, i.totalCents) * i.taxCents) / i.totalCents) : 0);
    const mine = pays.filter((p) => p.invoiceId === i.id).sort((a, b) => a.paidAt.localeCompare(b.paidAt) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    for (const p of mine) {
      const before = taxOf(paid);
      paid += p.amountCents;
      taxIn.set(p.id, taxOf(Math.max(0, paid)) - before);
    }
  }
  const tax = sum(paysIn.map((p) => taxIn.get(p.id) ?? 0));
  for (const i of live.filter((x) => x.status === 'paid' && x.paidCents === x.totalCents)) {
    check(`${i.number}: its payments carry exactly its tax`, sum(pays.filter((p) => p.invoiceId === i.id).map((p) => taxIn.get(p.id) ?? 0)), i.taxCents);
  }

  /** What was owed at the end of a day: invoices issued by then, less what was paid by then. */
  const owedAsOf = (day: string) =>
    sum(
      live
        .filter((i) => i.issueDate <= day)
        .map((i) => Math.max(0, i.totalCents - sum(pays.filter((p) => p.invoiceId === i.id && localDay(p.paidAt) <= day).map((p) => p.amountCents)))),
    );
  const heldAsOf = (day: string) => {
    const k = (kind: string) => sum(moves.filter((m) => m.kind === kind && localDay(m.occurredAt) <= day).map((m) => m.amountCents));
    return k('received') - k('refunded') - k('kept');
  };

  // ---- the finance report
  const rep = await financeReport(owner, L, from, to);
  check('report: collected', rep.totals.collectedCents, collected);
  check('report: invoiced is what was billed, the part an advance paid included', rep.totals.invoicedCents, billed);
  check('report: tax collected', rep.totals.taxCollectedCents, tax);
  check('report: income before tax', rep.totals.incomeCents, collected - tax);
  check('report: expenses', rep.totals.expensesCents, spent);
  check('report: net (cash)', rep.totals.netCents, collected - spent);
  check('report: profit (income before tax less expenses)', rep.totals.profitCents, collected - tax - spent);
  const kind = (k: string) => rep.incomeByKind.find((x: { kind: string }) => x.kind === k)?.amountCents;
  check('report: income of kind advance', kind('advance'), advanced);
  check('report: income of kind kept_deposit', kind('kept_deposit'), kept);
  check('report: income from invoices and the desk, before tax', kind('subscription') + kind('manual') + kind('amenities'), payIn - tax + desk);
  check('report: income by kind adds up', sum(rep.incomeByKind.map((x: { amountCents: number }) => x.amountCents)), collected - tax);
  check('report: income by category adds up', sum(rep.incomeByCategory.map((x: { amountCents: number }) => x.amountCents)), collected - tax);
  check('report: monthly money in adds up', sum(rep.monthly.map((m: { collectedCents: number }) => m.collectedCents)), collected);
  check('report: monthly money out adds up', sum(rep.monthly.map((m: { expensesCents: number }) => m.expensesCents)), spent);
  check('report: monthly invoiced adds up', sum(rep.monthly.map((m: { invoicedCents: number }) => m.invoicedCents)), billed);
  for (const m of rep.monthly as { month: string; collectedCents: number; expensesCents: number; invoicedCents: number; netCents: number }[]) {
    const end = addDays(`${addMonths(m.month, 1)}-01`, -1);
    const a = m.month === from.slice(0, 7) ? from : `${m.month}-01`;
    const b = end > to ? to : end;
    const inMonth = (day: string) => inRange(day, a, b);
    const monthIn =
      sum(pays.filter((p) => inMonth(localDay(p.paidAt))).map((p) => p.amountCents)) +
      sum(moves.filter((x) => (x.kind === 'kept' || x.kind === 'advance') && inMonth(localDay(x.occurredAt))).map((x) => x.amountCents)) +
      sum(orders.filter((o) => o.chargeCents > 0 && o.collectedAt && !o.invoiceId && inMonth(localDay(o.collectedAt))).map((o) => o.chargeCents));
    check(`report: ${m.month} money in, by local date`, m.collectedCents, monthIn);
    check(`report: ${m.month} money out`, m.expensesCents, sum(costs.filter((e) => inMonth(e.incurredOn)).map((e) => e.amountCents)));
    check(`report: ${m.month} net`, m.netCents, m.collectedCents - m.expensesCents);
  }
  check('report: profit and loss income is income before tax', sum(rep.profitLoss.income.map((r: { totalCents: number }) => r.totalCents)), collected - tax);
  check('report: profit and loss tax', rep.profitLoss.tax.totalCents, tax);
  check('report: profit and loss costs', sum(rep.profitLoss.costs.map((r: { totalCents: number }) => r.totalCents)), spent);
  check('report: expenses by category', sum(rep.expensesByCategory.map((r: { amountCents: number }) => r.amountCents)), spent);
  check('report: aging adds up to what is owed now (the end date is today)', sum(Object.values(rep.receivablesAging).map((b) => (b as { amountCents: number }).amountCents)), openBalance);
  check('report: deposits held', rep.deposits.heldCents, heldAsOf(to));
  check('report: deposits received in range', rep.deposits.receivedCents, sum(movesIn('received').map((m) => m.amountCents)));
  check('report: deposits refunded in range', rep.deposits.refundedCents, sum(movesIn('refunded').map((m) => m.amountCents)));
  check('report: amenities still owed', rep.amenities.owedCents, sum(orders.filter((o) => o.chargeCents > 0 && !o.collectedAt && !o.invoiceId).map((o) => o.chargeCents)));
  check('report: amenities collected = amenity income', rep.amenities.collectedCents, rep.incomeByCategory.find((x: { category: string }) => x.category === 'amenity')?.amountCents ?? 0);
  // Every way money came in has a method, so the methods add up to what was collected.
  check('report: payments by method reconcile with money collected', sum(rep.paymentsByMethod.map((m: { amountCents: number }) => m.amountCents)), collected);
  check('report: advances by method', sum(rep.paymentsByMethod.filter((m: { method: string }) => m.method === 'bank_transfer').map((m: { amountCents: number }) => m.amountCents)), sum(paysIn.filter((p) => p.method === 'bank_transfer').map((p) => p.amountCents)) + sum(movesIn('advance').filter((m) => m.method === 'bank_transfer').map((m) => m.amountCents)));
  // The company's 10,000.00 advance must come off its invoices.
  const companyLive = live.filter((i) => i.memberId === s.companyMemberId);
  check('company: advance taken off its invoices', sum(companyLive.map(advanceLines)), 1_000_000);
  check('report: nothing left unapplied', rep.unapplied, { advancesCents: 0, creditsCents: 0 });

  // ---- a report that ends last month: aging and deposits as of that day
  const prevEnd = addDays(`${to.slice(0, 7)}-01`, -1);
  const past = await financeReport(owner, L, from, prevEnd);
  check('past report: aging as of its end date', sum(Object.values(past.receivablesAging).map((b) => (b as { amountCents: number }).amountCents)), owedAsOf(prevEnd));
  check('past report: deposits held as of its end date', past.deposits.heldCents, heldAsOf(prevEnd));
  check('past report: says what date it is as of', past.asOf, prevEnd);

  // ---- the Today page against a report for this month
  const monthStart = `${to.slice(0, 7)}-01`;
  const thisMonth = await financeReport(owner, L, monthStart, to);
  const dash = (await owner.get(`/api/reports/dashboard?locationId=${L}`).expect(200)).body.finance;
  check('Today: money in this month = report for this month', dash.collectedThisMonthCents, thisMonth.totals.collectedCents);
  check('Today: invoiced this month = report for this month', dash.invoicedThisMonthCents, thisMonth.totals.invoicedCents);
  check('Today: money out this month = report for this month', dash.expensesThisMonthCents, thisMonth.totals.expensesCents);
  check('Today: outstanding', dash.outstandingCents, openBalance);
  check('Today: overdue', dash.overdueCents, sum(live.filter((i) => i.status === 'open' && i.dueDate < to).map((i) => i.totalCents - i.paidCents)));

  // ---- the lists
  const list = (await owner.get(`/api/invoices?locationId=${L}`).expect(200)).body as { status: string; balanceCents: number; totalCents: number; issueDate: string; overdue: boolean }[];
  check('invoice list: open balances = outstanding', sum(list.filter((i) => i.status === 'open').map((i) => i.balanceCents)), openBalance);
  check('invoice list: totals in range = invoiced', sum(list.filter((i) => i.status !== 'void' && inRange(i.issueDate)).map((i) => i.totalCents)), invoiced);
  const overdueList = (await owner.get(`/api/invoices?locationId=${L}&status=overdue`).expect(200)).body as { balanceCents: number }[];
  check('invoice list: overdue = Today overdue', sum(overdueList.map((i) => i.balanceCents)), dash.overdueCents);
  const payList = (await owner.get(`/api/payments?locationId=${L}&from=${from}&to=${to}`).expect(200)).body as { amountCents: number }[];
  check('payment list = invoice payments in the report', sum(payList.map((p) => p.amountCents)), payIn);
  const costList = (await owner.get(`/api/expenses?locationId=${L}&from=${from}&to=${to}`).expect(200)).body as { amountCents: number }[];
  check('expense list = report expenses', sum(costList.map((e) => e.amountCents)), spent);

  // ---- every member's balance
  let balances = 0;
  for (const m of await ctx.db.select().from(members).where(eq(members.locationId, L)).all()) {
    const detail = (await owner.get(`/api/members/${m.id}`).expect(200)).body;
    const owes = sum(live.filter((i) => i.memberId === m.id && i.status === 'open').map((i) => i.totalCents - i.paidCents));
    check(`member ${m.id.slice(0, 8)}: balance`, detail.balanceDueCents, owes);
    check(`member ${m.id.slice(0, 8)}: overdue`, detail.overdueCents, sum(live.filter((i) => i.memberId === m.id && i.status === 'open' && i.dueDate < to).map((i) => i.totalCents - i.paidCents)));
    check(`member ${m.id.slice(0, 8)}: amenities owed`, detail.amenityOwedCents, sum(orders.filter((o) => o.memberId === m.id && !o.collectedAt && !o.invoiceId).map((o) => o.chargeCents)));
    balances += detail.balanceDueCents;
  }
  check('members: balances add up to outstanding', balances, openBalance);

  // ---- the invoices themselves
  for (const i of invs) {
    const lines = items.filter((l) => l.invoiceId === i.id);
    const paid = sum(pays.filter((p) => p.invoiceId === i.id).map((p) => p.amountCents));
    check(`${i.number}: lines add up`, sum(lines.map((l) => l.amountCents)), i.subtotalCents);
    check(`${i.number}: total`, i.totalCents, i.subtotalCents + i.taxCents);
    check(`${i.number}: paid`, i.paidCents, paid);
    check(`${i.number}: status`, i.status, i.status === 'void' ? 'void' : paid >= i.totalCents ? 'paid' : 'open');
  }
  return checks;
}

/** The bug ids a list of checks is waiting on. */
export const bugsIn = (checks: Check[]) => [...new Set(checks.flatMap((c) => (c.bug ? [c.bug] : [])))].sort();
