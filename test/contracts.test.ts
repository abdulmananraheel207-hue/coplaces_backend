import { describe, expect, it } from 'vitest';
import { login, setup, TZ, inDays } from './helpers.js';
import { addDays, todayIn } from '../src/lib/time.js';

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

describe('booking rules', () => {
  it('refuses bookings on a holiday and on a closed weekday, and says why', async () => {
    const { app, loc, room, desk, pro } = await setup();
    const owner = await login(app, 'owner@test.dev');
    const day = inDays(3);
    const book = (date: string, resourceId = room.id) =>
      owner.post('/api/bookings').send({ resourceId, memberId: pro.member.id, date, startTime: '10:00', endTime: '11:00' });

    await owner.post(`/api/locations/${loc.id}/holidays`).send({ date: day, name: 'Founders Day' }).expect(201);
    const blocked = await book(day).expect(400);
    expect(blocked.body.error).toMatch(/Founders Day/);
    await owner.post('/api/bookings').send({ resourceId: desk.id, memberId: pro.member.id, date: day }).expect(400);

    const schedule = await owner.get(`/api/bookings/schedule?locationId=${loc.id}&date=${day}`).expect(200);
    expect(schedule.body.closed).toMatch(/Founders Day/);
    expect((await owner.get(`/api/bookings/schedule?locationId=${loc.id}&date=${inDays(4)}`)).body.closed).toBeNull();

    await book(inDays(4)).expect(201);
    const wd = weekday(inDays(5));
    await owner.patch(`/api/locations/${loc.id}`).send({ closedWeekdays: String(wd) }).expect(200);
    await book(inDays(5)).expect(400);
    await book(inDays(5 + 1)).expect(201);
  });

  it('lets only managers and owners change holidays, and keeps them within their location', async () => {
    const { app, loc, other } = await setup();
    const owner = await login(app, 'owner@test.dev');
    const desk = await login(app, 'desk@test.dev');
    const member = await login(app, 'pro@test.dev');
    await desk.post(`/api/locations/${loc.id}/holidays`).send({ date: inDays(9) }).expect(403);
    const h = await owner.post(`/api/locations/${loc.id}/holidays`).send({ date: inDays(9), name: 'Eid' }).expect(201);
    await owner.post(`/api/locations/${loc.id}/holidays`).send({ date: inDays(9) }).expect(409);
    expect((await member.get(`/api/locations/${loc.id}/holidays`).expect(200)).body).toHaveLength(1);
    await desk.get(`/api/locations/${other.id}/holidays`).expect(403);
    await owner.delete(`/api/locations/${other.id}/holidays/${h.body.id}`).expect(404);
    await owner.delete(`/api/locations/${loc.id}/holidays/${h.body.id}`).expect(204);
  });

  it('rejects a bad weekday list', async () => {
    const { app, loc } = await setup();
    const owner = await login(app, 'owner@test.dev');
    await owner.patch(`/api/locations/${loc.id}`).send({ closedWeekdays: '7' }).expect(400);
    await owner.patch(`/api/locations/${loc.id}`).send({ closedWeekdays: '0,6' }).expect(200);
  });
});

