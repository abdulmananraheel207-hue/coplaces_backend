import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { resources, users } from '../src/db/schema.js';
import { checkInMember } from '../src/services/checkin.js';
import { todayIn, zonedToUtc } from '../src/lib/time.js';
import { inDays, login, setup, TZ } from './helpers.js';

const today = todayIn(TZ);
const at = (time: string, date = today) => zonedToUtc(date, time, TZ);
const day = inDays(2);

describe('hot desks booked from and until', () => {
  it('books a desk for part of a day, and the rest of the day stays free for someone else', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'manager@test.dev');
    const book = (memberId: string, startTime?: string, endTime?: string, resourceId = ctx.desk.id) =>
      staff.post('/api/bookings').send({ resourceId, memberId, date: day, startTime, endTime });

    const morning = await book(ctx.pro.member.id, '09:00', '14:00').expect(201);
    expect(morning.body.allDay).toBeUndefined();
    await book(ctx.basic.member.id, '13:00', '16:00').expect(409); // overlaps the morning
    await book(ctx.basic.member.id, '14:00', '18:00').expect(201); // starts when it ends
    await book(ctx.pro.member.id, '08:00', '09:00').expect(201);
    // A whole-day booking still works, and clashes with any part of the day already taken.
    await staff.post('/api/bookings').send({ resourceId: ctx.desk2.id, memberId: ctx.pro.member.id, date: inDays(3) }).expect(201);
    await book(ctx.basic.member.id, undefined, undefined).expect(409);
  });

  it('asks for both times or neither, in 15 minute steps and inside opening hours', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'manager@test.dev');
    const b = { resourceId: ctx.desk.id, memberId: ctx.pro.member.id, date: day };
    await staff.post('/api/bookings').send({ ...b, startTime: '09:00' }).expect(400);
    await staff.post('/api/bookings').send({ ...b, startTime: '10:00', endTime: '09:00' }).expect(400);
    await staff.post('/api/bookings').send({ ...b, startTime: '09:00', endTime: '09:10' }).expect(400);
    await staff.post('/api/bookings').send({ ...b, startTime: '06:00', endTime: '09:00' }).expect(400);
    await staff.post('/api/bookings').send({ ...b, startTime: '09:00', endTime: '14:00' }).expect(201);
  });

  it('lets a member hold two desks in one day as long as the times do not overlap', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'manager@test.dev');
    const b = { memberId: ctx.pro.member.id, date: day };
    await staff.post('/api/bookings').send({ ...b, resourceId: ctx.desk.id, startTime: '09:00', endTime: '12:00' }).expect(201);
    const clash = await staff.post('/api/bookings').send({ ...b, resourceId: ctx.desk2.id, startTime: '11:00', endTime: '13:00' }).expect(409);
    expect(clash.body.error).toMatch(/already has a desk booked at that time/);
    await staff.post('/api/bookings').send({ ...b, resourceId: ctx.desk2.id, startTime: '12:00', endTime: '13:00' }).expect(201);
  });

  it('prices a part-day by the hour, never above a day, and free on a plan with hot desks', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'manager@test.dev');
    await ctx.db.update(resources).set({ hourlyRateCents: 500, dailyRateCents: 2_500 }).where(eq(resources.id, ctx.desk.id)).run();
    const q = (memberId: string, startTime?: string, endTime?: string) =>
      staff.post('/api/bookings/quote').send({ resourceId: ctx.desk.id, memberId, date: day, startTime, endTime }).expect(200);
    expect((await q(ctx.basic.member.id, '09:00', '12:00')).body.priceCents).toBe(1_500);
    expect((await q(ctx.basic.member.id, '08:00', '20:00')).body.priceCents).toBe(2_500); // capped at the day
    expect((await q(ctx.basic.member.id)).body.priceCents).toBe(2_500);
    expect((await q(ctx.pro.member.id, '09:00', '12:00')).body.priceCents).toBe(0); // Pro includes hot desks
  });

  it('marks whole-day bookings so the screens can say "all day"', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'manager@test.dev');
    await staff.post('/api/bookings').send({ resourceId: ctx.desk.id, memberId: ctx.pro.member.id, date: day }).expect(201);
    await staff.post('/api/bookings').send({ resourceId: ctx.desk2.id, memberId: ctx.basic.member.id, date: day, startTime: '09:00', endTime: '14:00' }).expect(201);
    const list = (await staff.get(`/api/bookings?locationId=${ctx.loc.id}&from=${day}&to=${day}`)).body;
    expect(list.find((b: { resourceId: string }) => b.resourceId === ctx.desk.id).allDay).toBe(true);
    expect(list.find((b: { resourceId: string }) => b.resourceId === ctx.desk2.id).allDay).toBe(false);
    const sched = (await staff.get(`/api/bookings/schedule?locationId=${ctx.loc.id}&date=${day}`)).body;
    expect(sched.bookings.map((b: { allDay: boolean }) => b.allDay).sort()).toEqual([false, true]);
  });

  it('counts a part-day booking as that part of a day in the busy figures', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'manager@test.dev');
    await staff.post('/api/bookings').send({ resourceId: ctx.desk.id, memberId: ctx.pro.member.id, date: day, startTime: '08:00', endTime: '14:00' }).expect(201);
    const occ = (await staff.get(`/api/reports/occupancy?locationId=${ctx.loc.id}&days=7&to=${inDays(5)}`)).body;
    expect(occ.items.find((i: { resourceId: string }) => i.resourceId === ctx.desk.id).used).toBe(0.5);
  });
});

