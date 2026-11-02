import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { amenityOrders, contracts, depositEntries, invoiceItems, invoices, members, payments } from '../src/db/schema.js';
import { addDays, monthRange, zonedToUtc } from '../src/lib/time.js';
import * as core from '../src/services/financeCore.js';
import { login, setup, TZ, type Ctx } from './helpers.js';
import { financeReport, manualInvoice, ownerOf, sum, today } from './helpers/finance.js';
import { buildReconciliationScenario, type Scenario } from './helpers/reconcile.js';

/**
 * Characterization: each financeCore function, fed the rows from the database, returns exactly what the matching endpoint returns
 * today. The second group pins down every place where today's definition differs from the "as of a date" or corrected one, so the
 * difference is recorded by a passing test, not only described.
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

describe('financeCore returns exactly what the endpoints return today', () => {
  it('invoiced: the finance report and the Today page', async () => {
    expect(core.invoicedCents(r.invoices, { from: s.from, to: s.to })).toBe(rep.totals.invoicedCents);
    expect(core.invoicedCents(r.invoices, { from: `${s.to.slice(0, 7)}-01`, to: s.to })).toBe(dash.invoicedThisMonthCents);
  });

  it('collected by kind: incomeByKind, the total, every month, and the Today page', async () => {
    const got = core.collectedByKind({ payments: r.payments, invoiceKind: kindOf(), ledger: r.ledger, amenityOrders: r.orders }, windowOf(s.from, s.to));
    for (const k of ['subscription', 'manual', 'kept_deposit', 'advance', 'amenities'] as const) {
      expect(got[k], k).toBe(rep.incomeByKind.find((x: { kind: string }) => x.kind === k).amountCents);
    }
    expect(got.total).toBe(rep.totals.collectedCents);
    for (const m of rep.monthly as { month: string; collectedCents: number }[]) {
      const range = monthRange(m.month, TZ);
      const w = { start: range.start < windowOf(s.from, s.to).start ? windowOf(s.from, s.to).start : range.start, end: range.end > windowOf(s.from, s.to).end ? windowOf(s.from, s.to).end : range.end };
      expect(core.collectedByKind({ payments: r.payments, invoiceKind: kindOf(), ledger: r.ledger, amenityOrders: r.orders }, w).total, m.month).toBe(m.collectedCents);
    }
    const month = monthRange(today().slice(0, 7), TZ);
    expect(core.collectedByKind({ payments: r.payments, invoiceKind: kindOf(), ledger: r.ledger, amenityOrders: r.orders }, { start: month.start, end: month.end }).total).toBe(dash.collectedThisMonthCents);
  });

  it('payments by method', async () => {
    expect(core.paymentsByMethod(r.payments, windowOf(s.from, s.to))).toEqual(rep.paymentsByMethod);
  });

  it('outstanding and overdue: the Today page, the invoice list and the aging total', async () => {
    expect(core.outstandingCents(r.invoices)).toBe(dash.outstandingCents);
    expect(core.overdueCents(r.invoices, today())).toBe(dash.overdueCents);
    expect(core.overdueCents(r.invoices, today())).toBeGreaterThan(0); // the scenario has an overdue invoice
    const list = (await s.owner.get(`/api/invoices?locationId=${s.locationId}`).expect(200)).body as { status: string; balanceCents: number }[];
    expect(core.outstandingCents(r.invoices)).toBe(sum(list.filter((i) => i.status === 'open').map((i) => i.balanceCents)));
  });

  it('aging: the finance report buckets', async () => {
    expect(core.agingNow(r.invoices, today())).toEqual(rep.receivablesAging);
  });

  it('deposits held: the finance report', async () => {
    expect(core.depositsHeldCents(r.ledger, new Date().toISOString())).toBe(rep.deposits.heldCents);
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

  it('tax: every invoice’s stored tax is the tax of its subtotal at the location rate', async () => {
    for (const i of r.invoices) expect(i.taxCents, i.number).toBe(core.invoiceTaxCents(i.subtotalCents, 1_000));
  });

  it('advances not yet applied (no endpoint shows this today)', async () => {
    // The plan member's 2,000 advance was used in full; the company's 10,000 advance was never applied (H1).
    expect(core.advancesUnappliedCents({ members: r.members, contracts: r.contracts })).toBe(1_000_000);
  });
});

describe('where today’s definitions differ from the correct ones', () => {
  it('D1 outstanding: a payment dated in the future already counts today; as of today it does not', async () => {
    const c2 = await setup();
    const owner = await ownerOf(c2);
    const inv = await manualInvoice(owner, c2.basic.member.id, 10_000); // 11,000
    await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 4_000, method: 'cash', paidAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }).expect(201);
    const rows2 = await rowsOf(c2, c2.loc.id);
    const d = (await owner.get(`/api/reports/dashboard?locationId=${c2.loc.id}`).expect(200)).body.finance;
    expect(d.outstandingCents).toBe(core.outstandingCents(rows2.invoices));
    expect(core.outstandingCents(rows2.invoices)).toBe(7_000);
    expect(core.outstandingAsOf(rows2.invoices, rows2.payments, today(), TZ)).toBe(11_000);
  });

  it('D2 aging (R4a): a report that ends last month still ages today’s invoices', async () => {
    const end = addDays(`${s.to.slice(0, 7)}-01`, -1);
    const past = await financeReport(s.owner, s.locationId, s.from, end);
    expect(past.receivablesAging).toEqual(core.agingNow(r.invoices, today()));
    expect(past.receivablesAging).not.toEqual(core.agingAsOf(r.invoices, r.payments, end, TZ));
  });

  it('D3 deposits held (R4b): a report that ends last month counts deposits received since', async () => {
    const end = addDays(`${s.to.slice(0, 7)}-01`, -1);
    const past = await financeReport(s.owner, s.locationId, s.from, end);
    expect(past.deposits.heldCents).toBe(core.depositsHeldCents(r.ledger, new Date().toISOString()));
    expect(past.deposits.heldCents).not.toBe(core.depositsHeldAsOf(r.ledger, end, TZ));
  });

  it('D4 invoiced (R1): leaves out the part of a bill an advance paid, while collected counts the advance in full', async () => {
    const days = { from: s.from, to: s.to };
    expect(core.billedCents(r.invoices, r.lines, days) - core.invoicedCents(r.invoices, days)).toBe(200_000);
    expect(rep.totals.invoicedCents).toBe(core.invoicedCents(r.invoices, days));
  });

  it('D5 tax (R2): money collected and profit-and-loss income include the tax on invoices', async () => {
    expect(core.taxInvoicedCents(r.invoices, { from: s.from, to: s.to })).toBeGreaterThan(0);
    expect(sum(rep.profitLoss.income.map((x: { totalCents: number }) => x.totalCents))).toBe(rep.totals.collectedCents);
    expect(rep.totals.taxCollectedCents).toBeUndefined();
  });

  it('D6 payments by method (L3): only invoice payments have a method, so it does not add up to collected', async () => {
    const got = core.collectedByKind({ payments: r.payments, invoiceKind: kindOf(), ledger: r.ledger, amenityOrders: r.orders }, windowOf(s.from, s.to));
    expect(sum(rep.paymentsByMethod.map((m: { amountCents: number }) => m.amountCents))).toBe(got.subscription + got.manual);
    expect(got.total - got.subscription - got.manual).toBe(got.advance + got.kept_deposit + got.amenities);
    expect(got.advance + got.kept_deposit + got.amenities).toBeGreaterThan(0);
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
    expect([detail.balanceDueCents, detail.amenityOwedCents]).toEqual([11_000, 400]);
    const d = (await owner.get(`/api/reports/dashboard?locationId=${c2.loc.id}`).expect(200)).body.finance;
    expect(d.outstandingCents).toBe(11_000); // the Today page leaves the 400 out too
  });

  it('D8 advances not yet applied: the company advance is income but sits unapplied, and nothing reports it', async () => {
    expect(core.advancesUnappliedCents({ members: r.members, contracts: r.contracts })).toBe(1_000_000);
    expect(JSON.stringify(rep)).not.toContain('unapplied');
  });
});
