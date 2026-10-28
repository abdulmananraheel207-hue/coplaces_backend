import request from 'supertest';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { organizations, packages } from '../src/db/schema.js';
import { FEATURE_KEYS } from '../src/features.js';
import { addDays, todayIn } from '../src/lib/time.js';
import { login, PASSWORD, setup, TZ, tomorrow } from './helpers.js';

describe('tenant isolation', () => {
  it('keeps one coworking space out of another', async () => {
    const { app, loc, other, locB, room, basic } = await setup();
    const hive = await login(app, 'owner@hive.dev');

    const me = await hive.get('/api/auth/me').expect(200);
    expect(me.body.locations.map((l: { id: string }) => l.id)).toEqual([locB.id]);
    expect(me.body.org.name).toBe('Hive');

    // Nest's data is invisible and untouchable from Hive.
    for (const id of [loc.id, other.id]) {
      await hive.get(`/api/members?locationId=${id}`).expect(403);
      await hive.get(`/api/resources?locationId=${id}`).expect(403);
      await hive.get(`/api/bookings/schedule?locationId=${id}`).expect(403);
      await hive.get(`/api/reports/dashboard?locationId=${id}`).expect(403);
      await hive.patch(`/api/locations/${id}`).send({ name: 'Hijacked' }).expect(403);
    }
    await hive.get(`/api/members/${basic.member.id}`).expect(403);
    await hive
      .post('/api/bookings')
      .send({ resourceId: room.id, memberId: basic.member.id, date: tomorrow(), startTime: '10:00', endTime: '11:00' })
      .expect(403);
    await hive.post('/api/members').send({ locationId: loc.id, name: 'Intruder', email: 'in@x.dev' }).expect(403);
  });

  it('only shows a tenant its own team and rejects other tenants locations', async () => {
    const { app, locB } = await setup();
    const nest = await login(app, 'owner@test.dev');
    const staff = await nest.get('/api/staff').expect(200);
    expect(staff.body.map((u: { email: string }) => u.email).sort()).toEqual(['desk@test.dev', 'manager@test.dev', 'owner@test.dev', 'uptown@test.dev']);
    await nest.post('/api/staff').send({ name: 'Spy', email: 'spy@test.dev', role: 'staff', locationIds: [locB.id] }).expect(400);
  });

  it('cannot edit or reset another tenants staff', async () => {
    const { app, db } = await setup();
    const { users } = await import('../src/db/schema.js');
    const hiveOwner = (await db.select().from(users).where(eq(users.email, 'owner@hive.dev')).get())!;
    const nest = await login(app, 'owner@test.dev');
    await nest.patch(`/api/staff/${hiveOwner.id}`).send({ resetPassword: true }).expect(404);
    await nest.patch(`/api/staff/${hiveOwner.id}`).send({ active: false }).expect(404);
  });

  it('lets two tenants use the same location code and invoice numbers', async () => {
    const { app, db, basic, hiveMember, starterPackage } = await setup();
    await db.update(packages).set({ features: JSON.stringify(FEATURE_KEYS), maxMembers: null }).where(eq(packages.id, starterPackage.id)).run();
    const a = await login(app, 'owner@test.dev');
    const b = await login(app, 'owner@hive.dev');
    const item = [{ description: 'Fee', quantity: 1, unitPriceCents: 1_000 }];
    const ia = await a.post('/api/invoices').send({ memberId: basic.member.id, items: item }).expect(201);
    const ib = await b.post('/api/invoices').send({ memberId: hiveMember.member.id, items: item }).expect(201);
    expect(ia.body.number).toBe('DTN-00001');
    expect(ib.body.number).toBe('DTN-00001');
    await a.get(`/api/invoices/${ib.body.id}`).expect(403);
  });

  it('keeps platform and tenant APIs apart', async () => {
    const { app, loc } = await setup();
    const root = await login(app, 'root@platform.dev');
    await root.get(`/api/members?locationId=${loc.id}`).expect(403);
    await root.get('/api/locations').expect(200).then((r) => expect(r.body).toEqual([]));
    const owner = await login(app, 'owner@test.dev');
    await owner.get('/api/platform/packages').expect(403);
    await owner.get('/api/platform/organizations').expect(403);
    await request(app).get('/api/platform/overview').expect(401);
  });
});

