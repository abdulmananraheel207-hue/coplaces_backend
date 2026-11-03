import { and, eq, isNotNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { amenityOrders, bookings, depositEntries, expenses, invoiceItems, invoices, locations, members, payments, resources } from '../src/db/schema.js';
import { addDays, addMonths, todayIn } from '../src/lib/time.js';
import { inDays, login, setup, TZ } from './helpers.js';
import { taxInside } from './helpers/finance.js';

type Ctx = Awaited<ReturnType<typeof setup>>;
type Agent = Awaited<ReturnType<typeof login>>;

const today = todayIn(TZ);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * Reads the books straight from the database tables, with none of the application's own money code, and checks that every figure the
 * application shows agrees: the invoices, the finance report, the profit and loss, the Today page, a member's balance.
 */
async function checkBooks(ctx: Ctx, owner: Agent, step: string) {
  const L = ctx.loc.id;
  const loc = (await ctx.db.select().from(locations).where(eq(locations.id, L)).get())!;
  const pays = await ctx.db.select().from(payments).where(eq(payments.locationId, L)).all();
  const moves = await ctx.db.select().from(depositEntries).where(eq(depositEntries.locationId, L)).all();
  const kind = (k: string) => sum(moves.filter((m) => m.kind === k).map((m) => m.amountCents));
  const desk = await ctx.db.select().from(amenityOrders).where(and(eq(amenityOrders.locationId, L), isNotNull(amenityOrders.collectedAt))).all();
  const deskIncome = sum(desk.map((o) => o.chargeCents));
  const invs = await ctx.db.select().from(invoices).where(eq(invoices.locationId, L)).all();
  const live = invs.filter((i) => i.status !== 'void');
  const spend = sum((await ctx.db.select().from(expenses).where(eq(expenses.locationId, L)).all()).map((e) => e.amountCents));
  const owedAtDesk = sum((await ctx.db.select().from(amenityOrders).where(eq(amenityOrders.locationId, L)).all()).filter((o) => !o.collectedAt && !o.invoiceId).map((o) => o.chargeCents));

  // ---- every invoice adds up from its own lines, its tax and its payments
  for (const i of invs) {
    const lines = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, i.id)).all();
    expect(sum(lines.map((l) => l.amountCents)), `${step}: ${i.number} subtotal`).toBe(i.subtotalCents);
    expect(lines.every((l) => l.amountCents === l.quantity * l.unitPriceCents), `${step}: ${i.number} lines multiply`).toBe(true);
    expect(i.taxCents, `${step}: ${i.number} tax`).toBe(Math.round((i.subtotalCents * loc.taxRateBps) / 10_000));
    expect(i.totalCents, `${step}: ${i.number} total`).toBe(i.subtotalCents + i.taxCents);
    const paid = sum(pays.filter((p) => p.invoiceId === i.id).map((p) => p.amountCents));
    expect(i.paidCents, `${step}: ${i.number} paid`).toBe(paid);
    expect(paid <= i.totalCents, `${step}: ${i.number} not overpaid`).toBe(true);
    const should = i.status === 'void' ? 'void' : i.paidCents >= i.totalCents ? 'paid' : 'open';
    expect(i.status, `${step}: ${i.number} status`).toBe(should);
    if (i.status === 'void') expect(paid, `${step}: a void invoice has no payments`).toBe(0);
  }

  // ---- the finance report
  const rep = (await owner.get(`/api/reports/finance?locationId=${L}&from=${today.slice(0, 7)}-01&to=${today}`).expect(200)).body;
  const moneyIn = sum(pays.map((p) => p.amountCents)) + kind('kept') + kind('advance') + deskIncome;
  // Invoiced is what was billed: the part an advance paid is added back, as the advance itself is money in when it arrives.
  const allLines = (await Promise.all(live.map((i) => ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, i.id)).all()))).flat();
  const billed = sum(live.map((i) => i.totalCents)) - sum(allLines.filter((l) => l.category === 'advance').map((l) => l.amountCents));
  // Income is money in less the tax inside the payments, worked out here on its own.
  const tax = taxInside(invs, pays);
  expect(rep.totals.collectedCents, `${step}: money in`).toBe(moneyIn);
  expect(rep.totals.taxCollectedCents, `${step}: tax collected`).toBe(tax);
  expect(rep.totals.invoicedCents, `${step}: invoiced`).toBe(billed);
  expect(rep.totals.expensesCents, `${step}: money out`).toBe(spend);
  expect(rep.totals.netCents, `${step}: profit`).toBe(moneyIn - spend);
  expect(sum(rep.incomeByKind.map((k: { amountCents: number }) => k.amountCents)), `${step}: income by kind`).toBe(moneyIn - tax);
  expect(sum(rep.monthly.map((m: { collectedCents: number }) => m.collectedCents)), `${step}: monthly money in`).toBe(moneyIn);
  expect(sum(rep.profitLoss.income.map((k: { totalCents: number }) => k.totalCents)), `${step}: profit and loss income`).toBe(moneyIn - tax);
  expect(rep.profitLoss.tax.totalCents, `${step}: profit and loss tax`).toBe(tax);
  expect(sum(rep.profitLoss.costs.map((k: { totalCents: number }) => k.totalCents)), `${step}: profit and loss costs`).toBe(spend);
  expect(sum(rep.paymentsByMethod.map((m: { amountCents: number }) => m.amountCents)), `${step}: money in by method`).toBe(moneyIn);
  expect(rep.deposits.heldCents, `${step}: deposits held`).toBe(kind('received') - kind('refunded') - kind('kept'));
  expect(rep.deposits.keptCents, `${step}: deposits kept`).toBe(kind('kept'));
  expect(rep.deposits.advanceCents, `${step}: advances`).toBe(kind('advance'));
  expect(rep.amenities.owedCents, `${step}: amenities to collect`).toBe(owedAtDesk);
  expect(rep.amenities.collectedCents, `${step}: amenities collected`).toBe(rep.incomeByCategory.find((c: { category: string }) => c.category === 'amenity')?.amountCents ?? 0);

  const openBalance = sum(live.filter((i) => i.status === 'open').map((i) => i.totalCents - i.paidCents));
  expect(sum(Object.values(rep.receivablesAging).map((b) => (b as { amountCents: number }).amountCents)), `${step}: still owed`).toBe(openBalance);

  // ---- the Today page agrees with the report
  const dash = (await owner.get(`/api/reports/dashboard?locationId=${L}`).expect(200)).body.finance;
  expect(dash.outstandingCents, `${step}: Today outstanding`).toBe(openBalance);
  expect(dash.collectedThisMonthCents, `${step}: Today money in`).toBe(moneyIn);
  expect(dash.invoicedThisMonthCents, `${step}: Today invoiced`).toBe(billed);
  expect(dash.taxCollectedThisMonthCents, `${step}: Today tax`).toBe(tax);
  expect(dash.expensesThisMonthCents, `${step}: Today money out`).toBe(spend);

  // ---- the invoice list and each member's balance
  const list = (await owner.get(`/api/invoices?locationId=${L}`).expect(200)).body as { status: string; balanceCents: number; totalCents: number; paidCents: number }[];
  expect(sum(list.filter((i) => i.status === 'open').map((i) => i.balanceCents)), `${step}: invoice list balances`).toBe(openBalance);
  expect(list.filter((i) => i.status === 'void').every((i) => i.balanceCents === 0), `${step}: void invoices owe nothing`).toBe(true);
  for (const m of await ctx.db.select().from(members).where(eq(members.locationId, L)).all()) {
    const owes = sum(live.filter((i) => i.memberId === m.id && i.status === 'open').map((i) => i.totalCents - i.paidCents));
    const detail = (await owner.get(`/api/members/${m.id}`).expect(200)).body;
    expect(detail.balanceDueCents, `${step}: balance of ${m.id}`).toBe(owes);
    // an advance, and a credit, are used exactly as much as the member's own invoices that stand have taken off
    const lines = (await Promise.all(live.filter((i) => i.memberId === m.id && !i.contractId).map((i) => ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, i.id)).all()))).flat();
    const taken = (category: string) => sum(lines.filter((l) => l.amountCents < 0 && l.category === category).map((l) => -l.amountCents));
    expect(m.advanceUsedCents, `${step}: advance used by ${m.id}`).toBe(taken('advance'));
    expect(m.creditUsedCents, `${step}: credit used by ${m.id}`).toBe(taken('credit'));
    expect(m.advanceUsedCents <= m.advanceCents, `${step}: advance not overused`).toBe(true);
    expect(m.creditUsedCents <= m.creditCents, `${step}: credit not overused`).toBe(true);
  }
}

