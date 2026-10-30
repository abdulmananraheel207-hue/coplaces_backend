import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bookings } from '../src/db/schema.js';
import { inDays, login, setup, tomorrow } from './helpers.js';

describe('room bookings', () => {
  it('books a room and rejects overlaps but allows back-to-back', async () => {
    const { app, room, basic } = await setup();
    const desk = await login(app, 'desk@test.dev');
    const base = { resourceId: room.id, memberId: basic.member.id, date: tomorrow() };

    await desk.post('/api/bookings').send({ ...base, startTime: '10:00', endTime: '11:00' }).expect(201);
    await desk.post('/api/bookings').send({ ...base, startTime: '10:30', endTime: '11:30' }).expect(409);
    await desk.post('/api/bookings').send({ ...base, startTime: '09:00', endTime: '10:15' }).expect(409);
    await desk.post('/api/bookings').send({ ...base, startTime: '10:00', endTime: '11:00' }).expect(409);
    await desk.post('/api/bookings').send({ ...base, startTime: '11:00', endTime: '12:00' }).expect(201);
    await desk.post('/api/bookings').send({ ...base, startTime: '09:00', endTime: '10:00' }).expect(201);
  });

  it('validates hours and step size', async () => {
    const { app, room, basic } = await setup();
    const desk = await login(app, 'desk@test.dev');
    const base = { resourceId: room.id, memberId: basic.member.id, date: tomorrow() };
    await desk.post('/api/bookings').send({ ...base, startTime: '07:00', endTime: '08:30' }).expect(400);
    await desk.post('/api/bookings').send({ ...base, startTime: '19:00', endTime: '21:00' }).expect(400);
    await desk.post('/api/bookings').send({ ...base, startTime: '10:00', endTime: '10:20' }).expect(400);
    await desk.post('/api/bookings').send({ ...base, startTime: '11:00', endTime: '10:00' }).expect(400);
    await desk.post('/api/bookings').send({ ...base }).expect(400);
    await desk.post('/api/bookings').send({ ...base, date: 'nope', startTime: '10:00', endTime: '11:00' }).expect(400);
  });

  it('rejects bookings in the past', async () => {
    const { app, room, basic } = await setup();
    const desk = await login(app, 'desk@test.dev');
    await desk
      .post('/api/bookings')
      .send({ resourceId: room.id, memberId: basic.member.id, date: inDays(-1), startTime: '10:00', endTime: '11:00' })
      .expect(400);
  });

  it('prices by the hour and applies the included monthly minutes', async () => {
    const { app, room, pro, basic } = await setup();
    const desk = await login(app, 'desk@test.dev');

    // Basic plan has no allowance: 90 min at $60/h = $90
    const paid = await desk
      .post('/api/bookings')
      .send({ resourceId: room.id, memberId: basic.member.id, date: tomorrow(), startTime: '10:00', endTime: '11:30' })
      .expect(201);
    expect(paid.body.priceCents).toBe(9_000);
    expect(paid.body.billableMinutes).toBe(90);

    // Pro plan includes 60 min: a 90 min booking bills only 30 min
    const first = await desk
      .post('/api/bookings')
      .send({ resourceId: room.id, memberId: pro.member.id, date: tomorrow(), startTime: '13:00', endTime: '14:30' })
      .expect(201);
    expect(first.body.billableMinutes).toBe(30);
    expect(first.body.priceCents).toBe(3_000);

    // Allowance is spent, so the next one is fully billed
    const second = await desk
      .post('/api/bookings')
      .send({ resourceId: room.id, memberId: pro.member.id, date: tomorrow(), startTime: '15:00', endTime: '16:00' })
      .expect(201);
    expect(second.body.priceCents).toBe(6_000);

    // Cancelling the first returns its free minutes to the pool
    await desk.post(`/api/bookings/${first.body.id}/cancel`).expect(200);
    const third = await desk
      .post('/api/bookings')
      .send({ resourceId: room.id, memberId: pro.member.id, date: tomorrow(), startTime: '17:00', endTime: '17:45' })
      .expect(201);
    expect(third.body.priceCents).toBe(0);
  });

  it('frees the slot when a booking is cancelled', async () => {
    const { app, room, basic } = await setup();
    const desk = await login(app, 'desk@test.dev');
    const body = { resourceId: room.id, memberId: basic.member.id, date: tomorrow(), startTime: '10:00', endTime: '11:00' };
    const b = await desk.post('/api/bookings').send(body).expect(201);
    await desk.post(`/api/bookings/${b.body.id}/cancel`).expect(200);
    await desk.post(`/api/bookings/${b.body.id}/cancel`).expect(409);
    await desk.post('/api/bookings').send(body).expect(201);
  });

  it('stops members booking anything themselves, and hides other members on the schedule', async () => {
    const { app, loc, room, desk, basic } = await setup();
    const agent = await login(app, 'basic@test.dev');
    // Rooms are asked for, desks and offices come with a plan: a member books neither directly.
    await agent.post('/api/bookings').send({ resourceId: room.id, date: tomorrow(), startTime: '10:00', endTime: '11:00' }).expect(403);
    await agent.post('/api/bookings').send({ resourceId: desk.id, date: tomorrow() }).expect(403);
    // They may see what a room would cost, but not a desk's.
    await agent.post('/api/bookings/quote').send({ resourceId: room.id, date: tomorrow(), startTime: '10:00', endTime: '11:00' }).expect(200);
    await agent.post('/api/bookings/quote').send({ resourceId: desk.id, date: tomorrow() }).expect(403);

    const staff = await login(app, 'desk@test.dev');
    const b = await staff.post('/api/bookings').send({ resourceId: room.id, memberId: basic.member.id, date: tomorrow(), startTime: '10:00', endTime: '11:00' }).expect(201);
    expect(b.body.memberId).toBe(basic.member.id);

    const other = await login(app, 'pro@test.dev');
    const sched = await other.get(`/api/bookings/schedule?locationId=${loc.id}&date=${tomorrow()}`).expect(200);
    expect(sched.body.bookings).toHaveLength(1);
    expect(sched.body.bookings[0].memberName).toBeUndefined();
    expect(sched.body.bookings[0].mine).toBe(false);

    const staffSched = await staff.get(`/api/bookings/schedule?locationId=${loc.id}&date=${tomorrow()}`).expect(200);
    expect(staffSched.body.bookings[0].memberName).toBe('basic');

    await other.post(`/api/bookings/${b.body.id}/cancel`).expect(403);
    await agent.post(`/api/bookings/${b.body.id}/cancel`).expect(200); // they can still cancel their own
  });

  it('refuses to cancel an invoiced booking', async () => {
    const { app, db, room, basic } = await setup();
    const desk = await login(app, 'desk@test.dev');
    const b = await desk
      .post('/api/bookings')
      .send({ resourceId: room.id, memberId: basic.member.id, date: tomorrow(), startTime: '10:00', endTime: '11:00' })
      .expect(201);
    await db.update(bookings).set({ invoiceId: 'some-invoice' }).where(eq(bookings.id, b.body.id)).run();
    await desk.post(`/api/bookings/${b.body.id}/cancel`).expect(409);
  });
});

