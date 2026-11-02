import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { amenityOrders, contracts, depositEntries, invoiceItems, invoices, members, payments } from '../src/db/schema.js';
import { addDays, monthRange, zonedToUtc } from '../src/lib/time.js';
import * as core from '../src/services/financeCore.js';
import { login, setup, TZ, type Ctx } from './helpers.js';
import { financeReport, manualInvoice, ownerOf, sum, today } from './helpers/finance.js';
import { buildReconciliationScenario, type Scenario } from './helpers/reconcile.js';

/**
 * Each financeCore function, fed the rows from the database, returns exactly what the endpoints return: they compute with these
 * functions. The second group shows the disagreements Stage 1A recorded (D1-D8) are gone.
 */

async function rowsOf(ctx: Ctx, L: string) {
  const invs = await ctx.db.select().from(invoices).where(eq(invoices.locationId, L)).all();
  const ids = new Set(invs.map((i) => i.id));
  return {
    invoices: invs,
    lines: (await ctx.db.select().from(invoiceItems).all()).filter((l) => ids.has(l.invoiceId)),
    payments: await ctx.db.select().from(payments).where(eq(payments.locationId, L)).all(),
    ledger: await ctx.db.select().from(depositEntries).where(eq(depositEntries.locationId, L)).all(),
    orders: await ctx.db.select().from(amenityOrders).where(eq(amenityOrders.locationId, L)).all(),
    members: await ctx.db.select().from(members).where(eq(members.locationId, L)).all(),
    contracts: await ctx.db.select().from(contracts).where(eq(contracts.locationId, L)).all(),
  };
}

const windowOf = (from: string, to: string) => ({ start: zonedToUtc(from, '00:00', TZ).toISOString(), end: zonedToUtc(addDays(to, 1), '00:00', TZ).toISOString() });

let ctx: Ctx;
let s: Scenario;
let r: Awaited<ReturnType<typeof rowsOf>>;
let rep: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let dash: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(async () => {
  ctx = await setup();
  s = await buildReconciliationScenario(ctx);
  r = await rowsOf(ctx, s.locationId);
  rep = await financeReport(s.owner, s.locationId, s.from, s.to);
  dash = (await s.owner.get(`/api/reports/dashboard?locationId=${s.locationId}`).expect(200)).body.finance;
}, 60_000);

const kindOf = () => {
  const m = new Map(r.invoices.map((i) => [i.id, i.kind] as const));
  return (id: string) => m.get(id);
};

const books = (): core.Books => ({
  invoices: r.invoices,
  lines: r.lines,
  payments: r.payments,
  ledger: r.ledger,
  amenityOrders: r.orders.filter((o) => o.collectedAt && !o.invoiceId && o.chargeCents > 0),
});

