import { describe, expect, it } from 'vitest';
import { checkInMember } from '../src/services/checkin.js';
import { addDays, todayIn, zonedToUtc } from '../src/lib/time.js';
import { login, setupOpen as setup, TZ } from './helpers.js';

const today = () => todayIn(TZ);
const at = (time: string) => zonedToUtc(today(), time, TZ);

/** A plan with one shift on Desk 1, and a new member on it starting today. */
async function member(ctx: Awaited<ReturnType<typeof setup>>, startTime: string, endTime: string, email = 'shift@x.dev') {
  const owner = await login(ctx.app, 'owner@test.dev');
  const plan = (await owner.post('/api/plans').send({ locationId: ctx.loc.id, name: `Plan ${email}`, interval: 'month' }).expect(201)).body;
  const shift = (await owner.post('/api/shifts').send({ locationId: ctx.loc.id, planId: plan.id, name: 'Shift', startTime, endTime, priceCents: 100_000, spaceIds: [ctx.desk.id] }).expect(201)).body;
  const made = await owner.post('/api/members').send({ locationId: ctx.loc.id, name: 'Shift Person', email, planId: plan.id, status: 'active', password: 'password123', startDate: today(), shiftIds: [shift.id], deskIds: [ctx.desk.id] }).expect(201);
  return { owner, plan, shift, member: made.body as { id: string; locationId: string; userId: string } };
}

describe('check-in needs a booking or a plan with shifts', () => {
  it('refuses a member with no plan, no shifts and no booking, at the front desk and from their own portal', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const bare = (await owner.post('/api/members').send({ locationId: ctx.loc.id, name: 'Bare', email: 'bare@x.dev', status: 'active', password: 'password123' }).expect(201)).body;
    const staff = await login(ctx.app, 'desk@test.dev');
    const r = await staff.post('/api/attendance/check-in').send({ memberId: bare.id }).expect(409);
    expect(JSON.stringify(r.body)).toMatch(/no plan, shifts or booking/);
    await (await login(ctx.app, 'bare@x.dev')).post('/api/attendance/check-in').send({}).expect(409);
    // Choosing a space does not get them in either.
    await staff.post('/api/attendance/check-in').send({ memberId: bare.id, resourceId: ctx.desk2.id }).expect(409);
  });

  it('refuses a member whose plan has no shifts given to them, and says so', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'desk@test.dev');
    const r = await staff.post('/api/attendance/check-in').send({ memberId: ctx.basic.member.id }).expect(409); // has a plan, no shifts
    expect(JSON.stringify(r.body)).toMatch(/plan but no shifts/);
  });

  it('lets a member with a plan shift in without choosing where, and the front desk sees which desk', async () => {
    const ctx = await setup();
    const m = await member(ctx, '00:00', '23:45');
    const staff = await login(ctx.app, 'desk@test.dev');
    const row = await staff.post('/api/attendance/check-in').send({ memberId: m.member.id }).expect(201);
    expect(row.body.resourceId).toBe(ctx.desk.id);
    const present = (await staff.get(`/api/attendance?locationId=${ctx.loc.id}&open=1`).expect(200)).body;
    expect(present).toHaveLength(1);
    expect(present[0]).toMatchObject({ memberName: 'Shift Person', resourceName: 'Desk 1' });
  });

  it('shows a member who checks in from their own portal the same way', async () => {
    const ctx = await setup();
    await member(ctx, '00:00', '23:45');
    const me = await login(ctx.app, 'shift@x.dev');
    const row = await me.post('/api/attendance/check-in').send({}).expect(201);
    expect(row.body.resourceId).toBe(ctx.desk.id);
    const staff = await login(ctx.app, 'desk@test.dev');
    const present = (await staff.get(`/api/attendance?locationId=${ctx.loc.id}&open=1`).expect(200)).body;
    expect(present[0]).toMatchObject({ memberName: 'Shift Person', resourceName: 'Desk 1' });
  });

  it('holds them to their shift: from half an hour before it starts until it ends', async () => {
    const ctx = await setup();
    const m = await member(ctx, '09:00', '12:00');
    await expect(checkInMember(ctx.db, m.member, null, at('07:00'))).rejects.toThrow(/next booking today is Desk 1 from 09:00 to 12:00.*from 08:30/);
    await expect(checkInMember(ctx.db, m.member, null, at('12:00'))).rejects.toThrow(/was from 09:00 to 12:00/);
    const row = await checkInMember(ctx.db, m.member, null, at('08:35'));
    expect(row.resourceId).toBe(ctx.desk.id);
  });

  it('says why when the plan has run out, or has no shifts', async () => {
    const ctx = await setup();
    const m = await member(ctx, '09:00', '12:00');
    // Their period ended yesterday and they have nothing booked today.
    const { members, bookings } = await import('../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    await ctx.db.delete(bookings).where(eq(bookings.memberId, m.member.id)).run();
    await ctx.db.update(members).set({ planEnd: addDays(today(), -1) }).where(eq(members.id, m.member.id)).run();
    await expect(checkInMember(ctx.db, m.member, null, at('10:00'))).rejects.toThrow(/plan ended on .*Renew it/);

    // A plan without any shifts given to the member.
    await ctx.db.update(members).set({ planEnd: null, planId: m.plan.id }).where(eq(members.id, ctx.basic.member.id)).run();
    await expect(checkInMember(ctx.db, ctx.basic.member, null, at('10:00'))).rejects.toThrow(/plan but no shifts/);
  });

  it('still lets someone with a space rented to them in', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'manager@test.dev');
    const c = await staff.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.pro.member.id, resourceId: ctx.dedicated.id, startDate: today() }).expect(201);
    await staff.post(`/api/contracts/${c.body.id}/activate`).expect(200);
    const row = await checkInMember(ctx.db, ctx.pro.member, null, at('10:00'));
    expect(row.resourceId).toBe(ctx.dedicated.id); // and the front desk shows their desk
  });
});