describe('checking in at a desk booked for part of the day', () => {
  const staffUser = async (ctx: Awaited<ReturnType<typeof setup>>) => {
    const u = (await ctx.db.select().from(users).where(eq(users.email, 'desk@test.dev')).get())!;
    return { id: u.id, role: 'staff', organizationId: ctx.org.id, locationIds: [ctx.loc.id], permissions: ['bookings', 'front_desk'] } as never;
  };

  it('holds the member to the time they booked, and lets someone else use the desk outside it', async () => {
    const ctx = await setup();
    const { createBooking } = await import('../src/services/bookings.js');
    const mk = async (memberId: string, startTime: string, endTime: string) =>
      createBooking(ctx.db, { resourceId: ctx.desk.id, memberId, date: today, startTime, endTime, notes: '' }, await staffUser(ctx), at('07:00'));
    await mk(ctx.pro.member.id, '09:00', '12:00');
    await mk(ctx.basic.member.id, '15:00', '18:00');

    await expect(checkInMember(ctx.db, ctx.pro.member, ctx.desk.id, at('14:00'))).rejects.toThrow(/from 09:00 to 12:00/);
    await expect(checkInMember(ctx.db, ctx.basic.member, ctx.desk.id, at('10:00'))).rejects.toThrow(/from 15:00 to 18:00/);
    const row = await checkInMember(ctx.db, ctx.pro.member, ctx.desk.id, at('08:45'));
    expect(row.resourceId).toBe(ctx.desk.id);
  });

  it('refuses someone with no booking when the desk is booked by another for the current hour', async () => {
    const ctx = await setup();
    const { createBooking } = await import('../src/services/bookings.js');
    await createBooking(ctx.db, { resourceId: ctx.desk.id, memberId: ctx.pro.member.id, date: today, startTime: '14:00', endTime: '16:00', notes: '' }, await staffUser(ctx), at('07:00'));
    await expect(checkInMember(ctx.db, ctx.basic.member, ctx.desk.id, at('13:30'))).rejects.toThrow(/booked today by pro/);
    // Plenty of time before it starts, so the desk can be used until then.
    expect((await checkInMember(ctx.db, ctx.basic.member, ctx.desk.id, at('10:00'))).resourceId).toBe(ctx.desk.id);
  });
});

