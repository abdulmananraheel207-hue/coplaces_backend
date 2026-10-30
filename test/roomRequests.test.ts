import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { bookings, roomRequests } from '../src/db/schema.js';
import { inDays, login, setup } from './helpers.js';

const day = () => inDays(3);
const ask = (agent: Awaited<ReturnType<typeof login>>, roomId: string, startTime = '10:00', endTime = '11:00', date = day()) =>
  agent.post('/api/requests').send({ resourceId: roomId, date, startTime, endTime, notes: 'team meeting' });

describe('room requests', () => {
  it('lets a member ask for a room, and a second member sees how many are already in the queue', async () => {
    const ctx = await setup();
    const pro = await login(ctx.app, 'pro@test.dev');
    const basic = await login(ctx.app, 'basic@test.dev');
    // before anyone asks: nobody ahead
    const q = (a: typeof pro, s = '10:00', e = '11:00') => a.get(`/api/requests/queue?resourceId=${ctx.room.id}&date=${day()}&startTime=${s}&endTime=${e}`).expect(200);
    expect((await q(basic)).body.ahead).toBe(0);

    const first = await ask(pro, ctx.room.id).expect(201);
    expect(first.body).toMatchObject({ status: 'pending', ahead: 0 });
    expect((await q(basic)).body.ahead).toBe(1);
    expect((await q(basic, '10:30', '11:30')).body.ahead).toBe(1); // overlapping
    expect((await q(basic, '11:00', '12:00')).body.ahead).toBe(0); // starts when the other ends
    // and the one who is already waiting is not counted against themselves
    expect((await q(pro)).body.ahead).toBe(0);

    const second = await ask(basic, ctx.room.id, '10:30', '11:30').expect(201);
    expect(second.body.ahead).toBe(1);
    // nothing is booked until the owner says so
    expect(await ctx.db.select().from(bookings).where(eq(bookings.resourceId, ctx.room.id)).all()).toHaveLength(0);
  });

  it('shows members their own requests and the owner everyone\'s, with the queue beside each', async () => {
    const ctx = await setup();
    const pro = await login(ctx.app, 'pro@test.dev');
    const basic = await login(ctx.app, 'basic@test.dev');
    await ask(pro, ctx.room.id).expect(201);
    await ask(basic, ctx.room.id, '10:30', '11:30').expect(201);
    const mine = (await pro.get(`/api/requests?locationId=${ctx.loc.id}`).expect(200)).body;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ resourceName: 'Boardroom', status: 'pending', ahead: 1 });
    const owner = await login(ctx.app, 'owner@test.dev');
    const all = (await owner.get(`/api/requests?locationId=${ctx.loc.id}&status=pending`).expect(200)).body;
    expect(all).toHaveLength(2);
    expect(all.every((r: { ahead: number }) => r.ahead === 1)).toBe(true);
  });

  it('turns an approved request into a booking and marks the other asks for that time as taken', async () => {
    const ctx = await setup();
    const pro = await login(ctx.app, 'pro@test.dev');
    const basic = await login(ctx.app, 'basic@test.dev');
    const a = (await ask(pro, ctx.room.id).expect(201)).body;
    const b = (await ask(basic, ctx.room.id, '10:30', '11:30').expect(201)).body;
    const c = (await ask(basic, ctx.room.id, '14:00', '15:00').expect(201)).body;
    const owner = await login(ctx.app, 'owner@test.dev');

    const done = await owner.post(`/api/requests/${b.id}/approve`).expect(200);
    expect(done.body.status).toBe('approved');
    const booking = (await ctx.db.select().from(bookings).where(eq(bookings.id, done.body.bookingId)).get())!;
    expect(booking).toMatchObject({ memberId: ctx.basic.member.id, resourceId: ctx.room.id, status: 'confirmed' });
    expect(booking.priceCents).toBe(6_000); // the room's usual rate for an hour

    const rows = Object.fromEntries((await ctx.db.select().from(roomRequests).all()).map((r) => [r.id, r]));
    expect(rows[a.id]!.status).toBe('taken'); // overlaps the approved time
    expect(rows[a.id]!.reason).toMatch(/approved/);
    expect(rows[c.id]!.status).toBe('pending'); // a different time is untouched
    await owner.post(`/api/requests/${a.id}/approve`).expect(409);
  });

  it('lets the owner reject with a reason, and the member see it; and the member cancel their own', async () => {
    const ctx = await setup();
    const pro = await login(ctx.app, 'pro@test.dev');
    const basic = await login(ctx.app, 'basic@test.dev');
    const a = (await ask(pro, ctx.room.id).expect(201)).body;
    const owner = await login(ctx.app, 'owner@test.dev');
    await owner.post(`/api/requests/${a.id}/reject`).send({ reason: 'Maintenance that day' }).expect(200);
    const seen = (await pro.get(`/api/requests?locationId=${ctx.loc.id}`).expect(200)).body[0];
    expect(seen).toMatchObject({ status: 'rejected', reason: 'Maintenance that day' });
    await owner.post(`/api/requests/${a.id}/reject`).send({}).expect(409);

    const b = (await ask(basic, ctx.room.id, '12:00', '13:00').expect(201)).body;
    await pro.post(`/api/requests/${b.id}/cancel`).expect(403); // not theirs
    await basic.post(`/api/requests/${b.id}/cancel`).expect(200);
    await basic.post(`/api/requests/${b.id}/cancel`).expect(409);
    await basic.post(`/api/requests/${b.id}/approve`).expect(403); // members decide nothing
  });

  it('refuses what a booking would refuse: desks, offices, a taken time, a repeat ask, odd times', async () => {
    const ctx = await setup();
    const pro = await login(ctx.app, 'pro@test.dev');
    await ask(pro, ctx.desk.id).expect(400); // desks come with a plan
    await ask(pro, ctx.dedicated.id).expect(400);
    await ask(pro, ctx.room.id, '10:00', '10:10').expect(400); // not in 15 minute steps
    await ask(pro, ctx.room.id, '11:00', '10:00').expect(400);
    await ask(pro, ctx.room.id, '10:00', '11:00', inDays(-1)).expect(400); // already gone
    await ask(pro, ctx.room.id).expect(201);
    await ask(pro, ctx.room.id, '10:30', '11:30').expect(409); // already asked for that time

    const staff = await login(ctx.app, 'desk@test.dev');
    await staff.post('/api/bookings').send({ resourceId: ctx.room.id, memberId: ctx.basic.member.id, date: day(), startTime: '15:00', endTime: '16:00' }).expect(201);
    await ask(pro, ctx.room.id, '15:00', '16:00').expect(409); // booked already
    await ask(staff, ctx.room.id).expect(403); // staff book directly
  });

  it('lets the front desk book a room for a member straight away, and keeps other locations out', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'desk@test.dev');
    await staff.post('/api/bookings').send({ resourceId: ctx.room.id, memberId: ctx.pro.member.id, date: day(), startTime: '10:00', endTime: '11:00' }).expect(201);
    const hive = await login(ctx.app, 'owner@hive.dev');
    await ask(hive, ctx.room.id).expect(403);
    await hive.get(`/api/requests/queue?resourceId=${ctx.room.id}&date=${day()}&startTime=10:00&endTime=11:00`).expect(403);
    await hive.post('/api/requests/none/approve').expect(404);
  });
});