describe('the endpoints return exactly what financeCore computes', () => {
  it('invoiced is what was billed: the finance report and the Today page', async () => {
    expect(core.billedCents(r.invoices, r.lines, { from: s.from, to: s.to })).toBe(rep.totals.invoicedCents);
    expect(core.billedCents(r.invoices, r.lines, { from: `${s.to.slice(0, 7)}-01`, to: s.to })).toBe(dash.invoicedThisMonthCents);
  });

  it('money in, tax and income: the totals, every month, income by kind and category, and the Today page', async () => {
    const w = windowOf(s.from, s.to);
    expect(core.collectedCents(books(), w)).toBe(rep.totals.collectedCents);
    expect(core.taxCollectedCents(books(), w)).toBe(rep.totals.taxCollectedCents);
    const income = core.incomeEntries(books(), w);
    expect(sum(income.map((e) => e.amountCents))).toBe(rep.totals.incomeCents);
    for (const k of ['subscription', 'manual', 'kept_deposit', 'advance', 'amenities'] as const) {
      expect(sum(income.filter((e) => core.INCOME_KIND[e.category] === k).map((e) => e.amountCents)), k).toBe(rep.incomeByKind.find((x: { kind: string }) => x.kind === k).amountCents);
    }
    for (const m of rep.monthly as { month: string; collectedCents: number }[]) {
      const range = monthRange(m.month, TZ);
      const w2 = { start: range.start < w.start ? w.start : range.start, end: range.end > w.end ? w.end : range.end };
      expect(core.collectedCents(books(), w2), m.month).toBe(m.collectedCents);
    }
    const month = monthRange(today().slice(0, 7), TZ);
    expect(core.collectedCents(books(), { start: month.start, end: month.end })).toBe(dash.collectedThisMonthCents);
    expect(core.taxCollectedCents(books(), { start: month.start, end: month.end })).toBe(dash.taxCollectedThisMonthCents);
    // The old way of counting (by kind of invoice, tax included) still adds up to the same money in.
    const old = core.collectedByKind({ payments: r.payments, invoiceKind: kindOf(), ledger: r.ledger, amenityOrders: r.orders }, w);
    expect(old.total).toBe(rep.totals.collectedCents);
  });

  it('money in by method', async () => {
    expect(core.moneyInByMethod(books(), windowOf(s.from, s.to))).toEqual(rep.paymentsByMethod);
  });

  it('outstanding and overdue: the Today page, the invoice list and the aging total', async () => {
    expect(core.outstandingCents(r.invoices)).toBe(dash.outstandingCents);
    expect(core.overdueCents(r.invoices, today())).toBe(dash.overdueCents);
    expect(core.overdueCents(r.invoices, today())).toBeGreaterThan(0); // the scenario has an overdue invoice
    const list = (await s.owner.get(`/api/invoices?locationId=${s.locationId}`).expect(200)).body as { status: string; balanceCents: number }[];
    expect(core.outstandingCents(r.invoices)).toBe(sum(list.filter((i) => i.status === 'open').map((i) => i.balanceCents)));
  });

  it('aging and deposits held, as of the report’s end date', async () => {
    expect(core.agingAsOf(r.invoices, r.payments, s.to, TZ)).toEqual(rep.receivablesAging);
    expect(core.depositsHeldAsOf(r.ledger, s.to, TZ)).toBe(rep.deposits.heldCents);
  });

  it('amenities owed: the finance report and each member', async () => {
    expect(core.amenitiesOwedCents(r.orders)).toBe(rep.amenities.owedCents);
  });

  it('a member’s balance: GET /members/:id and /me/summary', async () => {
    for (const m of r.members) {
      const detail = (await s.owner.get(`/api/members/${m.id}`).expect(200)).body;
      expect(core.memberBalance(r.invoices, m.id, today()), m.id).toEqual({ balanceDueCents: detail.balanceDueCents, overdueCents: detail.overdueCents });
      expect(core.amenitiesOwedCents(r.orders.filter((o) => o.memberId === m.id))).toBe(detail.amenityOwedCents);
    }
    const pro = await login(ctx.app, 'pro@test.dev');
    const summary = (await pro.get('/api/me/summary').expect(200)).body;
    expect(core.memberBalance(r.invoices, ctx.pro.member.id, today())).toEqual({ balanceDueCents: summary.balanceDueCents, overdueCents: summary.overdueCents });
    expect(summary.balanceDueCents).toBeGreaterThan(0);
  });

  it('tax: every invoice’s stored tax is the tax of its subtotal at the rate it was issued at', async () => {
    for (const i of r.invoices) expect(i.taxCents, i.number).toBe(core.invoiceTaxCents(i.subtotalCents, i.taxRateBps ?? 1_000));
  });

  it('advances and credits not yet applied', async () => {
    // The plan member's 2,000 advance and the company's 10,000 advance were both used in full on their invoices.
    expect(core.advancesUnappliedCents({ members: r.members, contracts: r.contracts })).toBe(0);
    expect(rep.unapplied).toEqual({ advancesCents: 0, creditsCents: 0 });
  });

  it('the finance charts use the same numbers', async () => {
    const charts = (await s.owner.get(`/api/reports/finance/charts?locationId=${s.locationId}&from=${s.from}&to=${s.to}`).expect(200)).body;
    expect(sum(charts.months.map((m: { collectedCents: number }) => m.collectedCents))).toBe(rep.totals.collectedCents);
    expect(sum(charts.months.map((m: { billedCents: number }) => m.billedCents))).toBe(rep.totals.invoicedCents);
    expect(sum(charts.months.map((m: { taxCollectedCents: number }) => m.taxCollectedCents))).toBe(rep.totals.taxCollectedCents);
    expect(sum(charts.months.map((m: { expensesCents: number }) => m.expensesCents))).toBe(rep.totals.expensesCents);
    const last = charts.months.at(-1);
    expect(last.outstandingEndCents).toBe(core.outstandingAsOf(r.invoices, r.payments, today(), TZ));
    expect(last.depositsHeldEndCents).toBe(rep.deposits.heldCents);
    expect(sum(Object.values(last.moneyInByMethod as Record<string, number>))).toBe(last.collectedCents);
    const debtors = core.topDebtors(r.invoices, r.payments, today(), TZ);
    expect(charts.topDebtors.map((d: { memberId: string; owedCents: number }) => [d.memberId, d.owedCents])).toEqual(debtors.map((d) => [d.memberId, d.owedCents]));
    expect(sum(charts.topDebtors.map((d: { owedCents: number }) => d.owedCents))).toBe(core.outstandingCents(r.invoices));
    expect(charts.invoicesByStatus).toEqual(core.invoicesByStatus(r.invoices, { from: s.from, to: s.to }, today()));
    const income = core.incomeEntries(books(), windowOf(s.from, s.to));
    expect(charts.incomeByPlan.length).toBeGreaterThan(0); // the plan member's shifts
    expect(sum(charts.incomeByPlan.map((x: { amountCents: number }) => x.amountCents))).toBe(sum(income.filter((e) => e.planId).map((e) => e.amountCents)));
    expect(sum(charts.incomeBySpace.map((x: { amountCents: number }) => x.amountCents))).toBe(sum(income.filter((e) => e.resourceId).map((e) => e.amountCents)));
  });
});