describe('the finances, from the first invoice to the last expense', () => {
  it('stay in agreement with the books through every kind of money movement', async () => {
    const ctx = await setup(); // the location charges 10% tax
    const owner = await login(ctx.app, 'owner@test.dev');
    const L = ctx.loc.id;
    await checkBooks(ctx, owner, 'start');

    // 1. A member on a plan with shifts, who pays an advance and a deposit when joining: 5,000.00 of shifts, 1,000.00 advance.
    const plan = (await owner.post('/api/plans').send({ locationId: L, name: 'Desk plan', interval: 'month' }).expect(201)).body;
    const shift = (await owner.post('/api/shifts').send({ locationId: L, planId: plan.id, name: 'Day', startTime: '09:00', endTime: '12:00', priceCents: 500_000, spaceIds: [ctx.desk.id] }).expect(201)).body;
    const alia = (await owner.post('/api/members').send({ locationId: L, name: 'Alia', email: 'alia@x.dev', planId: plan.id, status: 'active', startDate: today, shiftIds: [shift.id], deskIds: [ctx.desk.id], advanceCents: 100_000, depositCents: 200_000, method: 'cash' }).expect(201)).body;
    const aliaInvoice = (await ctx.db.select().from(invoices).where(eq(invoices.memberId, alia.id)).all())[0]!;
    expect([aliaInvoice.subtotalCents, aliaInvoice.taxCents, aliaInvoice.totalCents]).toEqual([400_000, 40_000, 440_000]); // 5,000 less the 1,000 advance, plus 10%
    await checkBooks(ctx, owner, 'member joins with advance and deposit');

    // 2. Part payments, a payment that is too big, and a payment taken back.
    const first = (await owner.post(`/api/invoices/${aliaInvoice.id}/payments`).send({ amountCents: 200_000, method: 'cash' }).expect(201)).body;
    await checkBooks(ctx, owner, 'part paid');
    await owner.post(`/api/invoices/${aliaInvoice.id}/payments`).send({ amountCents: 240_001, method: 'card' }).expect(400); // more than is owed
    await owner.post(`/api/invoices/${aliaInvoice.id}/payments`).send({ amountCents: 240_000, method: 'bank_transfer', reference: 'TRX-1' }).expect(201);
    await owner.post(`/api/invoices/${aliaInvoice.id}/payments`).send({ amountCents: 1, method: 'cash' }).expect(409); // already paid
    await checkBooks(ctx, owner, 'paid in full');
    await owner.delete(`/api/payments/${first.payment.id}`).expect(200);
    await checkBooks(ctx, owner, 'a payment taken back');
    await owner.post(`/api/invoices/${aliaInvoice.id}/payments`).send({ amountCents: 200_000, method: 'bank_transfer' }).expect(201);
    await checkBooks(ctx, owner, 'paid again');

    // 3. A hand-made invoice with several lines, and one that is voided.
    const manual = (await owner.post('/api/invoices').send({ memberId: ctx.pro.member.id, items: [{ description: 'Printing', quantity: 3, unitPriceCents: 1_250 }, { description: 'Key card', quantity: 1, unitPriceCents: 5_000 }] }).expect(201)).body;
    expect([manual.subtotalCents, manual.taxCents, manual.totalCents]).toEqual([8_750, 875, 9_625]);
    await checkBooks(ctx, owner, 'manual invoice');
    await owner.post(`/api/invoices/${manual.id}/void`).expect(200);
    await checkBooks(ctx, owner, 'manual invoice voided');
    const other = (await owner.post('/api/invoices').send({ memberId: ctx.basic.member.id, items: [{ description: 'Locker', quantity: 1, unitPriceCents: 2_000 }] }).expect(201)).body;
    await owner.post(`/api/invoices/${other.id}/payments`).send({ amountCents: 500, method: 'cash' }).expect(201);
    await owner.post(`/api/invoices/${other.id}/void`).expect(409); // it has a payment, which has to be taken off first
    await checkBooks(ctx, owner, 'part paid manual invoice');

    // 4. An hourly booking that has happened is billed on the monthly invoices, and the plan members are not billed twice.
    const priced = (await owner.get(`/api/resources?locationId=${L}`).expect(200)).body.find((r: { id: string }) => r.id === ctx.room.id);
    expect(priced.hourlyRateCents).toBe(6_000);
    const now = Date.now();
    await ctx.db.insert(bookings).values({ locationId: L, resourceId: ctx.room.id, memberId: ctx.basic.member.id, startsAt: new Date(now - 3 * 3_600_000).toISOString(), endsAt: new Date(now - 1 * 3_600_000).toISOString(), status: 'completed', billableMinutes: 120, priceCents: 12_000, createdById: ctx.basic.user.id }).run();
    await owner.post('/api/invoices/generate').send({ locationId: L, month: today.slice(0, 7) }).expect(201);
    await checkBooks(ctx, owner, 'monthly invoices generated');
    expect((await ctx.db.select().from(invoices).where(eq(invoices.memberId, alia.id)).all()).filter((i) => i.status !== 'void')).toHaveLength(1); // not billed a second time
    const basicInvoice = (await ctx.db.select().from(invoices).where(eq(invoices.memberId, ctx.basic.member.id)).all()).find((i) => i.kind === 'subscription')!;
    expect(basicInvoice.subtotalCents).toBe(5_000 + 12_000); // the plan and the room
    await owner.post(`/api/invoices/${basicInvoice.id}/payments`).send({ amountCents: 10_000, method: 'card' }).expect(201);
    await owner.post('/api/invoices/generate').send({ locationId: L, month: today.slice(0, 7) }).expect(201); // again: nothing new
    await checkBooks(ctx, owner, 'generated twice');

    // 5. Amenities beyond the free amount: one invoiced, one collected at the desk.
    const tea = (await owner.post('/api/amenities').send({ locationId: L, name: 'Tea', priceCents: 200 }).expect(201)).body;
    await owner.patch(`/api/members/${ctx.pro.member.id}`).send({ amenities: [{ amenityId: tea.id, freePerDay: 1 }] }).expect(200);
    const desk = await login(ctx.app, 'desk@test.dev');
    await desk.post('/api/amenities/orders').send({ memberId: ctx.pro.member.id, amenityId: tea.id, quantity: 4 }).expect(201); // 3 paid
    await desk.post('/api/amenities/orders').send({ memberId: ctx.basic.member.id, amenityId: tea.id, quantity: 2 }).expect(201); // 2 paid
    await checkBooks(ctx, owner, 'amenities owed');
    const teaInvoice = (await owner.post('/api/amenities/invoice').send({ memberId: ctx.pro.member.id }).expect(201)).body;
    expect([teaInvoice.subtotalCents, teaInvoice.taxCents]).toEqual([600, 60]);
    await checkBooks(ctx, owner, 'amenities invoiced');
    await desk.post('/api/amenities/collect').send({ memberId: ctx.basic.member.id }).expect(200);
    await owner.post(`/api/invoices/${teaInvoice.id}/payments`).send({ amountCents: 660, method: 'cash' }).expect(201);
    await checkBooks(ctx, owner, 'amenities paid');
    await owner.post(`/api/invoices/${teaInvoice.id}/void`).expect(409);

    // 6. Alia leaves: her deposit is settled, some returned and the rest kept as income.
    await owner.patch(`/api/members/${alia.id}`).send({ status: 'cancelled' }).expect(200);
    await owner.post(`/api/members/${alia.id}/deposit`).send({ action: 'refund', returnedCents: 150_000, method: 'bank_transfer' }).expect(200);
    await checkBooks(ctx, owner, 'deposit settled');

    // 7. A contract with an advance and a deposit, and a company contract invoiced with the rest.
    const contract = (await owner.post('/api/contracts').send({ locationId: L, memberId: ctx.basic.member.id, resourceId: ctx.dedicated.id, startDate: today, depositCents: 100_000, advanceCents: 50_000 }).expect(201)).body;
    await owner.post(`/api/contracts/${contract.id}/advance`).send({ method: 'cash' }).expect(200);
    await owner.post(`/api/contracts/${contract.id}/deposit`).send({ action: 'receive', method: 'cash' }).expect(200);
    await checkBooks(ctx, owner, 'contract money received');
    await owner.post(`/api/contracts/${contract.id}/activate`).expect(200);
    await owner.post(`/api/contracts/${contract.id}/end`).send({}).expect(200);
    await owner.post(`/api/contracts/${contract.id}/deposit`).send({ action: 'refund', returnedCents: 70_000 }).expect(200);
    await checkBooks(ctx, owner, 'contract settled');
    const acmeOffice = await ctx.db.insert(resources).values({ locationId: L, kind: 'office', name: 'Acme Office', capacity: 5 }).returning().get();
    const company = await owner.post('/api/contracts/company').send({
      locationId: L, companyName: 'Acme Ltd', companyEmail: 'hello@acme.dev', companyPhone: '021', startDate: today, endDate: inDays(90), pricingMode: 'per_member',
      pricePerMemberCents: 1_000_000, extraMemberCents: 500_000, fixedPriceCents: 0, spaceIds: [acmeOffice.id],
      people: ['A', 'B'].map((n) => ({ name: `Emp ${n}`, email: `${n.toLowerCase()}@acme.dev`, phone: '0300', password: 'password123', deskResourceId: null })),
    }).expect(201);
    const act = await owner.post(`/api/contracts/${company.body.id}/activate`);
    expect(act.status, JSON.stringify(act.body)).toBe(200);
    await owner.post('/api/invoices/generate').send({ locationId: L, month: today.slice(0, 7) }).expect(201);
    await checkBooks(ctx, owner, 'company contract invoiced');
    const acme = (await ctx.db.select().from(invoices).all()).find((i) => i.memberId === company.body.memberId && i.status !== 'void');
    expect(acme, 'the company is billed').toBeTruthy();

    // 8. Spending.
    await owner.post('/api/expenses').send({ locationId: L, category: 'rent', amountCents: 70_000, incurredOn: today }).expect(201);
    const cleaning = (await owner.post('/api/expenses').send({ locationId: L, category: 'cleaning', amountCents: 12_345, incurredOn: today }).expect(201)).body;
    await checkBooks(ctx, owner, 'expenses');
    await owner.delete(`/api/expenses/${cleaning.id}`).expect(204);
    await checkBooks(ctx, owner, 'an expense removed');

    // 9. What a member sees agrees with what the owner sees.
    const mine = await login(ctx.app, 'basic@test.dev');
    const summary = (await mine.get('/api/me/summary').expect(200)).body;
    const theirs = (await ctx.db.select().from(invoices).where(eq(invoices.memberId, ctx.basic.member.id)).all()).filter((i) => i.status === 'open');
    expect(summary.balanceDueCents).toBe(sum(theirs.map((i) => i.totalCents - i.paidCents)));
    expect(summary.openInvoices.map((i: { id: string }) => i.id).sort()).toEqual(theirs.map((i) => i.id).sort());
  }, 60_000); // a long scenario that checks the whole books after every step
});

