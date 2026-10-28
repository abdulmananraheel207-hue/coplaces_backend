import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { resourceAssignments, resources, users } from '../src/db/schema.js';
import { createBooking, cancelBooking } from '../src/services/bookings.js';
import { todayIn, zonedToUtc } from '../src/lib/time.js';
import { login, setupOpen as setup, TZ, tomorrow } from './helpers.js';

const nine = (d: string) => zonedToUtc(d, '09:00', TZ);
const staffUser = async (ctx: Awaited<ReturnType<typeof setup>>) => {
  const u = (await ctx.db.select().from(users).where(eq(users.email, 'desk@test.dev')).get())!;
  return { id: u.id, role: 'staff', organizationId: ctx.org.id, locationIds: [ctx.loc.id], permissions: ['bookings', 'front_desk'] } as never;
};
const book = async (ctx: Awaited<ReturnType<typeof setup>>, resourceId: string, memberId: string, date = todayIn(TZ)) =>
  createBooking(ctx.db, { resourceId, memberId, date, notes: '' }, await staffUser(ctx), nine(todayIn(TZ)));
const checkIn = (agent: Awaited<ReturnType<typeof login>>, memberId: string, resourceId: string | null) =>
  agent.post('/api/attendance/check-in').send({ memberId, resourceId });

describe('front desk check-in matches the member\'s bookings', () => {
  it('lets a member with a desk booked today check in only at that desk', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'desk@test.dev');
    await book(ctx, ctx.desk.id, ctx.pro.member.id);
    const wrong = await checkIn(staff, ctx.pro.member.id, ctx.desk2.id).expect(409);
    expect(JSON.stringify(wrong.body)).toMatch(/booked Desk 1/);
    await checkIn(staff, ctx.pro.member.id, ctx.room.id).expect(409);
    await checkIn(staff, ctx.pro.member.id, ctx.desk.id).expect(201);
  });

  it('records the booked desk when no desk is picked', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'desk@test.dev');
    await book(ctx, ctx.desk.id, ctx.pro.member.id);
    const r = await checkIn(staff, ctx.pro.member.id, null).expect(201);
    expect(r.body.resourceId).toBe(ctx.desk.id);
  });

  it('is not held to a desk booked for another day, a cancelled booking, or a room booking', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'desk@test.dev');
    await book(ctx, ctx.desk.id, ctx.pro.member.id, tomorrow());
    const cancelled = await book(ctx, ctx.desk2.id, ctx.basic.member.id);
    await cancelBooking(ctx.db, cancelled.id, await staffUser(ctx), nine(todayIn(TZ)));
    await checkIn(staff, ctx.pro.member.id, ctx.desk2.id).expect(201);
    await staff.post(`/api/attendance/${(await staff.get(`/api/attendance?locationId=${ctx.loc.id}&open=1`)).body[0].id}/check-out`).expect(200);
    await checkIn(staff, ctx.basic.member.id, ctx.desk.id).expect(201);
  });

  it('keeps a booked room from changing anything', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'desk@test.dev');
    await createBooking(ctx.db, { resourceId: ctx.room.id, memberId: ctx.pro.member.id, date: todayIn(TZ), startTime: '14:00', endTime: '15:00', notes: '' }, await staffUser(ctx), nine(todayIn(TZ)));
    const r = await checkIn(staff, ctx.pro.member.id, null).expect(201);
    expect(r.body.resourceId).toBeNull();
  });

  it('still holds the member to the booked desk after they check out and come back', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'desk@test.dev');
    await book(ctx, ctx.desk.id, ctx.pro.member.id);
    const first = await checkIn(staff, ctx.pro.member.id, ctx.desk.id).expect(201);
    await staff.post(`/api/attendance/${first.body.id}/check-out`).expect(200);
    await checkIn(staff, ctx.pro.member.id, ctx.desk2.id).expect(409);
    await checkIn(staff, ctx.pro.member.id, ctx.desk.id).expect(201);
  });

  it('applies to members checking themselves in too', async () => {
    const ctx = await setup();
    const me = await login(ctx.app, 'pro@test.dev');
    await book(ctx, ctx.desk.id, ctx.pro.member.id);
    await me.post('/api/attendance/check-in').send({ resourceId: ctx.desk2.id }).expect(409);
    await me.post('/api/attendance/check-in').send({ resourceId: ctx.desk.id }).expect(201);
  });
});

describe('check-in only at spaces that can be sat at', () => {
  it('refuses desks that are out of service or retired, and spaces that are not desks', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'desk@test.dev');
    await ctx.db.update(resources).set({ status: 'maintenance' }).where(eq(resources.id, ctx.desk.id)).run();
    await checkIn(staff, ctx.pro.member.id, ctx.desk.id).expect(409);
    await ctx.db.update(resources).set({ status: 'retired' }).where(eq(resources.id, ctx.desk2.id)).run();
    await checkIn(staff, ctx.pro.member.id, ctx.desk2.id).expect(409);
    await checkIn(staff, ctx.pro.member.id, ctx.room.id).expect(409);
  });

  it('refuses a dedicated desk that belongs to someone else, and allows its owner', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'desk@test.dev');
    await ctx.db.insert(resourceAssignments).values({ resourceId: ctx.dedicated.id, memberId: ctx.pro.member.id, startDate: todayIn(TZ) }).run();
    const r = await checkIn(staff, ctx.basic.member.id, ctx.dedicated.id).expect(409);
    expect(JSON.stringify(r.body)).toMatch(/assigned to pro/);
    await checkIn(staff, ctx.pro.member.id, ctx.dedicated.id).expect(201);
  });

  it('allows an unassigned dedicated desk, and one whose assignment has ended', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'desk@test.dev');
    await ctx.db.insert(resourceAssignments).values({ resourceId: ctx.dedicated.id, memberId: ctx.pro.member.id, startDate: '2020-01-01', endDate: '2020-02-01' }).run();
    await checkIn(staff, ctx.basic.member.id, ctx.dedicated.id).expect(201);
  });
});

describe('front desk and the bookings list agree', () => {
  it('shows the booked desk as in use once its member is checked in, and only that desk', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'desk@test.dev');
    await book(ctx, ctx.desk.id, ctx.pro.member.id);
    await checkIn(staff, ctx.pro.member.id, ctx.desk.id).expect(201);
    const sched = await staff.get(`/api/bookings/schedule?locationId=${ctx.loc.id}&date=${todayIn(TZ)}`).expect(200);
    expect(sched.body.inUse.map((x: { resourceId: string }) => x.resourceId)).toEqual([ctx.desk.id]);
  });

  it('lets staff see which desk a member booked today so the front desk can preselect it', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'desk@test.dev');
    await book(ctx, ctx.desk.id, ctx.pro.member.id);
    const today = todayIn(TZ);
    const list = await staff.get(`/api/bookings?locationId=${ctx.loc.id}&memberId=${ctx.pro.member.id}&from=${today}&to=${today}`).expect(200);
    expect(list.body.map((b: { resourceId: string }) => b.resourceId)).toEqual([ctx.desk.id]);
  });
});