describe('the disagreements Stage 1A recorded are gone', () => {
  it('D1 outstanding (H5b): a payment cannot be dated in the future, so outstanding now and as of today agree', async () => {
    const c2 = await setup();
    const owner = await ownerOf(c2);
    const inv = await manualInvoice(owner, c2.basic.member.id, 10_000); // 11,000
    await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 4_000, method: 'cash', paidAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }).expect(400);
    await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 4_000, method: 'cash' }).expect(201);
    const rows2 = await rowsOf(c2, c2.loc.id);
    const d = (await owner.get(`/api/reports/dashboard?locationId=${c2.loc.id}`).expect(200)).body.finance;
    expect(d.outstandingCents).toBe(core.outstandingCents(rows2.invoices));
    expect(core.outstandingCents(rows2.invoices)).toBe(7_000);
    expect(core.outstandingAsOf(rows2.invoices, rows2.payments, today(), TZ)).toBe(7_000);
  });

  it('D2 aging (R4a): a report that ends last month ages what was owed then', async () => {
    const end = addDays(`${s.to.slice(0, 7)}-01`, -1);
    const past = await financeReport(s.owner, s.locationId, s.from, end);
    expect(past.receivablesAging).toEqual(core.agingAsOf(r.invoices, r.payments, end, TZ));
  });

  it('D3 deposits held (R4b): a report that ends last month counts what was held then', async () => {
    const end = addDays(`${s.to.slice(0, 7)}-01`, -1);
    const past = await financeReport(s.owner, s.locationId, s.from, end);
    expect(past.deposits.heldCents).toBe(core.depositsHeldAsOf(r.ledger, end, TZ));
  });

  it('D4 invoiced (R1): includes the part of a bill an advance paid', async () => {
    const days = { from: s.from, to: s.to };
    expect(core.billedCents(r.invoices, r.lines, days) - core.invoicedCents(r.invoices, days)).toBe(1_200_000); // the plan member's 2,000 and the company's 10,000
    expect(rep.totals.invoicedCents).toBe(core.billedCents(r.invoices, r.lines, days));
  });

  it('D5 tax (R2): reported on its own and kept out of income', async () => {
    expect(rep.totals.taxCollectedCents).toBeGreaterThan(0);
    expect(sum(rep.profitLoss.income.map((x: { totalCents: number }) => x.totalCents))).toBe(rep.totals.collectedCents - rep.totals.taxCollectedCents);
  });

  it('D6 payments by method (L3): every way money came in has a method, so it adds up to money collected', async () => {
    expect(sum(rep.paymentsByMethod.map((m: { amountCents: number }) => m.amountCents))).toBe(rep.totals.collectedCents);
  });

  it('D7 what a member owes: the balance leaves out amenities still owed at the desk, which are a second figure', async () => {
    const c2 = await setup();
    const owner = await ownerOf(c2);
    await manualInvoice(owner, c2.basic.member.id, 10_000);
    const tea = (await owner.post('/api/amenities').send({ locationId: c2.loc.id, name: 'Tea', priceCents: 200 }).expect(201)).body;
    await owner.post('/api/amenities/orders').send({ memberId: c2.basic.member.id, amenityId: tea.id, quantity: 2 }).expect(201);
    const detail = (await owner.get(`/api/members/${c2.basic.member.id}`).expect(200)).body;
    const rows2 = await rowsOf(c2, c2.loc.id);
    expect(detail.balanceDueCents).toBe(core.memberBalance(rows2.invoices, c2.basic.member.id, today()).balanceDueCents);
    // Still two figures by design: invoices owed, and amenities not yet billed. Both are shown on the member page and the portal.
    expect([detail.balanceDueCents, detail.amenityOwedCents]).toEqual([11_000, 400]);
  });

  it('D8 advances not yet applied (H1): a company advance is used on its invoice, and the report says what is left', async () => {
    expect(core.advancesUnappliedCents({ members: r.members, contracts: r.contracts })).toBe(0);
    expect(r.contracts.find((c) => c.companyName)!.advanceUsedCents).toBe(1_000_000);
  });
});