describe('advances, plan changes and voids', () => {
  async function shiftMember(ctx: Ctx, owner: Agent, extra: Record<string, unknown> = {}) {
    const L = ctx.loc.id;
    const plan = (await owner.post('/api/plans').send({ locationId: L, name: 'Desk plan', interval: 'month' }).expect(201)).body;
    const desks = [ctx.desk, ctx.desk2];
    const day = (await owner.post('/api/shifts').send({ locationId: L, planId: plan.id, name: 'Day', startTime: '09:00', endTime: '12:00', priceCents: 500_000, spaceIds: desks.map((d) => d.id) }).expect(201)).body;
    const eve = (await owner.post('/api/shifts').send({ locationId: L, planId: plan.id, name: 'Evening', startTime: '16:00', endTime: '19:00', priceCents: 300_000, spaceIds: desks.map((d) => d.id) }).expect(201)).body;
    const m = (await owner.post('/api/members').send({ locationId: L, name: 'Zara', email: 'zara@x.dev', planId: plan.id, status: 'active', startDate: today, shiftIds: [day.id], deskIds: [ctx.desk.id], ...extra }).expect(201)).body;
    return { plan, day, eve, m };
  }

  it('uses an advance that is bigger than the bill across the next bill, and gives it back when an invoice is voided', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const { m, day, eve } = await shiftMember(ctx, owner, { advanceCents: 700_000, method: 'cash' });
    const first = (await ctx.db.select().from(invoices).where(eq(invoices.memberId, m.id)).all())[0]!;
    expect(first.totalCents).toBe(0); // 5,000 of shifts, less a 7,000 advance
    expect(first.status).toBe('paid');
    expect((await ctx.db.select().from(members).where(eq(members.id, m.id)).get())!.advanceUsedCents).toBe(500_000);
    await checkBooks(ctx, owner, 'advance bigger than the bill');

    // She adds the evening shift: the rest of the advance (2,000) is taken off its 3,000.
    await owner.put(`/api/members/${m.id}/plan`).send({ planId: (await ctx.db.select().from(members).where(eq(members.id, m.id)).get())!.planId, shiftIds: [day.id, eve.id], deskIds: [ctx.desk.id] }).expect(200);
    const live = (await ctx.db.select().from(invoices).where(eq(invoices.memberId, m.id)).all()).filter((i) => i.status !== 'void');
    const extra = live.find((i) => i.totalCents > 0)!;
    expect([extra.subtotalCents, extra.totalCents]).toEqual([100_000, 110_000]);
    expect((await ctx.db.select().from(members).where(eq(members.id, m.id)).get())!.advanceUsedCents).toBe(700_000);
    await checkBooks(ctx, owner, 'plan changed');

    // Voiding the invoice that used the advance gives that part of the advance back.
    await owner.post(`/api/invoices/${extra.id}/void`).expect(200);
    expect((await ctx.db.select().from(members).where(eq(members.id, m.id)).get())!.advanceUsedCents).toBe(500_000);
    await checkBooks(ctx, owner, 'invoice voided');
  });

  it('takes an advance that is received after the invoice off that invoice, once', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const { m } = await shiftMember(ctx, owner);
    await checkBooks(ctx, owner, 'invoice before any advance');
    await owner.post(`/api/members/${m.id}/money`).send({ advanceCents: 150_000, method: 'cash' }).expect(204);
    const inv = (await ctx.db.select().from(invoices).where(eq(invoices.memberId, m.id)).all())[0]!;
    expect([inv.subtotalCents, inv.totalCents]).toEqual([350_000, 385_000]);
    await checkBooks(ctx, owner, 'advance received later');
    await owner.post(`/api/members/${m.id}/money`).send({ advanceCents: 10_000, method: 'cash' }).expect(409); // only once
    await checkBooks(ctx, owner, 'second advance refused');
  });

  it('keeps the money right when odd amounts are taxed, and when a paid invoice has a payment taken off', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    // 3 x 3.33 = 9.99 at 10% is 0.999, which rounds to 1.00
    const odd = (await owner.post('/api/invoices').send({ memberId: ctx.pro.member.id, items: [{ description: 'Odd', quantity: 3, unitPriceCents: 333 }] }).expect(201)).body;
    expect([odd.subtotalCents, odd.taxCents, odd.totalCents]).toEqual([999, 100, 1_099]);
    const paid = (await owner.post(`/api/invoices/${odd.id}/payments`).send({ amountCents: 1_099, method: 'cash' }).expect(201)).body;
    expect(paid.invoice.status).toBe('paid');
    await checkBooks(ctx, owner, 'odd amounts');
    await owner.delete(`/api/payments/${paid.payment.id}`).expect(200);
    expect((await ctx.db.select().from(invoices).where(eq(invoices.id, odd.id)).get())!.status).toBe('open');
    await checkBooks(ctx, owner, 'payment taken off a paid invoice');
    // a free invoice is settled without a payment
    const free = (await owner.post('/api/invoices').send({ memberId: ctx.pro.member.id, items: [{ description: 'Gift', quantity: 1, unitPriceCents: 0 }] }).expect(201)).body;
    expect(free.status).toBe('paid');
    await checkBooks(ctx, owner, 'a free invoice');
  });
});

