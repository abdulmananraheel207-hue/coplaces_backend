import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { login, PASSWORD, setup } from './helpers.js';

describe('auth and access control', () => {
  it('rejects bad credentials and unauthenticated calls', async () => {
    const { app } = await setup();
    await request(app).get('/api/locations').expect(401);
    await request(app).post('/api/auth/login').send({ email: 'owner@test.dev', password: 'wrong' }).expect(401);
    await request(app).post('/api/auth/login').send({ email: 'nobody@test.dev', password: PASSWORD }).expect(401);
  });

  it('returns the user and their locations on login', async () => {
    const { app, loc, other } = await setup();
    const owner = await login(app, 'owner@test.dev');
    const me = await owner.get('/api/auth/me').expect(200);
    expect(me.body.user.role).toBe('owner');
    expect(me.body.locations).toHaveLength(2);

    const desk = await login(app, 'desk@test.dev');
    const deskMe = await desk.get('/api/auth/me').expect(200);
    expect(deskMe.body.locations.map((l: { id: string }) => l.id)).toEqual([loc.id]);
    expect(deskMe.body.locations[0].id).not.toBe(other.id);
  });

  it('keeps staff inside their own locations', async () => {
    const { app, loc, other } = await setup();
    const desk = await login(app, 'desk@test.dev');
    await desk.get(`/api/members?locationId=${loc.id}`).expect(200);
    await desk.get(`/api/members?locationId=${other.id}`).expect(403);
    await desk.get('/api/members').expect(400);
  });

  it('gates finance and admin endpoints by role', async () => {
    const { app, loc } = await setup();
    const desk = await login(app, 'desk@test.dev');
    await desk.get(`/api/expenses?locationId=${loc.id}`).expect(403);
    await desk.get(`/api/reports/finance?locationId=${loc.id}`).expect(403);
    await desk.get('/api/staff').expect(403);
    await desk.post('/api/invoices/generate').send({ locationId: loc.id, month: '2026-01' }).expect(403);

    const manager = await login(app, 'manager@test.dev');
    await manager.get(`/api/expenses?locationId=${loc.id}`).expect(200);
    await manager.get('/api/staff').expect(403);

    const owner = await login(app, 'owner@test.dev');
    await owner.get('/api/staff').expect(200);
  });

  it('confines members to their own data', async () => {
    const { app, loc, basic } = await setup();
    const pro = await login(app, 'pro@test.dev');
    await pro.get(`/api/members?locationId=${loc.id}`).expect(403);
    await pro.get(`/api/members/${basic.member.id}`).expect(403);
    await pro.get(`/api/expenses?locationId=${loc.id}`).expect(403);
    const summary = await pro.get('/api/me/summary').expect(200);
    expect(summary.body.plan.name).toBe('Pro');
  });

  it('locks out deactivated and cancelled accounts', async () => {
    const { app, basic } = await setup();
    const desk = await login(app, 'desk@test.dev');
    const agent = await login(app, 'basic@test.dev');
    await agent.get('/api/me/summary').expect(200);
    await desk.patch(`/api/members/${basic.member.id}`).send({ status: 'cancelled' }).expect(200);
    await agent.get('/api/me/summary').expect(401);
    await request(app).post('/api/auth/login').send({ email: 'basic@test.dev', password: PASSWORD }).expect(401);
  });

  it('creates members with a temporary password they can use', async () => {
    const { app, loc, basicPlan } = await setup();
    const desk = await login(app, 'desk@test.dev');
    const created = await desk
      .post('/api/members')
      .send({ locationId: loc.id, name: 'New Person', email: 'New@Test.dev', planId: basicPlan.id })
      .expect(201);
    expect(created.body.tempPassword).toBeTruthy();
    expect(created.body.email).toBe('new@test.dev');
    await request(app).post('/api/auth/login').send({ email: 'new@test.dev', password: created.body.tempPassword }).expect(200);
    await desk.post('/api/members').send({ locationId: loc.id, name: 'Dup', email: 'new@test.dev' }).expect(409);
  });
});