describe('shift templates', () => {
  it('lets the owner make, change and delete them, and everyone at the location read them', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const made = await owner.post('/api/shifts').send({ locationId: ctx.loc.id, name: 'Morning', kind: 'hot_desk', startTime: '09:00', endTime: '14:00', priceCents: 1_200 }).expect(201);
    const member = await login(ctx.app, 'basic@test.dev');
    expect((await member.get(`/api/shifts?locationId=${ctx.loc.id}`).expect(200)).body).toHaveLength(1);
    await member.post('/api/shifts').send({ locationId: ctx.loc.id, name: 'Sneaky', startTime: '09:00', endTime: '10:00' }).expect(403);
    await owner.patch(`/api/shifts/${made.body.id}`).send({ name: 'Early', endTime: '13:00' }).expect(200);
    const outside = await login(ctx.app, 'uptown@test.dev');
    await outside.patch(`/api/shifts/${made.body.id}`).send({ name: 'No' }).expect(403);
    await owner.delete(`/api/shifts/${made.body.id}`).expect(204);
    expect((await owner.get(`/api/shifts?locationId=${ctx.loc.id}`)).body).toHaveLength(0);
  });

  it('rejects shifts that end before they start, are not in 15 minute steps, or name a space that is not booked', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const base = { locationId: ctx.loc.id, name: 'X', startTime: '09:00', endTime: '14:00' };
    await owner.post('/api/shifts').send({ ...base, endTime: '08:00' }).expect(400);
    await owner.post('/api/shifts').send({ ...base, endTime: '14:10' }).expect(400);
    await owner.post('/api/shifts').send({ ...base, spaceIds: [ctx.dedicated.id] }).expect(400);
    await owner.post('/api/shifts').send({ ...base, spaceIds: [ctx.room.id] }).expect(201);
  });

  it('charges the shift price when a booking matches it exactly, preferring the most specific shift', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const slot = { locationId: ctx.loc.id, startTime: '09:00', endTime: '14:00' };
    const quote = (resourceId: string, memberId: string, startTime = '09:00', endTime = '14:00') =>
      owner.post('/api/bookings/quote').send({ resourceId, memberId, date: day, startTime, endTime }).expect(200);

    await ctx.db.update(resources).set({ hourlyRateCents: 500, dailyRateCents: 2_500 }).where(eq(resources.id, ctx.desk.id)).run();
    expect((await quote(ctx.desk.id, ctx.basic.member.id)).body.priceCents).toBe(2_500); // capped hourly, no shift yet
    await owner.post('/api/shifts').send({ ...slot, name: 'Morning', priceCents: 1_200 }).expect(201);
    expect((await quote(ctx.desk.id, ctx.basic.member.id)).body.priceCents).toBe(1_200);
    await owner.post('/api/shifts').send({ ...slot, name: 'Desk 1 morning', spaceIds: [ctx.desk.id], priceCents: 900 }).expect(201);
    expect((await quote(ctx.desk.id, ctx.basic.member.id)).body.priceCents).toBe(900);
    expect((await quote(ctx.desk2.id, ctx.basic.member.id)).body.priceCents).toBe(1_200);
    // Not an exact match, so the hourly working applies again.
    expect((await quote(ctx.desk.id, ctx.basic.member.id, '09:00', '13:00')).body.priceCents).toBe(2_000);
    // A plan that includes hot desks still pays nothing, and the quote says why.
    const free = (await quote(ctx.desk.id, ctx.pro.member.id)).body;
    expect(free.priceCents).toBe(0);
    expect(free.basis).toEqual({ type: 'plan' });
    expect((await quote(ctx.desk.id, ctx.basic.member.id)).body.basis).toEqual({ type: 'shift', name: 'Desk 1 morning' });
    expect((await quote(ctx.desk.id, ctx.basic.member.id, '09:00', '13:00')).body.basis).toEqual({ type: 'hourly', rateCents: 500 });
    expect((await quote(ctx.room.id, ctx.basic.member.id, '09:00', '10:00')).body.basis).toEqual({ type: 'hourly', rateCents: 6_000 });
  });

  it('works for rooms too, and an inactive shift is ignored', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const s = await owner.post('/api/shifts').send({ locationId: ctx.loc.id, name: 'Half day', resourceId: ctx.room.id, startTime: '09:00', endTime: '13:00', priceCents: 15_000 }).expect(201);
    const quote = () => owner.post('/api/bookings/quote').send({ resourceId: ctx.room.id, memberId: ctx.basic.member.id, date: day, startTime: '09:00', endTime: '13:00' }).expect(200);
    expect((await quote()).body.priceCents).toBe(15_000);
    await owner.patch(`/api/shifts/${s.body.id}`).send({ active: false }).expect(200);
    expect((await quote()).body.priceCents).toBe(24_000); // 4 hours at 60.00
  });
});

