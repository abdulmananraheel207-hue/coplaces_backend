import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bookings, locations, resources, users } from '../src/db/schema.js';
import { checkInMember } from '../src/services/checkin.js';
import { createBooking } from '../src/services/bookings.js';
import { todayIn, zonedToUtc } from '../src/lib/time.js';
import { login, setup, TZ, inDays } from './helpers.js';

const today = todayIn(TZ);
const at = (time: string, date = today) => zonedToUtc(date, time, TZ);
const staffUser = async (ctx: Awaited<ReturnType<typeof setup>>) => {
  const u = (await ctx.db.select().from(users).where(eq(users.email, 'desk@test.dev')).get())!;
  return { id: u.id, role: 'staff', organizationId: ctx.org.id, locationIds: [ctx.loc.id], permissions: ['bookings', 'front_desk'] } as never;
};
const book = async (ctx: Awaited<ReturnType<typeof setup>>, resourceId: string, memberId: string, extra: { startTime?: string; endTime?: string; date?: string } = {}) =>
  createBooking(ctx.db, { resourceId, memberId, date: extra.date ?? today, startTime: extra.startTime, endTime: extra.endTime, notes: '' }, await staffUser(ctx), at('07:00'));

describe('contracts and the spaces they rent', () => {
  it('frees the space the moment the contract ends, and shows it as vacant', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'manager@test.dev');
    const c = await staff.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.pro.member.id, resourceId: ctx.dedicated.id, startDate: today }).expect(201);
    await staff.post(`/api/contracts/${c.body.id}/activate`).expect(200);
    const held = (await staff.get(`/api/resources?locationId=${ctx.loc.id}`)).body.find((r: { id: string }) => r.id === ctx.dedicated.id);
    expect(held.occupied).toBe(true);
    await staff.post(`/api/contracts/${c.body.id}/end`).send({}).expect(200);
    const free = (await staff.get(`/api/resources?locationId=${ctx.loc.id}`)).body.find((r: { id: string }) => r.id === ctx.dedicated.id);
    expect(free.occupied).toBe(false);
  });

  it('keeps the space for the rest of the period when the end date is in the future', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'manager@test.dev');
    const c = await staff.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.pro.member.id, resourceId: ctx.dedicated.id, startDate: today }).expect(201);
    await staff.post(`/api/contracts/${c.body.id}/activate`).expect(200);
    await staff.post(`/api/contracts/${c.body.id}/end`).send({ endDate: inDays(5) }).expect(200);
    const row = (await staff.get(`/api/resources?locationId=${ctx.loc.id}`)).body.find((r: { id: string }) => r.id === ctx.dedicated.id);
    expect(row.occupied).toBe(true);
  });

  it('lets a meeting room be rented, so nobody else can book it until the contract ends', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'manager@test.dev');
    const c = await staff.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.pro.member.id, resourceId: ctx.room.id, startDate: inDays(1) }).expect(201);
    await staff.post(`/api/contracts/${c.body.id}/activate`).expect(200);
    const body = { resourceId: ctx.room.id, date: inDays(2), startTime: '10:00', endTime: '11:00' };
    const other = await staff.post('/api/bookings').send({ ...body, memberId: ctx.basic.member.id }).expect(409);
    expect(other.body.error).toMatch(/rented to pro/);
    await staff.post('/api/bookings').send({ ...body, memberId: ctx.pro.member.id }).expect(201);
    await staff.post(`/api/contracts/${c.body.id}/end`).send({ endDate: inDays(1) }).expect(200);
    await staff.post('/api/bookings').send({ ...body, date: inDays(3), memberId: ctx.basic.member.id }).expect(201);
  });

  it('will not rent a room that other members have booked in that time', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'manager@test.dev');
    await staff.post('/api/bookings').send({ resourceId: ctx.room.id, memberId: ctx.basic.member.id, date: inDays(2), startTime: '10:00', endTime: '11:00' }).expect(201);
    const c = await staff.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.pro.member.id, resourceId: ctx.room.id, startDate: inDays(1) }).expect(201);
    const r = await staff.post(`/api/contracts/${c.body.id}/activate`).expect(409);
    expect(r.body.error).toMatch(/bookings by other members/);
  });
});

