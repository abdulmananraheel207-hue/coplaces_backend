import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bookings, members } from '../src/db/schema.js';
import { addMonths, zonedToUtc } from '../src/lib/time.js';
import { login, setup, TZ } from './helpers.js';
import { generate, invoicesOf, monthFromNow, ownerOf, ownerUserId, sum, today } from './helpers/finance.js';

describe('finance charts', () => {
  it('shows income by space and by plan, the collection rate, invoices by status and who owes most', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const month = monthFromNow(-1);
    const by = await ownerUserId(ctx);
    await ctx.db.update(members).set({ startDate: `${month}-01` }).where(eq(members.id, ctx.basic.member.id)).run();
    // A room booking last month, billed on the monthly invoice and paid in full.
    await ctx.db
      .insert(bookings)
      .values({ locationId: ctx.loc.id, resourceId: ctx.room.id, memberId: ctx.basic.member.id, startsAt: zonedToUtc(`${month}-10`, '10:00', TZ).toISOString(), endsAt: zonedToUtc(`${month}-10`, '12:00', TZ).toISOString(), status: 'completed', billableMinutes: 120, priceCents: 12_000, createdById: by })
      .run();
    await generate(owner, ctx.loc.id, month);
    const bill = (await invoicesOf(ctx, ctx.basic.member.id))[0]!;
    await owner.post(`/api/invoices/${bill.id}/payments`).send({ amountCents: bill.totalCents, method: 'card' }).expect(201);

    const charts = (await owner.get(`/api/reports/finance/charts?locationId=${ctx.loc.id}&from=${month}-01&to=${today()}`).expect(200)).body;
    expect(charts.incomeBySpace).toEqual([{ resourceId: ctx.room.id, name: 'Boardroom', kind: 'room', amountCents: 12_000 }]);
    const row = charts.months.find((m: { month: string }) => m.month === today().slice(0, 7));
    expect(row.collectedCents).toBe(bill.totalCents);
    expect(row.moneyInByMethod).toEqual({ card: bill.totalCents });
    expect(row.incomeByCategory).toMatchObject({ booking: 12_000 });
    expect(row.taxCollectedCents).toBe(bill.taxCents);
    expect(charts.invoicesByStatus.paid).toMatchObject({ count: 1, totalCents: bill.totalCents, owedCents: 0 });
    // Invoices were issued this month, all paid this month: the rate is 1.
    expect(row.collectionRate).toBe(1);
    expect(charts.topDebtors).toEqual([]);
  });

  it('refuses a range of more than twenty years', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    await owner.get(`/api/reports/finance/charts?locationId=${ctx.loc.id}&from=${addMonths(today().slice(0, 7), -252)}-01&to=${today()}`).expect(400);
    await owner.get(`/api/reports/finance?locationId=${ctx.loc.id}&from=${addMonths(today().slice(0, 7), -252)}-01&to=${today()}`).expect(400);
    await owner.get(`/api/reports/finance?locationId=${ctx.loc.id}&from=${addMonths(today().slice(0, 7), -200)}-01&to=${today()}`).expect(200);
  });

  it('is closed without the reports permission or package feature', async () => {
    const ctx = await setup();
    const desk = await login(ctx.app, 'desk@test.dev');
    await desk.get(`/api/reports/finance/charts?locationId=${ctx.loc.id}`).expect(403);
    const hive = await login(ctx.app, 'owner@hive.dev');
    await hive.get(`/api/reports/finance/charts?locationId=${ctx.locB.id}`).expect(403);
  });
});

describe('platform revenue trend', () => {
  it('spreads each subscription payment over the months it pays for', async () => {
    const ctx = await setup();
    const root = await login(ctx.app, 'root@platform.dev');
    // Three months paid at once.
    await root.post(`/api/platform/organizations/${ctx.org.id}/payments`).send({ amountCents: 300, method: 'bank_transfer', periods: 3 }).expect(201);
    const trend = (await root.get('/api/platform/mrr-trend?months=6').expect(200)).body;
    expect(trend.months).toHaveLength(6);
    expect(sum(trend.months.map((m: { collectedCents: number }) => m.collectedCents))).toBe(300);
    expect(trend.months.at(-1).collectedCents).toBe(300);
    // The org's period runs 90 days ahead in the test data, so the paid months start in the future: what falls inside the window is earned.
    expect(sum(trend.months.map((m: { earnedCents: number }) => m.earnedCents))).toBeLessThanOrEqual(300);
    const owner = await login(ctx.app, 'owner@test.dev');
    await owner.get('/api/platform/mrr-trend').expect(403);
  });
});
