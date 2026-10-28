import { describe, expect, it } from 'vitest';
import { addDays, todayIn, zonedToUtc } from '../src/lib/time.js';
import { eq } from 'drizzle-orm';
import { users } from '../src/db/schema.js';
import { createBooking } from '../src/services/bookings.js';
import { login, setupOpen as setup, TZ, tomorrow } from './helpers.js';

describe('member check-in', () => {
  it('checks members in and out, once at a time', async () => {
    const { app, loc, basic } = await setup();
    const staff = await login(app, 'desk@test.dev');
    const inn = await staff.post('/api/attendance/check-in').send({ memberId: basic.member.id }).expect(201);
    await staff.post('/api/attendance/check-in').send({ memberId: basic.member.id }).expect(409);

    const present = await staff.get(`/api/attendance?locationId=${loc.id}&open=1`).expect(200);
    expect(present.body).toHaveLength(1);
    expect(present.body[0].memberName).toBe('basic');

    await staff.post(`/api/attendance/${inn.body.id}/check-out`).expect(200);
    await staff.post(`/api/attendance/${inn.body.id}/check-out`).expect(409);
    expect((await staff.get(`/api/attendance?locationId=${loc.id}&open=1`)).body).toHaveLength(0);
    expect((await staff.get(`/api/attendance?locationId=${loc.id}`)).body).toHaveLength(1);
    await staff.post('/api/attendance/check-in').send({ memberId: basic.member.id }).expect(201);
  });

  it('lets a member check themselves in but not someone else, and blocks inactive members', async () => {
    const { app, db, pro, basic } = await setup();
    const agent = await login(app, 'basic@test.dev');
    const row = await agent.post('/api/attendance/check-in').send({ memberId: pro.member.id }).expect(201);
    expect(row.body.memberId).toBe(basic.member.id);

    const other = await login(app, 'pro@test.dev');
    await other.post(`/api/attendance/${row.body.id}/check-out`).expect(403);
    await agent.post(`/api/attendance/${row.body.id}/check-out`).expect(200);

    const { members } = await import('../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    await db.update(members).set({ status: 'paused' }).where(eq(members.id, pro.member.id)).run();
    await other.post('/api/attendance/check-in').send({}).expect(400);
  });
});

describe('visitors', () => {
  it('runs the expected -> checked in -> checked out flow', async () => {
    const { app, loc, pro } = await setup();
    const host = await login(app, 'pro@test.dev');
    const staff = await login(app, 'desk@test.dev');
    const today = todayIn(TZ);

    const v = await host
      .post('/api/visitors')
      .send({ name: 'Ada Client', company: 'ACME', expectedDate: today, expectedTime: '14:00' })
      .expect(201);
    expect(v.body.status).toBe('expected');
    expect(v.body.hostMemberId).toBe(pro.member.id);

    await host.post(`/api/visitors/${v.body.id}/check-in`).expect(403);
    await staff.post(`/api/visitors/${v.body.id}/check-out`).expect(409);
    await staff.post(`/api/visitors/${v.body.id}/check-in`).expect(200);
    await staff.post(`/api/visitors/${v.body.id}/check-in`).expect(409);
    const out = await staff.post(`/api/visitors/${v.body.id}/check-out`).expect(200);
    expect(out.body.status).toBe('checked_out');
    expect(out.body.checkOutAt).toBeTruthy();

    const todays = await staff.get(`/api/visitors?locationId=${loc.id}&date=${today}`).expect(200);
    expect(todays.body).toHaveLength(1);
    expect(todays.body[0].hostName).toBe('pro');
  });

  it('registers walk-ins at the desk but only for staff', async () => {
    const { app, loc, basic } = await setup();
    const staff = await login(app, 'desk@test.dev');
    const walkIn = await staff
      .post('/api/visitors')
      .send({ name: 'Walk In', hostMemberId: basic.member.id, checkInNow: true })
      .expect(201);
    expect(walkIn.body.status).toBe('checked_in');
    const inside = await staff.get(`/api/visitors?locationId=${loc.id}&status=checked_in`).expect(200);
    expect(inside.body).toHaveLength(1);

    const host = await login(app, 'basic@test.dev');
    await host.post('/api/visitors').send({ name: 'Sneaky', checkInNow: true }).expect(403);
    await staff.post('/api/visitors').send({ name: 'No Host' }).expect(400);
  });

  it('shows hosts only their own visitors and lets them cancel', async () => {
    const { app, loc } = await setup();
    const a = await login(app, 'basic@test.dev');
    const b = await login(app, 'pro@test.dev');
    const mine = await a
      .post('/api/visitors')
      .send({ name: 'For Basic', expectedDate: tomorrow(), expectedTime: '10:00' })
      .expect(201);
    await b.post('/api/visitors').send({ name: 'For Pro', expectedDate: tomorrow(), expectedTime: '11:00' }).expect(201);

    const list = await a.get(`/api/visitors?locationId=${loc.id}`).expect(200);
    expect(list.body.map((v: { name: string }) => v.name)).toEqual(['For Basic']);
    await b.post(`/api/visitors/${mine.body.id}/cancel`).expect(403);
    const cancelled = await a.post(`/api/visitors/${mine.body.id}/cancel`).expect(200);
    expect(cancelled.body.status).toBe('cancelled');
    await a.post(`/api/visitors`).send({ name: 'Half', expectedDate: addDays(todayIn(TZ), 2) }).expect(400);
  });
});

describe('desk clashes between check-in and bookings', () => {
  const nine = (today: string) => zonedToUtc(today, '09:00', TZ);
  const staffUser = async (ctx: Awaited<ReturnType<typeof setup>>) => {
    const u = (await ctx.db.select().from(users).where(eq(users.email, 'desk@test.dev')).get())!;
    return { id: u.id, role: 'staff', organizationId: ctx.org.id, locationIds: [ctx.loc.id] } as never;
  };

  it('refuses to check a member in at a desk someone else booked today', async () => {
    const ctx = await setup();
    const today = todayIn(TZ);
    await createBooking(ctx.db, { resourceId: ctx.desk.id, memberId: ctx.pro.member.id, date: today, notes: '' }, await staffUser(ctx), nine(today));
    const staff = await login(ctx.app, 'desk@test.dev');
    const r = await staff.post('/api/attendance/check-in').send({ memberId: ctx.basic.member.id, resourceId: ctx.desk.id }).expect(409);
    expect(r.body.error ?? r.body.message ?? JSON.stringify(r.body)).toMatch(/booked today by pro/);
    // The booking's own member, another desk, and no desk are all fine.
    await staff.post('/api/attendance/check-in').send({ memberId: ctx.pro.member.id, resourceId: ctx.desk.id }).expect(201);
    await staff.post('/api/attendance/check-in').send({ memberId: ctx.basic.member.id, resourceId: ctx.desk2.id }).expect(201);
  });

  it('refuses a second member at a desk someone is already sitting at', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'desk@test.dev');
    const first = await staff.post('/api/attendance/check-in').send({ memberId: ctx.pro.member.id, resourceId: ctx.desk.id }).expect(201);
    await staff.post('/api/attendance/check-in').send({ memberId: ctx.basic.member.id, resourceId: ctx.desk.id }).expect(409);
    await staff.post(`/api/attendance/${first.body.id}/check-out`).expect(200);
    await staff.post('/api/attendance/check-in').send({ memberId: ctx.basic.member.id, resourceId: ctx.desk.id }).expect(201);
  });

  it('refuses to book a desk another member is checked in at, and shows it as in use', async () => {
    const ctx = await setup();
    const today = todayIn(TZ);
    const staff = await login(ctx.app, 'desk@test.dev');
    const inn = await staff.post('/api/attendance/check-in').send({ memberId: ctx.pro.member.id, resourceId: ctx.desk.id }).expect(201);

    await expect(createBooking(ctx.db, { resourceId: ctx.desk.id, memberId: ctx.basic.member.id, date: today, notes: '' }, await staffUser(ctx), nine(today))).rejects.toThrow(/in use by pro/);
    // Another day, and the sitter's own booking, are fine.
    await createBooking(ctx.db, { resourceId: ctx.desk.id, memberId: ctx.basic.member.id, date: tomorrow(), notes: '' }, await staffUser(ctx), nine(today));
    await createBooking(ctx.db, { resourceId: ctx.desk.id, memberId: ctx.pro.member.id, date: today, notes: '' }, await staffUser(ctx), nine(today));

    const sched = await staff.get(`/api/bookings/schedule?locationId=${ctx.loc.id}&date=${today}`).expect(200);
    expect(sched.body.inUse).toEqual([{ resourceId: ctx.desk.id, mine: false, memberName: 'pro' }]);
    const other = await staff.get(`/api/bookings/schedule?locationId=${ctx.loc.id}&date=${tomorrow()}`).expect(200);
    expect(other.body.inUse).toEqual([]);

    const member = await login(ctx.app, 'basic@test.dev');
    const seen = await member.get(`/api/bookings/schedule?locationId=${ctx.loc.id}&date=${today}`).expect(200);
    expect(seen.body.inUse[0].memberName).toBeUndefined();

    await staff.post(`/api/attendance/${inn.body.id}/check-out`).expect(200);
    expect((await staff.get(`/api/bookings/schedule?locationId=${ctx.loc.id}&date=${today}`)).body.inUse).toEqual([]);
  });
});
