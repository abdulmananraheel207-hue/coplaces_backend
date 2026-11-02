import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { amenityOrders, attendance, bookings, invoiceItems, invoices, resources } from '../src/db/schema.js';
import { addDays, localDate, localTime, zonedToUtc } from '../src/lib/time.js';
import { checkInMember, closeStaleVisits, overstayers } from '../src/services/checkin.js';
import { inDays, login, setup, TZ } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof setup>>;
const at = (date: string, time: string) => zonedToUtc(date, time, TZ);

async function nightPlan(ctx: Ctx) {
  const owner = await login(ctx.app, 'owner@test.dev');
  const plan = (await owner.post('/api/plans').send({ locationId: ctx.loc.id, name: 'Night owl', interval: 'month' }).expect(201)).body;
  const shift = (name: string, startTime: string, endTime: string, priceCents = 300_000) =>
    owner.post('/api/shifts').send({ locationId: ctx.loc.id, planId: plan.id, name, startTime, endTime, priceCents, spaceIds: [ctx.desk.id] });
  return { owner, plan, shift };
}

describe('business hours and night shifts', () => {
  it('refuses a night shift while the business closes at eight, and says why', async () => {
    const ctx = await setup();
    const p = await nightPlan(ctx);
    const res = await p.shift('Night', '22:00', '06:00').expect(400);
    expect(res.body.error).toMatch(/business hours/);
    await p.shift('Nothing', '10:00', '10:00').expect(400); // cannot start and end together
  });

  it('allows a business that closes after midnight, and shifts that run past midnight', async () => {
    const ctx = await setup();
    const p = await nightPlan(ctx);
    await p.owner.patch(`/api/locations/${ctx.loc.id}`).send({ openTime: '18:00', closeTime: '04:00' }).expect(200);
    const night = (await p.shift('Night', '22:00', '02:00').expect(201)).body;
    const late = (await p.shift('Late', '02:00', '04:00').expect(201)).body;
    await p.shift('Outside', '12:00', '14:00').expect(400); // the middle of the day is closed
    await p.shift('Too long', '17:00', '05:00').expect(400); // opens at six, closes at four

    // The night shift belongs to the date it starts on; the shift in the small hours is the tail of that business day.
    const day = inDays(3);
    const m = (await p.owner.post('/api/members').send({ locationId: ctx.loc.id, name: 'Nia', email: 'nia@x.dev', planId: p.plan.id, status: 'active', startDate: day, shiftIds: [night.id, late.id], deskIds: [ctx.desk.id] }).expect(201)).body;
    const rows = (await ctx.db.select().from(bookings).where(eq(bookings.memberId, m.id)).all()).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const first = rows.filter((b) => localDate(b.startsAt, TZ) === day || localDate(b.startsAt, TZ) === addDays(day, 1));
    const nightRow = first.find((b) => localTime(b.startsAt, TZ) === '22:00' && localDate(b.startsAt, TZ) === day)!;
    expect(localTime(nightRow.endsAt, TZ)).toBe('02:00');
    expect(localDate(nightRow.endsAt, TZ)).toBe(addDays(day, 1));
    const lateRow = first.find((b) => localTime(b.startsAt, TZ) === '02:00' && localDate(b.startsAt, TZ) === addDays(day, 1))!;
    expect(localTime(lateRow.endsAt, TZ)).toBe('04:00');
    // so one business day has the two shifts, one after the other, with no clash
    expect(Date.parse(nightRow.endsAt)).toBe(Date.parse(lateRow.startsAt));

    // shifts that overlap across midnight are refused
    const clash = (await p.shift('Clash', '01:00', '03:00', 100_000).expect(201)).body;
    await p.owner.post('/api/members').send({ locationId: ctx.loc.id, name: 'Cal', email: 'cal@x.dev', planId: p.plan.id, status: 'active', startDate: day, shiftIds: [night.id, clash.id], deskIds: [ctx.desk2.id] }).expect(400);
  });

  it('checks a member in through the night and does not call them stale at midnight', async () => {
    const ctx = await setup();
    const p = await nightPlan(ctx);
    await p.owner.patch(`/api/locations/${ctx.loc.id}`).send({ openTime: '18:00', closeTime: '04:00' }).expect(200);
    const night = (await p.shift('Night', '22:00', '02:00').expect(201)).body;
    const day = inDays(2);
    const m = (await p.owner.post('/api/members').send({ locationId: ctx.loc.id, name: 'Nia', email: 'nia@x.dev', planId: p.plan.id, status: 'active', startDate: day, shiftIds: [night.id], deskIds: [ctx.desk.id] }).expect(201)).body;
    const member = { id: m.id, locationId: ctx.loc.id };
    const row = await checkInMember(ctx.db, member, null, at(day, '22:05'));
    expect(row.resourceId).toBe(ctx.desk.id);
    // after midnight she is still in, and counts as being in on the same business day
    await closeStaleVisits(ctx.db, ctx.loc.id, at(addDays(day, 1), '00:40'));
    expect((await ctx.db.select().from(attendance).where(eq(attendance.id, row.id)).get())!.checkOutAt).toBeNull();
    // after closing time she is taken to have left at four
    await closeStaleVisits(ctx.db, ctx.loc.id, at(addDays(day, 1), '09:00'));
    const closed = (await ctx.db.select().from(attendance).where(eq(attendance.id, row.id)).get())!;
    expect(closed.checkOutAt).not.toBeNull();
    expect(localTime(closed.checkOutAt!, TZ)).toBe('04:00');
    // before the shift starts (and outside the building's hours) nobody gets in
    await expect(checkInMember(ctx.db, member, null, at(addDays(day, 1), '12:00'))).rejects.toThrow();
  });
});