describe('shifts inside plans', () => {
  it('only prices bookings for members on the plan, and only in the chosen spaces', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const quote = (resourceId: string, memberId: string) =>
      owner.post('/api/bookings/quote').send({ resourceId, memberId, date: day, startTime: '09:00', endTime: '14:00' }).expect(200);
    await ctx.db.update(resources).set({ hourlyRateCents: 500, dailyRateCents: 2_500 }).where(eq(resources.id, ctx.desk.id)).run();

    const shift = await owner
      .post('/api/shifts')
      .send({ locationId: ctx.loc.id, planId: ctx.basicPlan.id, name: 'Morning', startTime: '09:00', endTime: '14:00', priceCents: 700, spaceIds: [ctx.desk.id] })
      .expect(201);
    expect(shift.body).toMatchObject({ planId: ctx.basicPlan.id, spaceIds: [ctx.desk.id] });

    expect((await quote(ctx.desk.id, ctx.basic.member.id)).body.priceCents).toBe(700); // on the plan, in the space
    expect((await quote(ctx.desk2.id, ctx.basic.member.id)).body.priceCents).not.toBe(700); // not a chosen space

    // members and staff only see the shifts that are theirs
    const mine = await login(ctx.app, 'basic@test.dev');
    expect((await mine.get(`/api/shifts?locationId=${ctx.loc.id}`).expect(200)).body).toHaveLength(1);
    const other = await login(ctx.app, 'pro@test.dev');
    expect((await other.get(`/api/shifts?locationId=${ctx.loc.id}`).expect(200)).body).toHaveLength(0);
    expect((await owner.get(`/api/shifts?locationId=${ctx.loc.id}&memberId=${ctx.pro.member.id}`).expect(200)).body).toHaveLength(0);
    expect((await owner.get(`/api/shifts?locationId=${ctx.loc.id}`).expect(200)).body).toHaveLength(1);

    // edit: change the spaces and the price
    const edited = await owner.patch(`/api/shifts/${shift.body.id}`).send({ priceCents: 800, spaceIds: [ctx.desk.id, ctx.desk2.id] }).expect(200);
    expect(edited.body.spaceIds.sort()).toEqual([ctx.desk.id, ctx.desk2.id].sort());
    expect((await quote(ctx.desk2.id, ctx.basic.member.id)).body.priceCents).toBe(800);
  });

  it('deleting a plan deletes its shifts and leaves its members without a plan', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    await owner.post('/api/shifts').send({ locationId: ctx.loc.id, planId: ctx.basicPlan.id, name: 'Morning', startTime: '09:00', endTime: '14:00' }).expect(201);
    await owner.delete(`/api/plans/${ctx.basicPlan.id}`).expect(204);
    expect((await owner.get(`/api/shifts?locationId=${ctx.loc.id}`)).body).toHaveLength(0);
    expect((await owner.get(`/api/plans?locationId=${ctx.loc.id}`)).body.map((p: { id: string }) => p.id)).not.toContain(ctx.basicPlan.id);
    const m = await owner.get(`/api/members/${ctx.basic.member.id}`).expect(200);
    expect(m.body.planId ?? m.body.member?.planId ?? null).toBeNull();
    await owner.delete(`/api/plans/${ctx.basicPlan.id}`).expect(404);
  });

  it('makes a plan with no price of its own', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const made = await owner.post('/api/plans').send({ locationId: ctx.loc.id, name: 'Day Pass', interval: 'day' }).expect(201);
    expect(made.body.priceCents).toBe(0);
  });
});
