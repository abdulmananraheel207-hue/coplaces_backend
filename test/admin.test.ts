import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { login, PASSWORD, setup } from './helpers.js';

describe('locations', () => {
  it('lets only owners create and edit locations, and validates them', async () => {
    const { app, loc } = await setup();
    const owner = await login(app, 'owner@test.dev');
    const manager = await login(app, 'manager@test.dev');
    const body = { name: 'Lakeside', code: 'lks', timezone: 'Europe/Paris', openTime: '09:00', closeTime: '18:00' };

    await manager.post('/api/locations').send(body).expect(403);
    const created = await owner.post('/api/locations').send(body).expect(201);
    expect(created.body.code).toBe('LKS');
    expect(created.body.currency).toBe('PKR');

    await owner.post('/api/locations').send({ ...body, name: 'Dup' }).expect(409);
    await owner.post('/api/locations').send({ ...body, code: 'ZZ', timezone: 'Mars/Olympus' }).expect(400);
    await owner.post('/api/locations').send({ ...body, code: 'ZZ', openTime: '18:00', closeTime: '09:00' }).expect(400);

    await owner.patch(`/api/locations/${loc.id}`).send({ taxRateBps: 500 }).expect(200);
    await manager.patch(`/api/locations/${loc.id}`).send({ taxRateBps: 0 }).expect(403);

    // A new location shows up for the owner straight away.
    const me = await owner.get('/api/auth/me').expect(200);
    expect(me.body.locations.map((l: { code: string }) => l.code)).toEqual(['DTN', 'LKS', 'UPT']);
  });
});

describe('team management', () => {
  it('creates staff with a temporary password scoped to chosen locations', async () => {
    const { app, loc, other } = await setup();
    const owner = await login(app, 'owner@test.dev');

    await owner.post('/api/staff').send({ name: 'No Loc', email: 'x@test.dev', role: 'staff', locationIds: [] }).expect(400);
    await owner.post('/api/staff').send({ name: 'Bad Loc', email: 'x@test.dev', role: 'staff', locationIds: ['nope'] }).expect(400);
    await owner.post('/api/staff').send({ name: 'Boss', email: 'boss@test.dev', role: 'owner', locationIds: [loc.id] }).expect(400);

    const created = await owner
      .post('/api/staff')
      .send({ name: 'New Desk', email: 'newdesk@test.dev', role: 'staff', locationIds: [loc.id] })
      .expect(201);
    expect(created.body.tempPassword).toBeTruthy();
    expect(created.body.locationIds).toEqual([loc.id]);

    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: 'newdesk@test.dev', password: created.body.tempPassword }).expect(200);
    await agent.get(`/api/members?locationId=${loc.id}`).expect(200);
    await agent.get(`/api/members?locationId=${other.id}`).expect(403);

    // Moving them to the other location takes effect immediately.
    await owner.patch(`/api/staff/${created.body.id}`).send({ locationIds: [other.id] }).expect(200);
    await agent.get(`/api/members?locationId=${loc.id}`).expect(403);
    await agent.get(`/api/members?locationId=${other.id}`).expect(200);

    // Disabling locks them out.
    await owner.patch(`/api/staff/${created.body.id}`).send({ active: false }).expect(200);
    await agent.get('/api/auth/me').expect(401);
  });

  it('protects owner accounts and issues new passwords on reset', async () => {
    const { app, db } = await setup();
    const owner = await login(app, 'owner@test.dev');
    const { users } = await import('../src/db/schema.js');
    const rows = await db.select().from(users).all();
    const ownerRow = rows.find((u) => u.email === 'owner@test.dev')!;
    const deskRow = rows.find((u) => u.email === 'desk@test.dev')!;

    await owner.patch(`/api/staff/${ownerRow.id}`).send({ active: false }).expect(400);
    const reset = await owner.patch(`/api/staff/${deskRow.id}`).send({ resetPassword: true }).expect(200);
    await request(app).post('/api/auth/login').send({ email: 'desk@test.dev', password: PASSWORD }).expect(401);
    await request(app).post('/api/auth/login').send({ email: 'desk@test.dev', password: reset.body.tempPassword }).expect(200);
  });
});

describe('sessions and passwords', () => {
  it('changes a password only with the right current password', async () => {
    const { app } = await setup();
    const agent = await login(app, 'pro@test.dev');
    await agent.post('/api/auth/change-password').send({ currentPassword: 'wrong-wrong', newPassword: 'brand-new-pass' }).expect(400);
    await agent.post('/api/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'short' }).expect(400);
    await agent.post('/api/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'brand-new-pass' }).expect(204);
    await request(app).post('/api/auth/login').send({ email: 'pro@test.dev', password: PASSWORD }).expect(401);
    await request(app).post('/api/auth/login').send({ email: 'pro@test.dev', password: 'brand-new-pass' }).expect(200);
  });

  it('clears the session on logout', async () => {
    const { app } = await setup();
    const agent = await login(app, 'owner@test.dev');
    await agent.get('/api/auth/me').expect(200);
    await agent.post('/api/auth/logout').expect(204);
    await agent.get('/api/auth/me').expect(401);
  });

  it('throttles repeated failed sign-ins', async () => {
    const { app } = await setup();
    for (let i = 0; i < 10; i++) {
      await request(app).post('/api/auth/login').send({ email: 'victim@test.dev', password: 'nope' }).expect(401);
    }
    await request(app).post('/api/auth/login').send({ email: 'victim@test.dev', password: 'nope' }).expect(429);
    // A different account is not affected.
    await request(app).post('/api/auth/login').send({ email: 'owner@test.dev', password: PASSWORD }).expect(200);
  });
});