describe('desk bookings and assignments', () => {
  it('books hot desks once per member per day, free on plans that include them', async () => {
    const { app, desk, desk2, pro, basic } = await setup();
    const staff = await login(app, 'desk@test.dev');
    const day = tomorrow();

    const free = await staff.post('/api/bookings').send({ resourceId: desk.id, memberId: pro.member.id, date: day }).expect(201);
    expect(free.body.priceCents).toBe(0);
    await staff.post('/api/bookings').send({ resourceId: desk2.id, memberId: pro.member.id, date: day }).expect(409);
    await staff.post('/api/bookings').send({ resourceId: desk.id, memberId: basic.member.id, date: day }).expect(409);

    const paid = await staff.post('/api/bookings').send({ resourceId: desk2.id, memberId: basic.member.id, date: day }).expect(201);
    expect(paid.body.priceCents).toBe(2_500);
  });

  it('does not allow booking dedicated desks, and prevents overlapping assignments', async () => {
    const { app, dedicated, pro, basic } = await setup();
    const staff = await login(app, 'desk@test.dev');
    await staff.post('/api/bookings').send({ resourceId: dedicated.id, memberId: pro.member.id, date: tomorrow() }).expect(400);

    await staff
      .post('/api/assignments')
      .send({ resourceId: dedicated.id, memberId: pro.member.id, startDate: inDays(0), endDate: inDays(30) })
      .expect(201);
    await staff.post('/api/assignments').send({ resourceId: dedicated.id, memberId: basic.member.id, startDate: inDays(10) }).expect(409);
    await staff
      .post('/api/assignments')
      .send({ resourceId: dedicated.id, memberId: basic.member.id, startDate: inDays(31) })
      .expect(201);
  });

  it('blocks maintenance resources', async () => {
    const { app, db, room, basic } = await setup();
    const { resources } = await import('../src/db/schema.js');
    await db.update(resources).set({ status: 'maintenance' }).where(eq(resources.id, room.id)).run();
    const staff = await login(app, 'desk@test.dev');
    await staff
      .post('/api/bookings')
      .send({ resourceId: room.id, memberId: basic.member.id, date: tomorrow(), startTime: '10:00', endTime: '11:00' })
      .expect(409);
  });
});