describe('finance over time', () => {
  it('puts each payment, invoice and expense in the month it happened, and compares with the period before', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const L = ctx.loc.id;
    const thisMonth = today.slice(0, 7);
    const lastMonth = addMonths(thisMonth, -1);
    const twoAgo = addMonths(thisMonth, -2);
    const dayBefore = addDays(`${thisMonth}-01`, -1); // the last day of last month
    const at = (date: string) => `${date}T12:00:00.000Z`;

    // (invoice date, amount of the one line, how much of it was paid and when)
    const plan: [string, number, number, string][] = [
      [`${twoAgo}-10`, 100_000, 110_000, `${twoAgo}-12`],
      [`${lastMonth}-05`, 200_000, 100_000, `${lastMonth}-06`],
      [dayBefore, 50_000, 55_000, dayBefore],
      [today, 80_000, 0, today],
    ];
    for (const [issued, line, paid, paidOn] of plan) {
      const inv = (await owner.post('/api/invoices').send({ memberId: ctx.pro.member.id, issueDate: issued, dueDate: issued, items: [{ description: 'Service', quantity: 1, unitPriceCents: line }] }).expect(201)).body;
      if (paid) await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: paid, method: 'cash', paidAt: at(paidOn) }).expect(201);
    }
    await owner.post('/api/expenses').send({ locationId: L, category: 'rent', amountCents: 30_000, incurredOn: `${lastMonth}-02` }).expect(201);
    await owner.post('/api/expenses').send({ locationId: L, category: 'rent', amountCents: 20_000, incurredOn: today }).expect(201);

    const wide = (await owner.get(`/api/reports/finance?locationId=${L}&from=${twoAgo}-01&to=${today}`).expect(200)).body;
    const row = (m: string) => wide.monthly.find((r: { month: string }) => r.month === m);
    // money in is by the day it was paid, invoiced by the day it was issued, and each is counted once
    expect([row(twoAgo).collectedCents, row(lastMonth).collectedCents + 0, row(thisMonth).collectedCents]).toEqual([110_000, 100_000 + 55_000, 0]);
    expect([row(twoAgo).invoicedCents, row(lastMonth).invoicedCents, row(thisMonth).invoicedCents]).toEqual([110_000, 220_000 + 55_000, 88_000]);
    expect([row(twoAgo).expensesCents, row(lastMonth).expensesCents, row(thisMonth).expensesCents]).toEqual([0, 30_000, 20_000]);
    expect(wide.totals).toMatchObject({ collectedCents: 265_000, invoicedCents: 110_000 + 275_000 + 88_000, expensesCents: 50_000, netCents: 215_000 });
    expect(wide.months ?? wide.monthly.map((r: { month: string }) => r.month)).toEqual([twoAgo, lastMonth, thisMonth]);
    expect(wide.profitLoss.months).toEqual([twoAgo, lastMonth, thisMonth]);
    // The profit and loss counts income before tax (10% here): the tax inside a part payment is its share of the invoice's tax.
    const sub = wide.profitLoss.income.find((k: { kind: string }) => k.kind === 'manual');
    expect(sub.byMonth).toEqual([100_000, Math.round(100_000 - (100_000 * 20_000) / 220_000) + 50_000, 0]);
    expect(wide.profitLoss.tax.byMonth).toEqual([10_000, Math.round((100_000 * 20_000) / 220_000) + 5_000, 0]);

    // This month only: the money in is this month's, and "the period before" is the same number of days just before it.
    const month = (await owner.get(`/api/reports/finance?locationId=${L}&from=${thisMonth}-01&to=${today}`).expect(200)).body;
    expect(month.totals).toMatchObject({ collectedCents: 0, invoicedCents: 88_000, expensesCents: 20_000 });
    const span = Number(today.slice(8));
    const beforeFrom = addDays(`${thisMonth}-01`, -span);
    const expectedBefore = [[`${twoAgo}-12`, 110_000], [`${lastMonth}-06`, 100_000], [dayBefore, 55_000]].filter(([d]) => (d as string) >= beforeFrom && (d as string) <= dayBefore).reduce((a, [, c]) => a + (c as number), 0);
    expect(month.previous.collectedCents).toBe(expectedBefore);
    expect(month.previous.from).toBe(beforeFrom);

    // what is still owed does not depend on the period chosen: 1,200.00 of last month's invoice and all of this month's 880.00
    const owedNow = Object.values(month.receivablesAging as Record<string, { amountCents: number }>).reduce((sum, bucket) => sum + bucket.amountCents, 0);
    expect(owedNow).toBe(120_000 + 88_000);
  });
});
