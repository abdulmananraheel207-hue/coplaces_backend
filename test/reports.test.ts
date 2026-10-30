import { describe, expect, it } from 'vitest';
import { bookings } from '../src/db/schema.js';
import { addDays, todayIn, zonedToUtc } from '../src/lib/time.js';
import { login, setupOpen as setup, TZ, tomorrow, entitle } from './helpers.js';

describe('dashboard and finance reports', () => {
  it('summarises operations for the front desk without finance figures', async () => {
    const ctx = await setup();
    const { app, db, loc, room, desk, basic, pro } = ctx;
    const staff = await login(app, 'desk@test.dev');
    await entitle(ctx, basic.member.id);
    await staff.post('/api/attendance/check-in').send({ memberId: basic.member.id }).expect(201);
    await staff.post('/api/visitors').send({ name: 'V', hostMemberId: pro.member.id, expectedDate: todayIn(TZ), expectedTime: '23:00' }).expect(201);
    // A desk booked for today. It is inserted directly because the booking rules (rightly) refuse a day that
    // has already ended, and this test must not depend on what time it is when it runs.
    const today = todayIn(TZ);
    await db.insert(bookings)
      .values({ locationId: loc.id, resourceId: desk.id, memberId: pro.member.id, startsAt: zonedToUtc(today, '08:00', TZ).toISOString(), endsAt: zonedToUtc(today, '20:00', TZ).toISOString(), createdById: pro.user.id })
      .run();
    await staff
      .post('/api/bookings')
      .send({ resourceId: room.id, memberId: pro.member.id, date: tomorrow(), startTime: '10:00', endTime: '11:00' })
      .expect(201);

    const d = (await staff.get(`/api/reports/dashboard?locationId=${loc.id}`).expect(200)).body;
    expect(d.finance).toBeNull();
    expect(d.ops.activeMembers).toBe(2);
    expect(d.ops.checkedInNow).toBe(1);
    expect(d.ops.visitorsExpectedToday).toBe(1);
    expect(d.ops.hotDesks).toEqual({ total: 2, bookedToday: 1 });
    expect(d.ops.dedicatedDesks.total).toBe(1);
    expect(d.ops.bookingsToday).toBe(2); // the desk booking, and the shift booking that lets the checked-in member be here
  });

  it('computes revenue, expenses, net and receivables aging for managers', async () => {
    const { app, loc, basic } = await setup();
    const manager = await login(app, 'manager@test.dev');
    const today = todayIn(TZ);

    const mk = async (dueOffset: number, amount: number) =>
      (
        await manager
          .post('/api/invoices')
          .send({
            memberId: basic.member.id,
            issueDate: addDays(today, -90),
            dueDate: addDays(today, dueOffset),
            items: [{ description: 'Fee', quantity: 1, unitPriceCents: amount }],
          })
          .expect(201)
      ).body;

    const current = await mk(5, 1_000); // total 1100, not yet due
    const late15 = await mk(-15, 2_000); // 2200
    const late45 = await mk(-45, 3_000); // 3300
    const late70 = await mk(-70, 4_000); // 4400
    const paid = await mk(-1, 10_000); // 11000, paid in full below
    await manager.post(`/api/invoices/${paid.id}/payments`).send({ amountCents: paid.totalCents, method: 'card' }).expect(201);
    await manager.post(`/api/invoices/${late15.id}/payments`).send({ amountCents: 200, method: 'cash' }).expect(201);

    await manager
      .post('/api/expenses')
      .send({ locationId: loc.id, category: 'rent', amountCents: 5_000, incurredOn: today, vendor: 'Landlord' })
      .expect(201);
    await manager.post('/api/expenses').send({ locationId: loc.id, category: 'cleaning', amountCents: 1_500 }).expect(201);

    const f = (await manager.get(`/api/reports/finance?locationId=${loc.id}`).expect(200)).body;
    expect(f.totals.collectedCents).toBe(11_000 + 200);
    expect(f.totals.expensesCents).toBe(6_500);
    expect(f.totals.netCents).toBe(11_200 - 6_500);
    expect(f.totals.invoicedCents).toBe(1_100 + 2_200 + 3_300 + 4_400 + 11_000);
    expect(f.expensesByCategory[0]).toEqual({ category: 'rent', amountCents: 5_000 });
    expect(f.paymentsByMethod).toEqual([
      { method: 'card', amountCents: 11_000 },
      { method: 'cash', amountCents: 200 },
    ]);
    expect(f.receivablesAging.current).toEqual({ count: 1, amountCents: current.totalCents });
    expect(f.receivablesAging.days1to30).toEqual({ count: 1, amountCents: 2_000 });
    expect(f.receivablesAging.days31to60).toEqual({ count: 1, amountCents: late45.totalCents });
    expect(f.receivablesAging.days61plus).toEqual({ count: 1, amountCents: late70.totalCents });

    const thisMonth = f.monthly.at(-1);
    expect(thisMonth.month).toBe(today.slice(0, 7));
    expect(f.monthly).toHaveLength(6);
    expect(thisMonth.collectedCents).toBe(11_200);
    expect(thisMonth.expensesCents).toBe(6_500);

    // Profit and loss: every row adds up to the totals, and the periods line up.
    expect(f.profitLoss.months).toHaveLength(6);
    expect(f.profitLoss.income.reduce((n: number, r: { totalCents: number }) => n + r.totalCents, 0)).toBe(f.totals.collectedCents);
    expect(f.profitLoss.costs.reduce((n: number, r: { totalCents: number }) => n + r.totalCents, 0)).toBe(f.totals.expensesCents);
    expect(f.incomeByKind.reduce((n: number, r: { amountCents: number }) => n + r.amountCents, 0)).toBe(f.totals.collectedCents);
    expect(f.previous.to < f.from).toBe(true);

    const dash = (await manager.get(`/api/reports/dashboard?locationId=${loc.id}`).expect(200)).body;
    expect(dash.finance.collectedThisMonthCents).toBe(11_200);
    expect(dash.finance.expensesThisMonthCents).toBe(6_500);
    expect(dash.finance.mrrCents).toBe(20_000 + 5_000);
    expect(dash.finance.outstandingCents).toBe(1_100 + 2_000 + 3_300 + 4_400);
    expect(dash.finance.overdueCents).toBe(2_000 + 3_300 + 4_400);
    expect(dash.finance.overdueCount).toBe(3);
  });

  it('rejects bad report ranges and validates expenses', async () => {
    const { app, loc } = await setup();
    const manager = await login(app, 'manager@test.dev');
    await manager.get(`/api/reports/finance?locationId=${loc.id}&from=2026-05-02&to=2026-05-01`).expect(400);
    await manager.get(`/api/reports/finance?locationId=${loc.id}&from=garbage`).expect(400);
    await manager.post('/api/expenses').send({ locationId: loc.id, category: 'rent', amountCents: -5 }).expect(400);
    await manager.post('/api/expenses').send({ locationId: loc.id, category: 'pizza', amountCents: 500 }).expect(400);
  });
});