describe('the front desk and bookings agree', () => {
  it('marks the booking checked in, and completed once the member checks out', async () => {
    const ctx = await setup();
    const b = await book(ctx, ctx.desk.id, ctx.pro.member.id);
    const inn = await checkInMember(ctx.db, ctx.pro.member, ctx.desk.id, at('09:30'));
    expect((await ctx.db.select().from(bookings).where(eq(bookings.id, b.id)).get())!.checkedInAt).toBe(at('09:30').toISOString());
    expect((await ctx.db.select().from(bookings).where(eq(bookings.id, b.id)).get())!.status).toBe('confirmed');
    const staff = await login(ctx.app, 'desk@test.dev');
    await staff.post(`/api/attendance/${inn.id}/check-out`).expect(200);
    expect((await ctx.db.select().from(bookings).where(eq(bookings.id, b.id)).get())!.status).toBe('completed');
  });

  it('does not complete a booking the member never checked in for', async () => {
    const ctx = await setup();
    const b = await book(ctx, ctx.desk.id, ctx.pro.member.id);
    const staff = await login(ctx.app, 'desk@test.dev');
    const inn = await checkInMember(ctx.db, ctx.basic.member, ctx.desk2.id, at('09:30'));
    await staff.post(`/api/attendance/${inn.id}/check-out`).expect(200);
    expect((await ctx.db.select().from(bookings).where(eq(bookings.id, b.id)).get())!.status).toBe('confirmed');
  });

  it('checks a member in at the room they booked, but only around the time they booked it', async () => {
    const ctx = await setup();
    await book(ctx, ctx.room.id, ctx.pro.member.id, { startTime: '14:00', endTime: '15:00' });
    await expect(checkInMember(ctx.db, ctx.pro.member, ctx.room.id, at('11:00'))).rejects.toThrow(/from 14:00 to 15:00/);
    await expect(checkInMember(ctx.db, ctx.basic.member, ctx.room.id, at('14:10'))).rejects.toThrow(/not booked by this member/);
    await expect(checkInMember(ctx.db, ctx.pro.member, ctx.room.id, at('15:00'))).rejects.toThrow(/from 14:00 to 15:00/);
    const row = await checkInMember(ctx.db, ctx.pro.member, ctx.room.id, at('13:40'));
    expect(row.resourceId).toBe(ctx.room.id);
  });

  it('lets several people sit in one booked room, and each room booking is theirs alone', async () => {
    const ctx = await setup();
    await book(ctx, ctx.room.id, ctx.pro.member.id, { startTime: '10:00', endTime: '11:00' });
    await book(ctx, ctx.desk.id, ctx.basic.member.id);
    // The room booker is not held to a desk; the desk booker cannot walk into someone else's room.
    expect((await checkInMember(ctx.db, ctx.pro.member, ctx.room.id, at('10:05'))).resourceId).toBe(ctx.room.id);
    await expect(checkInMember(ctx.db, ctx.basic.member, ctx.room.id, at('10:10'))).rejects.toThrow(/not booked by this member/);
  });

  it('refuses check-in on a holiday, on a closed weekday, and outside opening hours', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    await expect(checkInMember(ctx.db, ctx.pro.member, null, at('07:00'))).rejects.toThrow(/open 08:00 to 20:00/);
    await expect(checkInMember(ctx.db, ctx.pro.member, null, at('20:00'))).rejects.toThrow(/open 08:00 to 20:00/);
    const ok = await checkInMember(ctx.db, ctx.pro.member, null, at('08:00'));
    await ctx.db.delete(await import('../src/db/schema.js').then((m) => m.attendance)).run();
    expect(ok.resourceId).toBeNull();

    await owner.post(`/api/locations/${ctx.loc.id}/holidays`).send({ date: today, name: 'Founders Day' }).expect(201);
    await expect(checkInMember(ctx.db, ctx.pro.member, null, at('10:00'))).rejects.toThrow(/Founders Day/);
  });

  it('refuses check-in on a closed weekday', async () => {
    const ctx = await setup();
    await ctx.db.update(locations).set({ closedWeekdays: String(new Date(`${today}T00:00:00Z`).getUTCDay()) }).where(eq(locations.id, ctx.loc.id)).run();
    await expect(checkInMember(ctx.db, ctx.pro.member, null, at('10:00'))).rejects.toThrow(/Closed on this day of the week/);
  });

  it('lets a member with a space of their own in at any hour', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'manager@test.dev');
    const c = await staff.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.pro.member.id, resourceId: ctx.dedicated.id, startDate: today }).expect(201);
    await staff.post(`/api/contracts/${c.body.id}/activate`).expect(200);
    expect((await checkInMember(ctx.db, ctx.pro.member, ctx.dedicated.id, at('23:00'))).resourceId).toBe(ctx.dedicated.id);
    await expect(checkInMember(ctx.db, ctx.basic.member, null, at('23:00'))).rejects.toThrow(/open 08:00 to 20:00/);
  });

  it('keeps a space that has its own hours to them', async () => {
    const ctx = await setup();
    await ctx.db.update(resources).set({ openTime: '10:00', closeTime: '12:00' }).where(eq(resources.id, ctx.desk.id)).run();
    await expect(checkInMember(ctx.db, ctx.pro.member, ctx.desk.id, at('09:00'))).rejects.toThrow(/Desk 1 is open 10:00 to 12:00/);
    expect((await checkInMember(ctx.db, ctx.pro.member, ctx.desk.id, at('10:30'))).resourceId).toBe(ctx.desk.id);
  });

  it('moves a member to another hot desk when the one they booked is out of service', async () => {
    const ctx = await setup();
    const b = await book(ctx, ctx.desk.id, ctx.pro.member.id);
    await ctx.db.update(resources).set({ status: 'maintenance' }).where(eq(resources.id, ctx.desk.id)).run();
    // Without choosing, they are told what to do rather than being stuck.
    await expect(checkInMember(ctx.db, ctx.pro.member, null, at('09:00'))).rejects.toThrow(/not available \(maintenance\).*another hot desk/);
    await expect(checkInMember(ctx.db, ctx.pro.member, ctx.dedicated.id, at('09:00'))).rejects.toThrow(/Move them to another hot desk/);
    const row = await checkInMember(ctx.db, ctx.pro.member, ctx.desk2.id, at('09:00'));
    expect(row.resourceId).toBe(ctx.desk2.id);
    const moved = (await ctx.db.select().from(bookings).where(eq(bookings.id, b.id)).get())!;
    expect(moved.resourceId).toBe(ctx.desk2.id);
    expect(moved.checkedInAt).toBeTruthy();
  });

  it('will not move a member onto a desk someone else has booked', async () => {
    const ctx = await setup();
    await book(ctx, ctx.desk.id, ctx.pro.member.id);
    await book(ctx, ctx.desk2.id, ctx.basic.member.id);
    await ctx.db.update(resources).set({ status: 'maintenance' }).where(eq(resources.id, ctx.desk.id)).run();
    await expect(checkInMember(ctx.db, ctx.pro.member, ctx.desk2.id, at('09:00'))).rejects.toThrow(/booked today by basic/);
  });

  it('refuses a space rented to another member, whatever its kind', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'manager@test.dev');
    const c = await staff.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.pro.member.id, resourceId: ctx.desk.id, startDate: today }).expect(201);
    await staff.post(`/api/contracts/${c.body.id}/activate`).expect(200);
    await expect(checkInMember(ctx.db, ctx.basic.member, ctx.desk.id, at('10:00'))).rejects.toThrow(/assigned to pro/);
    expect((await checkInMember(ctx.db, ctx.pro.member, ctx.desk.id, at('10:00'))).resourceId).toBe(ctx.desk.id);
  });
});