describe('changing a shift', () => {
  it('moves the bookings members already have to the new time, so they can check in', async () => {
    const ctx = await setup();
    const p = await nightPlan(ctx);
    const morning = (await p.shift('Morning', '09:00', '12:00').expect(201)).body;
    const day = inDays(2);
    const m = (await p.owner.post('/api/members').send({ locationId: ctx.loc.id, name: 'Sam', email: 'sam@x.dev', planId: p.plan.id, status: 'active', startDate: day, shiftIds: [morning.id], deskIds: [ctx.desk.id] }).expect(201)).body;
    const times = async () => [...new Set((await ctx.db.select().from(bookings).where(and(eq(bookings.memberId, m.id), eq(bookings.status, 'confirmed'))).all()).map((b) => `${localTime(b.startsAt, TZ)}-${localTime(b.endsAt, TZ)}`))];
    expect(await times()).toEqual(['09:00-12:00']);
    const member = { id: m.id, locationId: ctx.loc.id };
    await expect(checkInMember(ctx.db, member, null, at(day, '13:10'))).rejects.toThrow(); // not their time

    await p.owner.patch(`/api/shifts/${morning.id}`).send({ startTime: '13:00', endTime: '16:00' }).expect(200);
    expect(await times()).toEqual(['13:00-16:00']);
    // the new time is the one that counts
    expect((await checkInMember(ctx.db, member, null, at(day, '13:10'))).memberId).toBe(m.id);
  });

  it('does not move a shift into a time somebody else holds', async () => {
    const ctx = await setup();
    const p = await nightPlan(ctx);
    const morning = (await p.shift('Morning', '09:00', '12:00').expect(201)).body;
    const midday = (await p.shift('Midday', '12:00', '15:00').expect(201)).body;
    const day = inDays(2);
    const a = (await p.owner.post('/api/members').send({ locationId: ctx.loc.id, name: 'A', email: 'a@x.dev', planId: p.plan.id, status: 'active', startDate: day, shiftIds: [morning.id], deskIds: [ctx.desk.id] }).expect(201)).body;
    await p.owner.post('/api/members').send({ locationId: ctx.loc.id, name: 'B', email: 'b@x.dev', planId: p.plan.id, status: 'active', startDate: day, shiftIds: [midday.id], deskIds: [ctx.desk.id] }).expect(201);
    const res = await p.owner.patch(`/api/shifts/${morning.id}`).send({ endTime: '13:00' }).expect(409);
    expect(res.body.error).toMatch(/already booked/);
    const rows = await ctx.db.select().from(bookings).where(eq(bookings.memberId, a.id)).all();
    expect(rows.every((b) => localTime(b.endsAt, TZ) === '12:00')).toBe(true); // nothing moved
    expect((await ctx.db.select().from(resources).where(eq(resources.id, ctx.desk.id)).get())!.id).toBe(ctx.desk.id);
  });
});