describe('package features', () => {
  it('blocks features the package does not include', async () => {
    const { app, locB, hiveMember } = await setup();
    const hive = await login(app, 'owner@hive.dev');
    await hive.get(`/api/invoices?locationId=${locB.id}`).expect(403);
    await hive.get(`/api/payments?locationId=${locB.id}`).expect(403);
    await hive.get(`/api/expenses?locationId=${locB.id}`).expect(403);
    await hive.get(`/api/reports/finance?locationId=${locB.id}`).expect(403);
    await hive.get(`/api/visitors?locationId=${locB.id}`).expect(403);
    await hive.get('/api/staff').expect(403);
    await hive.post('/api/invoices').send({ memberId: hiveMember.member.id, items: [{ description: 'x', unitPriceCents: 1 }] }).expect(403);

    // Core features still work, and the dashboard omits finance.
    await hive.get(`/api/members?locationId=${locB.id}`).expect(200);
    const dash = await hive.get(`/api/reports/dashboard?locationId=${locB.id}`).expect(200);
    expect(dash.body.finance).toBeNull();
    const me = await hive.get('/api/auth/me').expect(200);
    expect(me.body.org.features).toEqual([]);
  });

  it('tells the user what to do', async () => {
    const { app, locB } = await setup();
    const hive = await login(app, 'owner@hive.dev');
    const res = await hive.get(`/api/invoices?locationId=${locB.id}`).expect(403);
    expect(res.body.error).toMatch(/not included in your current package/i);
  });

  it('does not let members sign in when the member portal is off', async () => {
    const { app } = await setup();
    const res = await request(app).post('/api/auth/login').send({ email: 'member@hive.dev', password: PASSWORD }).expect(403);
    expect(res.body.error).toMatch(/member portal/i);
    await login(app, 'pro@test.dev'); // Nest has it
  });

  it('hides invoices and visitors from the member summary when those features are off', async () => {
    const { app, db, org, fullPackage } = await setup();
    const member = await login(app, 'pro@test.dev');
    await member.get('/api/me/summary').expect(200);
    await db.update(packages).set({ features: JSON.stringify(['member_portal']) }).where(eq(packages.id, fullPackage.id)).run();
    const summary = await member.get('/api/me/summary').expect(200);
    expect(summary.body.openInvoices).toEqual([]);
    expect(summary.body.expectedVisitors).toEqual([]);
    await member.get('/api/invoices?locationId=x').expect(403);
    expect(org.id).toBeTruthy();
  });
});

describe('package limits', () => {
  it('enforces the location limit', async () => {
    const { app } = await setup();
    const hive = await login(app, 'owner@hive.dev');
    const res = await hive
      .post('/api/locations')
      .send({ name: 'Second', code: 'SEC', openTime: '09:00', closeTime: '17:00' })
      .expect(403);
    expect(res.body.error).toMatch(/up to 1 locations/);
    const nest = await login(app, 'owner@test.dev');
    await nest.post('/api/locations').send({ name: 'Third', code: 'THR', openTime: '09:00', closeTime: '17:00' }).expect(201);
  });

  it('enforces the member limit, and cancelled members free a seat', async () => {
    const { app, locB, hiveMember } = await setup();
    const hive = await login(app, 'owner@hive.dev');
    // limit is 2 and there is already 1 member
    const second = await hive.post('/api/members').send({ locationId: locB.id, name: 'Two', email: 'two@hive.dev' }).expect(201);
    const blocked = await hive.post('/api/members').send({ locationId: locB.id, name: 'Three', email: 'three@hive.dev' }).expect(403);
    expect(blocked.body.error).toMatch(/up to 2 members/);

    await hive.patch(`/api/members/${hiveMember.member.id}`).send({ status: 'cancelled' }).expect(200);
    await hive.post('/api/members').send({ locationId: locB.id, name: 'Three', email: 'three@hive.dev' }).expect(201);
    // reinstating the cancelled member would now exceed the limit
    await hive.patch(`/api/members/${hiveMember.member.id}`).send({ status: 'active' }).expect(403);
    expect(second.body.id).toBeTruthy();
  });
});

describe('subscription status', () => {
  it('blocks a suspended tenant at sign-in and on live sessions', async () => {
    const { app, db, org } = await setup();
    const owner = await login(app, 'owner@test.dev');
    const member = await login(app, 'pro@test.dev');
    await owner.get('/api/auth/me').expect(200);

    await db.update(organizations).set({ status: 'suspended' }).where(eq(organizations.id, org.id)).run();
    await owner.get('/api/auth/me').expect(401);
    await member.get('/api/me/summary').expect(401);
    const res = await request(app).post('/api/auth/login').send({ email: 'owner@test.dev', password: PASSWORD }).expect(403);
    expect(res.body.error).toMatch(/suspended/);
    await request(app).post('/api/auth/login').send({ email: 'root@platform.dev', password: PASSWORD }).expect(200);
    await login(app, 'owner@hive.dev'); // other tenants are unaffected
  });

  it('warns about an expired subscription without locking anyone out', async () => {
    const { app, db, org } = await setup();
    await db.update(organizations).set({ periodEnd: addDays(todayIn('Asia/Karachi'), -3) }).where(eq(organizations.id, org.id)).run();
    const owner = await login(app, 'owner@test.dev');
    const me = await owner.get('/api/auth/me').expect(200);
    expect(me.body.org.expired).toBe(true);
    expect(me.body.org.status).toBe('active');
    expect(TZ).toBeTruthy();
  });
});