describe('contracts', () => {
  const today = todayIn(TZ);

  it('runs a contract from draft to active to ended, assigning and freeing the space', async () => {
    const { app, loc, dedicated, pro } = await setup();
    const staff = await login(app, 'manager@test.dev');
    const c = await staff
      .post('/api/contracts')
      .send({ locationId: loc.id, memberId: pro.member.id, resourceId: dedicated.id, startDate: today, rentCents: 90_000, depositCents: 180_000 })
      .expect(201);
    expect(c.body.status).toBe('draft');
    expect((await staff.get(`/api/assignments?locationId=${loc.id}`)).body).toHaveLength(0);

    const active = await staff.post(`/api/contracts/${c.body.id}/activate`).expect(200);
    expect(active.body.status).toBe('active');
    const assigned = (await staff.get(`/api/assignments?locationId=${loc.id}`)).body;
    expect(assigned).toHaveLength(1);
    expect(assigned[0].memberId).toBe(pro.member.id);
    await staff.post(`/api/contracts/${c.body.id}/activate`).expect(409);

    // Another contract for the same space cannot start while it is taken.
    const clash = await staff.post('/api/contracts').send({ locationId: loc.id, memberId: pro.member.id, resourceId: dedicated.id, startDate: today }).expect(201);
    await staff.post(`/api/contracts/${clash.body.id}/activate`).expect(409);

    const ended = await staff.post(`/api/contracts/${c.body.id}/end`).send({}).expect(200);
    expect(ended.body.status).toBe('ended');
    expect(ended.body.endDate).toBe(today);
    // Ended today means free today: the desk shows as vacant straight away and can be rented again.
    expect((await staff.get(`/api/assignments?locationId=${loc.id}`)).body).toHaveLength(0);
    const list = (await staff.get(`/api/resources?locationId=${loc.id}`)).body;
    expect(list.find((r: { id: string }) => r.id === dedicated.id).occupied).toBe(false);
    await staff.post(`/api/contracts/${clash.body.id}/activate`).expect(200);
    await staff.post(`/api/contracts/${c.body.id}/end`).send({}).expect(409);
  });

  it('tracks the deposit: received, then refunded in part once the contract has ended', async () => {
    const { app, loc, dedicated, pro } = await setup();
    const staff = await login(app, 'manager@test.dev');
    const c = await staff.post('/api/contracts').send({ locationId: loc.id, memberId: pro.member.id, resourceId: dedicated.id, startDate: today, depositCents: 100_000 }).expect(201);
    await staff.post(`/api/contracts/${c.body.id}/deposit`).send({ action: 'refund' }).expect(409);
    const held = await staff.post(`/api/contracts/${c.body.id}/deposit`).send({ action: 'receive' }).expect(200);
    expect(held.body.depositStatus).toBe('held');
    await staff.post(`/api/contracts/${c.body.id}/deposit`).send({ action: 'receive' }).expect(409);

    await staff.post(`/api/contracts/${c.body.id}/activate`).expect(200);
    await staff.post(`/api/contracts/${c.body.id}/deposit`).send({ action: 'refund' }).expect(409); // still running
    await staff.post(`/api/contracts/${c.body.id}/end`).send({}).expect(200);
    await staff.post(`/api/contracts/${c.body.id}/deposit`).send({ action: 'refund', returnedCents: 150_000 }).expect(400);
    const done = await staff.post(`/api/contracts/${c.body.id}/deposit`).send({ action: 'refund', returnedCents: 80_000 }).expect(200);
    expect(done.body).toMatchObject({ depositStatus: 'refunded', depositReturnedCents: 80_000 });
  });

  it('only lets a draft be edited or cancelled, and lets any space be rented', async () => {
    const { app, loc, room, dedicated, pro } = await setup();
    const staff = await login(app, 'manager@test.dev');
    await staff.post('/api/contracts').send({ locationId: loc.id, memberId: pro.member.id, resourceId: room.id, startDate: today }).expect(201);
    const c = await staff.post('/api/contracts').send({ locationId: loc.id, memberId: pro.member.id, resourceId: dedicated.id, startDate: today }).expect(201);
    await staff.patch(`/api/contracts/${c.body.id}`).send({ rentCents: 5 }).expect(200);
    await staff.post(`/api/contracts/${c.body.id}/activate`).expect(200);
    await staff.patch(`/api/contracts/${c.body.id}`).send({ rentCents: 6 }).expect(409);
    await staff.patch(`/api/contracts/${c.body.id}`).send({ notes: 'ok' }).expect(200);
    await staff.post(`/api/contracts/${c.body.id}/cancel`).expect(409);
    const d = await staff.post('/api/contracts').send({ locationId: loc.id, memberId: pro.member.id, startDate: today }).expect(201);
    expect((await staff.post(`/api/contracts/${d.body.id}/cancel`).expect(200)).body.status).toBe('cancelled');
  });

  it('keeps contracts away from members and other tenants', async () => {
    const { app, loc, pro } = await setup();
    const member = await login(app, 'pro@test.dev');
    await member.get(`/api/contracts?locationId=${loc.id}`).expect(403);
    await (await login(app, 'desk@test.dev')).get(`/api/contracts?locationId=${loc.id}`).expect(403);
    const hive = await login(app, 'owner@hive.dev');
    await hive.get(`/api/contracts?locationId=${loc.id}`).expect(403);
    await hive.post('/api/contracts').send({ locationId: loc.id, memberId: pro.member.id, startDate: today }).expect(403);
  });
});

describe('announcements', () => {
  it('shows members only what is live, and staff everything with its state', async () => {
    const { app, loc } = await setup();
    const owner = await login(app, 'owner@test.dev');
    const member = await login(app, 'pro@test.dev');
    const make = (body: object) => owner.post('/api/announcements').send({ locationId: loc.id, ...body }).expect(201);

    await make({ title: 'Draft one' });
    await make({ title: 'Live one', draft: false });
    await make({ title: 'Later one', draft: false, publishAt: new Date(Date.now() + 86_400_000).toISOString() });
    await make({ title: 'Earlier one', draft: false, publishAt: new Date(Date.now() - 86_400_000).toISOString() });

    const staffView = (await owner.get(`/api/announcements?locationId=${loc.id}`)).body as { title: string; state: string }[];
    expect(Object.fromEntries(staffView.map((a) => [a.title, a.state]))).toEqual({
      'Draft one': 'draft',
      'Live one': 'live',
      'Later one': 'scheduled',
      'Earlier one': 'live',
    });
    const memberView = (await member.get(`/api/announcements?locationId=${loc.id}`)).body as { title: string }[];
    expect(memberView.map((a) => a.title).sort()).toEqual(['Earlier one', 'Live one']);
  });

  it('is managed by managers and owners only, within their own location', async () => {
    const { app, loc } = await setup();
    const owner = await login(app, 'owner@test.dev');
    const a = await owner.post('/api/announcements').send({ locationId: loc.id, title: 'Hi' }).expect(201);
    await (await login(app, 'desk@test.dev')).post('/api/announcements').send({ locationId: loc.id, title: 'Nope' }).expect(403);
    await (await login(app, 'pro@test.dev')).patch(`/api/announcements/${a.body.id}`).send({ draft: false }).expect(403);
    await (await login(app, 'owner@hive.dev')).delete(`/api/announcements/${a.body.id}`).expect(403);
    const edited = await owner.patch(`/api/announcements/${a.body.id}`).send({ draft: false, body: 'Welcome' }).expect(200);
    expect(edited.body.state).toBe('live');
    await owner.delete(`/api/announcements/${a.body.id}`).expect(204);
    await owner.delete(`/api/announcements/${a.body.id}`).expect(404);
  });
});