describe('members past their time', () => {
  it('lists a member who is still in after their shift ended, and stops once they leave', async () => {
    const ctx = await setup();
    const p = await nightPlan(ctx);
    const morning = (await p.shift('Morning', '09:00', '12:00').expect(201)).body;
    const day = inDays(2);
    const m = (await p.owner.post('/api/members').send({ locationId: ctx.loc.id, name: 'Sam', email: 'sam@x.dev', planId: p.plan.id, status: 'active', startDate: day, shiftIds: [morning.id], deskIds: [ctx.desk.id] }).expect(201)).body;
    const row = await checkInMember(ctx.db, { id: m.id, locationId: ctx.loc.id }, null, at(day, '09:30'));
    expect(await overstayers(ctx.db, ctx.loc.id, undefined, at(day, '11:30'))).toEqual([]); // still within the shift
    const late = await overstayers(ctx.db, ctx.loc.id, undefined, at(day, '12:25'));
    expect(late).toMatchObject([{ memberName: 'Sam', minutesOver: 25, resourceName: 'Desk 1' }]);
    expect(await overstayers(ctx.db, ctx.loc.id, m.id, at(day, '12:25'))).toHaveLength(1);
    expect(await overstayers(ctx.db, ctx.loc.id, ctx.pro.member.id, at(day, '12:25'))).toEqual([]);
    await ctx.db.update(attendance).set({ checkOutAt: at(day, '12:30').toISOString() }).where(eq(attendance.id, row.id)).run();
    expect(await overstayers(ctx.db, ctx.loc.id, undefined, at(day, '12:40'))).toEqual([]);
  });

  it('shows the front desk the endpoint and the member their own alert', async () => {
    const ctx = await setup();
    const desk = await login(ctx.app, 'desk@test.dev');
    expect((await desk.get(`/api/attendance/overstaying?locationId=${ctx.loc.id}`).expect(200)).body).toEqual([]);
    const pro = await login(ctx.app, 'pro@test.dev');
    expect((await pro.get('/api/me/summary').expect(200)).body.overstay).toBeNull();
    await pro.get(`/api/attendance/overstaying?locationId=${ctx.loc.id}`).expect(403);
    const dash = (await desk.get(`/api/reports/dashboard?locationId=${ctx.loc.id}`).expect(200)).body;
    expect(dash.ops.overstaying).toEqual([]);
  });
});

describe('members can ask for every priced space', () => {
  const ask = (agent: Awaited<ReturnType<typeof login>>, resourceId: string) => agent.post('/api/requests').send({ resourceId, date: inDays(3), startTime: '10:00', endTime: '11:00', notes: '' });

  it('lets a member ask for a space the owner gave an hourly price, and for nothing else', async () => {
    const ctx = await setup();
    const make = (name: string, kind: 'room' | 'corporate_room' | 'office', style: string, hourlyRateCents: number) => ctx.db.insert(resources).values({ locationId: ctx.loc.id, kind, name, style, capacity: 6, hourlyRateCents }).returning().get();
    const focus = await make('Focus 1', 'room', 'focus', 5_000);
    const studio = await make('Studio 1', 'room', 'studio', 5_000);
    const hall = await make('Board', 'corporate_room', 'boardroom', 9_000);
    const office = await make('Office 5', 'office', '', 3_000);
    const hidden = await make('Back room', 'room', 'training', 0); // no price: plans and contracts only
    const pro = await login(ctx.app, 'pro@test.dev');
    for (const r of [ctx.room, ctx.desk, focus, studio, hall, office]) await ask(pro, r.id).expect(201);
    await ask(pro, hidden.id).expect(400);
    await ask(pro, ctx.dedicated.id).expect(400);
    await pro.post('/api/bookings/quote').send({ resourceId: hidden.id, date: inDays(3), startTime: '10:00', endTime: '11:00' }).expect(403);
    // the booking grid lists only what has a price
    const grid = (await pro.get(`/api/bookings/schedule?locationId=${ctx.loc.id}&date=${inDays(3)}`).expect(200)).body.resources as { id: string }[];
    expect(grid.some((r) => r.id === hidden.id || r.id === ctx.dedicated.id)).toBe(false);
    expect(grid.some((r) => r.id === focus.id && r.id !== hidden.id)).toBe(true);
    // the owner cannot book the unpriced one either, until they set a price
    const owner = await login(ctx.app, 'owner@test.dev');
    await owner.post('/api/bookings').send({ resourceId: hidden.id, memberId: ctx.pro.member.id, date: inDays(3), startTime: '10:00', endTime: '11:00' }).expect(400);
  });
});

