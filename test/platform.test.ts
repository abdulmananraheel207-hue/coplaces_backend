import request from 'supertest';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { organizations, packages } from '../src/db/schema.js';
import { addDays, addMonthsToDate, todayIn } from '../src/lib/time.js';
import { login, PASSWORD, setup } from './helpers.js';

const today = () => todayIn('Asia/Karachi');

describe('packages', () => {
  it('lists the feature catalogue', async () => {
    const { app } = await setup();
    const root = await login(app, 'root@platform.dev');
    const res = await root.get('/api/platform/features').expect(200);
    expect(res.body.features.map((f: { key: string }) => f.key)).toContain('floor_3d');
    expect(res.body.core.length).toBeGreaterThan(0);
  });

  it('creates packages with a price in minor units and pulls in required features', async () => {
    const { app } = await setup();
    const root = await login(app, 'root@platform.dev');
    const created = await root
      .post('/api/platform/packages')
      .send({ name: 'Growth', description: 'Most spaces', interval: 'month', priceCents: 1_900_000, features: ['reports', 'visitors', 'visitors'], maxLocations: 2, maxMembers: null })
      .expect(201);
    // "reports" needs "invoicing"; order follows the catalogue
    expect(created.body.features).toEqual(['visitors', 'invoicing', 'reports']);
    expect(created.body.priceCents).toBe(1_900_000);
    expect(created.body.maxMembers).toBeNull();

    await root.post('/api/platform/packages').send({ name: 'Growth', interval: 'month', priceCents: 1, features: [] }).expect(409);
    await root.post('/api/platform/packages').send({ name: 'Bad', interval: 'month', priceCents: 1, features: ['teleport'] }).expect(400);
    await root.post('/api/platform/packages').send({ name: 'Neg', interval: 'month', priceCents: -5, features: [] }).expect(400);
    await root.post('/api/platform/packages').send({ name: 'Zero', interval: 'month', priceCents: 100, features: [], maxMembers: 0 }).expect(400);
  });

  it('changes what tenants can do as soon as a package is edited', async () => {
    const { app, loc, fullPackage } = await setup();
    const root = await login(app, 'root@platform.dev');
    const owner = await login(app, 'owner@test.dev');
    await owner.get(`/api/invoices?locationId=${loc.id}`).expect(200);

    const features = ['visitors', 'expenses'];
    const res = await root.patch(`/api/platform/packages/${fullPackage.id}`).send({ features }).expect(200);
    expect(res.body.tenants).toBe(1);
    await owner.get(`/api/invoices?locationId=${loc.id}`).expect(403);
    await owner.get(`/api/expenses?locationId=${loc.id}`).expect(200);
  });

  it('counts tenants per package', async () => {
    const { app, fullPackage } = await setup();
    const root = await login(app, 'root@platform.dev');
    const list = await root.get('/api/platform/packages').expect(200);
    expect(list.body.find((p: { id: string }) => p.id === fullPackage.id).tenants).toBe(1);
  });
});

describe('coworking spaces', () => {
  const newSpace = (packageId: string, overrides: object = {}) => ({
    name: 'Workbay',
    city: 'Lahore',
    packageId,
    owner: { name: 'Zara Iqbal', email: 'Zara@Workbay.pk', phone: '+92 300 1234567' },
    location: { name: 'Workbay Gulberg', code: 'wbg', address: 'Gulberg III, Lahore' },
    ...overrides,
  });

  it('registers a space with an owner, a first location and a temporary password', async () => {
    const { app, fullPackage } = await setup();
    const root = await login(app, 'root@platform.dev');
    const res = await root.post('/api/platform/organizations').send(newSpace(fullPackage.id)).expect(201);
    expect(res.body.status).toBe('trial');
    expect(res.body.periodEnd).toBe(addDays(today(), 14));
    expect(res.body.owner.email).toBe('zara@workbay.pk');
    expect(res.body.owner.tempPassword).toBeTruthy();

    const agent = request.agent(app);
    const signedIn = await agent.post('/api/auth/login').send({ email: 'zara@workbay.pk', password: res.body.owner.tempPassword }).expect(200);
    expect(signedIn.body.user.role).toBe('owner');
    expect(signedIn.body.org.name).toBe('Workbay');
    expect(signedIn.body.locations).toHaveLength(1);
    expect(signedIn.body.locations[0]).toMatchObject({ code: 'WBG', currency: 'PKR', timezone: 'Asia/Karachi' });
  });

  it('validates the new space', async () => {
    const { app, db, fullPackage } = await setup();
    const root = await login(app, 'root@platform.dev');
    await root.post('/api/platform/organizations').send(newSpace(fullPackage.id, { owner: { name: 'X', email: 'owner@test.dev' } })).expect(409);
    await root.post('/api/platform/organizations').send(newSpace('nope')).expect(400);
    await root.post('/api/platform/organizations').send(newSpace(fullPackage.id, { location: { name: 'A', code: 'x' } })).expect(400);
    await db.update(packages).set({ active: false }).where(eq(packages.id, fullPackage.id)).run();
    await root.post('/api/platform/organizations').send(newSpace(fullPackage.id)).expect(400);
  });

  it('lists spaces with usage and shows details', async () => {
    const { app, org } = await setup();
    const root = await login(app, 'root@platform.dev');
    const list = await root.get('/api/platform/organizations').expect(200);
    const nest = list.body.find((o: { id: string }) => o.id === org.id);
    expect(nest.usage).toMatchObject({ locations: 2, members: 2, activeMembers: 2 });
    expect(nest.owner.email).toBe('owner@test.dev');

    const detail = await root.get(`/api/platform/organizations/${org.id}`).expect(200);
    expect(detail.body.locations.map((l: { code: string }) => l.code).sort()).toEqual(['DTN', 'UPT']);
    expect(detail.body.owners).toHaveLength(1);
    expect(detail.body.package.features).toContain('invoicing');
  });

  it('changes package, status and subscription date', async () => {
    const { app, org, starterPackage } = await setup();
    const root = await login(app, 'root@platform.dev');
    const owner = await login(app, 'owner@test.dev');
    const res = await root.patch(`/api/platform/organizations/${org.id}`).send({ packageId: starterPackage.id, periodEnd: '2031-01-31' }).expect(200);
    expect(res.body.package.name).toBe('Starter');
    expect(res.body.periodEnd).toBe('2031-01-31');
    await owner.get('/api/staff').expect(403); // 'team' is no longer in the package

    await root.patch(`/api/platform/organizations/${org.id}`).send({ status: 'suspended' }).expect(200);
    await owner.get('/api/auth/me').expect(401);
    await root.patch(`/api/platform/organizations/${org.id}`).send({ status: 'active' }).expect(200);
    await owner.get('/api/auth/me').expect(200);
  });

  it('resets an owner password', async () => {
    const { app, org } = await setup();
    const root = await login(app, 'root@platform.dev');
    const res = await root.post(`/api/platform/organizations/${org.id}/reset-owner-password`).send({}).expect(200);
    await request(app).post('/api/auth/login').send({ email: 'owner@test.dev', password: PASSWORD }).expect(401);
    await request(app).post('/api/auth/login').send({ email: 'owner@test.dev', password: res.body.tempPassword }).expect(200);
  });
});

