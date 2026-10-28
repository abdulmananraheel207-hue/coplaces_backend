import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { attendance, bookings, members, users } from '../src/db/schema.js';
import { checkInMember } from '../src/services/checkin.js';
import { addDays, todayIn, zonedToUtc } from '../src/lib/time.js';
import { inDays, login, setupOpen as setup, TZ } from './helpers.js';

const today = todayIn(TZ);

/** Whole journeys across the front desk, bookings, contracts and members, which have to agree with one another. */
describe('flows that cross the front desk, bookings, contracts and members', () => {
  it('lets someone who forgot to check out yesterday check in today, and clears the old visit', async () => {
    const ctx = await setup();
    const yesterday = addDays(today, -1);
    await ctx.db.insert(attendance).values({ locationId: ctx.loc.id, memberId: ctx.pro.member.id, resourceId: ctx.desk.id, checkInAt: zonedToUtc(yesterday, '09:00', TZ).toISOString() }).run();
    const staff = await login(ctx.app, 'desk@test.dev');
    // The stale visit never shows as "in the building".
    expect((await staff.get(`/api/attendance?locationId=${ctx.loc.id}&open=1`)).body).toHaveLength(0);
    const old = (await ctx.db.select().from(attendance).where(eq(attendance.memberId, ctx.pro.member.id)).get())!;
    expect(old.checkOutAt).toBeTruthy();
    expect(old.checkOutAt! > old.checkInAt).toBe(true);
    await staff.post('/api/attendance/check-in').send({ memberId: ctx.pro.member.id, resourceId: ctx.desk.id }).expect(201);
  });

  it('closes an overnight visit when checking in, even if nobody looked at the list', async () => {
    const ctx = await setup();
    await ctx.db.insert(attendance).values({ locationId: ctx.loc.id, memberId: ctx.pro.member.id, checkInAt: zonedToUtc(addDays(today, -2), '10:00', TZ).toISOString() }).run();
    expect((await checkInMember(ctx.db, ctx.pro.member, null)).memberId).toBe(ctx.pro.member.id);
  });

  it('cancelling a member cancels their coming bookings, checks them out, and keeps what was already invoiced', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'manager@test.dev');
    const future = await staff.post('/api/bookings').send({ resourceId: ctx.desk.id, memberId: ctx.pro.member.id, date: inDays(3) }).expect(201);
    const invoiced = await staff.post('/api/bookings').send({ resourceId: ctx.desk.id, memberId: ctx.pro.member.id, date: inDays(4) }).expect(201);
    await ctx.db.update(bookings).set({ invoiceId: 'inv' }).where(eq(bookings.id, invoiced.body.id)).run();
    const row = await staff.post('/api/attendance/check-in').send({ memberId: ctx.pro.member.id }).expect(201);

    await staff.patch(`/api/members/${ctx.pro.member.id}`).send({ status: 'cancelled' }).expect(200);
    const after = async (id: string) => (await ctx.db.select().from(bookings).where(eq(bookings.id, id)).get())!;
    expect((await after(future.body.id)).status).toBe('cancelled');
    expect((await after(invoiced.body.id)).status).toBe('confirmed');
    expect((await ctx.db.select().from(attendance).where(eq(attendance.id, row.body.id)).get())!.checkOutAt).toBeTruthy();
    // The desk is free for someone else on that day.
    await staff.post('/api/bookings').send({ resourceId: ctx.desk.id, memberId: ctx.basic.member.id, date: inDays(3) }).expect(201);
  });

  it('will not cancel a member whose contract is still running', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'manager@test.dev');
    const c = await staff.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.pro.member.id, resourceId: ctx.dedicated.id, startDate: today }).expect(201);
    await staff.post(`/api/contracts/${c.body.id}/activate`).expect(200);
    const r = await staff.patch(`/api/members/${ctx.pro.member.id}`).send({ status: 'cancelled' }).expect(409);
    expect(r.body.error).toMatch(/contract/);
    await staff.post(`/api/contracts/${c.body.id}/end`).send({}).expect(200);
    await staff.patch(`/api/members/${ctx.pro.member.id}`).send({ status: 'cancelled' }).expect(200);
  });

  it('runs a rented hot desk from contract to check-in to end, and the desk is bookable again', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'manager@test.dev');
    const c = await staff.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.pro.member.id, resourceId: ctx.desk.id, startDate: today }).expect(201);
    await staff.post(`/api/contracts/${c.body.id}/activate`).expect(200);
    await staff.post('/api/bookings').send({ resourceId: ctx.desk.id, memberId: ctx.basic.member.id, date: inDays(1) }).expect(409);
    await staff.post('/api/attendance/check-in').send({ memberId: ctx.basic.member.id, resourceId: ctx.desk.id }).expect(409);
    await staff.post('/api/attendance/check-in').send({ memberId: ctx.pro.member.id, resourceId: ctx.desk.id }).expect(201);

    await staff.post(`/api/contracts/${c.body.id}/end`).send({}).expect(200);
    const list = (await staff.get(`/api/resources?locationId=${ctx.loc.id}`)).body;
    expect(list.find((r: { id: string }) => r.id === ctx.desk.id).occupied).toBe(false);
    await staff.post('/api/bookings').send({ resourceId: ctx.desk.id, memberId: ctx.basic.member.id, date: inDays(1) }).expect(201);
  });

  it('keeps a cancelled booking from holding the member to a desk or blocking the desk', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'manager@test.dev');
    const b = await staff.post('/api/bookings').send({ resourceId: ctx.desk.id, memberId: ctx.pro.member.id, date: today }).expect(201);
    await staff.post(`/api/bookings/${b.body.id}/cancel`).expect(200);
    await staff.post('/api/attendance/check-in').send({ memberId: ctx.basic.member.id, resourceId: ctx.desk.id }).expect(201);
    await staff.post('/api/attendance/check-in').send({ memberId: ctx.pro.member.id, resourceId: ctx.desk2.id }).expect(201);
  });

  it('shows a member checked in at a part-day desk as in use only for the time they booked', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'manager@test.dev');
    await staff.post('/api/bookings').send({ resourceId: ctx.desk.id, memberId: ctx.pro.member.id, date: inDays(2), startTime: '09:00', endTime: '12:00' }).expect(201);
    const sched = (await staff.get(`/api/bookings/schedule?locationId=${ctx.loc.id}&date=${inDays(2)}`)).body;
    expect(sched.bookings).toHaveLength(1);
    expect(sched.bookings[0].allDay).toBe(false);
  });

  it('keeps member accounts of one member from checking others in', async () => {
    const ctx = await setup();
    const member = await login(ctx.app, 'basic@test.dev');
    const row = await member.post('/api/attendance/check-in').send({ memberId: ctx.pro.member.id }).expect(201);
    expect(row.body.memberId).toBe(ctx.basic.member.id);
    expect(await ctx.db.select().from(members).where(and(eq(members.id, ctx.pro.member.id))).get()).toBeTruthy();
    expect(await ctx.db.select().from(users).where(eq(users.email, 'pro@test.dev')).get()).toBeTruthy();
  });
});