describe('billing', () => {
  it('does not bill a shift plan member twice: the shifts are the bill, not the plan price as well', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const plan = (await owner.post('/api/plans').send({ locationId: ctx.loc.id, name: 'Hot', interval: 'month', priceCents: 1_000_000 }).expect(201)).body;
    const shift = (await owner.post('/api/shifts').send({ locationId: ctx.loc.id, planId: plan.id, name: 'Morning', startTime: '09:00', endTime: '12:00', priceCents: 500_000, spaceIds: [ctx.desk.id] }).expect(201)).body;
    const m = (await owner.post('/api/members').send({ locationId: ctx.loc.id, name: 'P', email: 'p@x.dev', planId: plan.id, status: 'active', startDate: inDays(0), shiftIds: [shift.id], deskIds: [ctx.desk.id] }).expect(201)).body;
    await owner.post('/api/invoices/generate').send({ locationId: ctx.loc.id, month: inDays(0).slice(0, 7) }).expect(201);
    const mine = await ctx.db.select().from(invoices).where(eq(invoices.memberId, m.id)).all();
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subtotalCents).toBe(500_000);
    // members on a plan from before shifts are still billed the plan's price
    const pros = await ctx.db.select().from(invoices).where(eq(invoices.memberId, ctx.pro.member.id)).all();
    expect(pros).toHaveLength(1);
    expect(pros[0]!.subtotalCents).toBe(20_000);
    // and the Today page counts what is expected each month the same way
    const dash = (await owner.get(`/api/reports/dashboard?locationId=${ctx.loc.id}`).expect(200)).body;
    expect(dash.finance.mrrCents).toBe(500_000 + 20_000 + 5_000);
  });
});

async function teaFor(ctx: Ctx, price = 200, free = 1) {
  const owner = await login(ctx.app, 'owner@test.dev');
  const tea = (await owner.post('/api/amenities').send({ locationId: ctx.loc.id, name: 'Tea', priceCents: price }).expect(201)).body;
  await owner.patch(`/api/members/${ctx.pro.member.id}`).send({ amenities: [{ amenityId: tea.id, freePerDay: free }] }).expect(200);
  return { owner, tea, desk: await login(ctx.app, 'desk@test.dev'), pro: await login(ctx.app, 'pro@test.dev') };
}

describe('amenities on invoices', () => {
  it('puts the amenities beyond the free amount on the monthly invoice, and out of the amount to collect', async () => {
    const ctx = await setup();
    const t = await teaFor(ctx, 200, 1);
    await t.desk.post('/api/amenities/orders').send({ memberId: ctx.pro.member.id, amenityId: t.tea.id, quantity: 4 }).expect(201); // 1 free, 3 paid
    expect((await t.pro.get('/api/me/summary').expect(200)).body.amenityDueCents).toBe(600);

    await t.owner.post('/api/invoices/generate').send({ locationId: ctx.loc.id, month: inDays(0).slice(0, 7) }).expect(201);
    const inv = (await ctx.db.select().from(invoices).where(eq(invoices.memberId, ctx.pro.member.id)).get())!;
    const lines = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, inv.id)).all();
    expect(lines.map((l) => [l.quantity, l.unitPriceCents, l.amountCents])).toContainEqual([3, 200, 600]);
    expect(lines.find((l) => l.description.startsWith('Tea'))).toBeTruthy();
    expect(inv.subtotalCents).toBe(20_000 + 600);
    expect((await ctx.db.select().from(amenityOrders).all())[0]!.invoiceId).toBe(inv.id);

    // it is on the invoice now, so it is no longer an amount to collect at the desk, and cannot be billed twice
    expect((await t.pro.get('/api/me/summary').expect(200)).body.amenityDueCents).toBe(0);
    expect((await t.owner.get(`/api/reports/finance?locationId=${ctx.loc.id}`).expect(200)).body.amenities.owedCents).toBe(0);
    await t.desk.post('/api/amenities/collect').send({ memberId: ctx.pro.member.id }).expect(409);
    await t.owner.post('/api/invoices/generate').send({ locationId: ctx.loc.id, month: addDays(inDays(0), 40).slice(0, 7) }).expect(201);
    expect(await ctx.db.select().from(invoices).where(eq(invoices.memberId, ctx.pro.member.id)).all()).toHaveLength(2); // the next month's own plan fee, not the tea again
    expect((await ctx.db.select().from(invoiceItems).all()).filter((l) => l.description.startsWith('Tea'))).toHaveLength(1);

    // voiding the invoice gives the charge back to be billed again
    await t.owner.post(`/api/invoices/${inv.id}/void`).expect(200);
    expect((await ctx.db.select().from(amenityOrders).all())[0]!.invoiceId).toBeNull();
    expect((await t.pro.get('/api/me/summary').expect(200)).body.amenityDueCents).toBe(600);
  });

  it('can invoice a member\'s amenities straight away', async () => {
    const ctx = await setup();
    const t = await teaFor(ctx, 150, 1);
    await t.desk.post('/api/amenities/orders').send({ memberId: ctx.pro.member.id, amenityId: t.tea.id, quantity: 2 }).expect(201); // 1 paid
    const made = (await t.owner.post('/api/amenities/invoice').send({ memberId: ctx.pro.member.id }).expect(201)).body;
    expect(made).toMatchObject({ memberId: ctx.pro.member.id, kind: 'manual', subtotalCents: 150 });
    await t.owner.post('/api/amenities/invoice').send({ memberId: ctx.pro.member.id }).expect(409);
    // and the member sees it with their invoices
    expect((await t.pro.get(`/api/invoices?locationId=${ctx.loc.id}`).expect(200)).body.some((i: { id: string }) => i.id === made.id)).toBe(true);
  });
});