describe('subscription payments', () => {
  it('records a payment, extends the period and activates a trial', async () => {
    const { app, db, fullPackage } = await setup();
    const root = await login(app, 'root@platform.dev');
    const space = await root
      .post('/api/platform/organizations')
      .send({ name: 'Trialco', packageId: fullPackage.id, owner: { name: 'T', email: 't@trial.pk' }, location: { name: 'T', code: 'TRI' } })
      .expect(201);
    const trialEnds = space.body.periodEnd;

    const paid = await root
      .post(`/api/platform/organizations/${space.body.id}/payments`)
      .send({ amountCents: 4_500_000, method: 'jazzcash', reference: 'TXN-1', periods: 2 })
      .expect(201);
    // the trial runs to day 14, so two paid months start there
    expect(paid.body.payment.periodStart).toBe(trialEnds);
    expect(paid.body.payment.periodEnd).toBe(addMonthsToDate(trialEnds, 2));
    expect(paid.body.organization.status).toBe('active');

    // an expired subscription restarts from today
    await db.update(organizations).set({ periodEnd: addDays(today(), -40) }).where(eq(organizations.id, space.body.id)).run();
    const late = await root.post(`/api/platform/organizations/${space.body.id}/payments`).send({ amountCents: 4_500_000, method: 'bank_transfer' }).expect(201);
    expect(late.body.payment.periodStart).toBe(today());
    expect(late.body.payment.periodEnd).toBe(addMonthsToDate(today(), 1));
    expect(late.body.organization.expired).toBe(false);

    const list = await root.get('/api/platform/payments').expect(200);
    expect(list.body).toHaveLength(2);
    expect(list.body[0].organizationName).toBe('Trialco');
    await root.post(`/api/platform/organizations/${space.body.id}/payments`).send({ amountCents: 0, method: 'cash' }).expect(400);
  });

  it('does not reactivate a suspended space just because it paid', async () => {
    const { app, org } = await setup();
    const root = await login(app, 'root@platform.dev');
    await root.patch(`/api/platform/organizations/${org.id}`).send({ status: 'suspended' }).expect(200);
    const res = await root.post(`/api/platform/organizations/${org.id}/payments`).send({ amountCents: 100, method: 'cash' }).expect(201);
    expect(res.body.organization.status).toBe('suspended');
  });
});

describe('platform overview', () => {
  it('works out monthly recurring revenue and what needs attention', async () => {
    const { app, db, org, orgB, fullPackage, starterPackage } = await setup();
    const root = await login(app, 'root@platform.dev');
    // Nest pays 45,000/month, Hive pays 7,500/month. Make Hive's plan yearly: 90,000/yr = 7,500/month.
    await db.update(packages).set({ interval: 'year', priceCents: 9_000_000 }).where(eq(packages.id, starterPackage.id)).run();
    await db.update(organizations).set({ periodEnd: addDays(today(), 5) }).where(eq(organizations.id, orgB.id)).run();

    await root.post(`/api/platform/organizations/${org.id}/payments`).send({ amountCents: 4_500_000, method: 'bank_transfer' }).expect(201);
    const trial = await root
      .post('/api/platform/organizations')
      .send({ name: 'Newbie', packageId: fullPackage.id, owner: { name: 'N', email: 'n@new.pk' }, location: { name: 'N', code: 'NEW' } })
      .expect(201);

    const o = (await root.get('/api/platform/overview').expect(200)).body;
    expect(o.currency).toBe('PKR');
    expect(o.organizations).toMatchObject({ total: 3, active: 2, trial: 1, suspended: 0 });
    expect(o.mrrCents).toBe(4_500_000 + 750_000); // trials are not revenue yet
    expect(o.collectedThisMonthCents).toBe(4_500_000);
    expect(o.attention.map((a: { id: string }) => a.id)).toContain(orgB.id);
    expect(o.attention.map((a: { id: string }) => a.id)).toContain(trial.body.id);
    expect(o.byPackage.find((p: { id: string; tenants: number }) => p.id === fullPackage.id).tenants).toBe(2);
    expect(o.people.locations).toBe(4);
  });
});