describe('members asking for their amenities', () => {
  it('lets a member ask for what they are allotted, the front desk serve it, and the member see the answer', async () => {
    const ctx = await setup();
    const t = await teaFor(ctx, 200, 2);
    const coffee = (await t.owner.post('/api/amenities').send({ locationId: ctx.loc.id, name: 'Coffee', priceCents: 300 }).expect(201)).body;
    // coffee was not ticked for her, which only means none is free: she can still ask, and pays for it
    const paidAsk = (await t.pro.post('/api/amenities/requests').send({ amenityId: coffee.id, quantity: 2 }).expect(201)).body;
    const paidServed = (await t.desk.post(`/api/amenities/requests/${paidAsk.id}/serve`).expect(200)).body;
    expect(paidServed.order).toMatchObject({ quantity: 2, freeQuantity: 0, chargeCents: 600 });
    const menu = (await t.pro.get('/api/me/summary').expect(200)).body.amenities as { name: string; freePerDay: number; usedToday: number }[];
    expect(menu.map((a) => [a.name, a.freePerDay, a.usedToday])).toEqual([['Coffee', 0, 2], ['Tea', 2, 0]]);
    await t.pro.post('/api/amenities/requests').send({ amenityId: 'nope', quantity: 1 }).expect(404);
    await t.desk.post('/api/amenities/requests').send({ amenityId: t.tea.id, quantity: 1 }).expect(403); // staff record directly

    const asked = (await t.pro.post('/api/amenities/requests').send({ amenityId: t.tea.id, quantity: 3 }).expect(201)).body;
    expect(asked.status).toBe('pending');
    const waiting = (await t.desk.get(`/api/amenities/requests?locationId=${ctx.loc.id}&pending=1`).expect(200)).body;
    expect(waiting).toMatchObject([{ id: asked.id, name: 'Tea', quantity: 3, status: 'pending' }]);
    expect((await t.pro.get('/api/me/summary').expect(200)).body.amenityRequests).toHaveLength(2);
    await t.pro.post(`/api/amenities/requests/${asked.id}/serve`).expect(403); // members cannot serve themselves

    const served = (await t.desk.post(`/api/amenities/requests/${asked.id}/serve`).expect(200)).body;
    expect(served).toMatchObject({ status: 'served', order: { quantity: 3, freeQuantity: 2, chargeCents: 200 } }); // 2 free, the third is paid
    await t.desk.post(`/api/amenities/requests/${asked.id}/serve`).expect(409);
    expect((await t.pro.get('/api/me/summary').expect(200)).body.amenityRequests[0]).toMatchObject({ status: 'served' });
  });

  it('lets the front desk decline with a reason and the member cancel their own', async () => {
    const ctx = await setup();
    const t = await teaFor(ctx, 200, 2);
    const one = (await t.pro.post('/api/amenities/requests').send({ amenityId: t.tea.id }).expect(201)).body;
    await t.desk.post(`/api/amenities/requests/${one.id}/decline`).send({ reason: 'Kitchen is closed' }).expect(200);
    expect((await t.pro.get('/api/me/summary').expect(200)).body.amenityRequests[0]).toMatchObject({ status: 'declined', reason: 'Kitchen is closed' });
    const two = (await t.pro.post('/api/amenities/requests').send({ amenityId: t.tea.id }).expect(201)).body;
    await t.desk.post(`/api/amenities/requests/${two.id}/cancel`).expect(403);
    await t.pro.post(`/api/amenities/requests/${two.id}/cancel`).expect(200);
    expect((await t.desk.get(`/api/amenities/requests?locationId=${ctx.loc.id}&pending=1`).expect(200)).body).toEqual([]);
    // the other member does not see it
    const basic = await login(ctx.app, 'basic@test.dev');
    expect((await basic.get('/api/me/summary').expect(200)).body.amenityRequests).toEqual([]);
  });
});
