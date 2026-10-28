import { describe, expect, it } from 'vitest';
import { login, setup } from './helpers.js';

const plan = { x: 0, z: 0, rot: 0, w: null, d: null };

describe('floors', () => {
  it('names floors before anything is on them, with no limit by default', async () => {
    const { app, loc } = await setup();
    const owner = await login(app, 'owner@test.dev');
    const res = await owner.post('/api/floors').send({ locationId: loc.id, names: ['Ground', '1', 'Roof'] }).expect(201);
    expect(res.body.floors).toEqual(expect.arrayContaining(['Ground', '1', 'Roof']));
    // saying a name twice does not make a second floor
    await owner.post('/api/floors').send({ locationId: loc.id, names: ['Ground'] }).expect(201);
    const got = await owner.get(`/api/floors?locationId=${loc.id}`).expect(200);
    expect(got.body.limit).toBeNull();
    expect(got.body.floors.filter((f: string) => f === 'Ground')).toHaveLength(1);
  });

  it('rejects blank and repeated names, and other tenants', async () => {
    const { app, loc, locB } = await setup();
    const owner = await login(app, 'owner@test.dev');
    await owner.post('/api/floors').send({ locationId: loc.id, names: [' '] }).expect(400);
    await owner.post('/api/floors').send({ locationId: loc.id, names: ['A', 'a'] }).expect(400);
    await owner.post('/api/floors').send({ locationId: locB.id, names: ['A'] }).expect(403);
  });

  it('stops at the package limit, in every way a floor can be made', async () => {
    const { app, loc, fullPackage } = await setup();
    const root = await login(app, 'root@platform.dev');
    const owner = await login(app, 'owner@test.dev');
    // the seeded space already sits on the unnamed floor, so that is floor one of three
    await root.patch(`/api/platform/packages/${fullPackage.id}`).send({ maxFloors: 3 }).expect(200);

    await owner.post('/api/floors').send({ locationId: loc.id, names: ['1', '2'] }).expect(201);
    const over = await owner.post('/api/floors').send({ locationId: loc.id, names: ['3'] }).expect(403);
    expect(over.body.error ?? over.body.message).toMatch(/up to 3 floors/);

    await owner.post('/api/resources').send({ locationId: loc.id, kind: 'room', name: 'X', floor: '9' }).expect(403);
    await owner.put('/api/floor-plan').send({ locationId: loc.id, floors: ['9'] }).expect(403);
    await owner.put('/api/floor-plan').send({ locationId: loc.id, create: [{ kind: 'room', name: 'Y', floor: '9', plan }] }).expect(403);

    // working on a floor that exists is fine, and the editor can keep its empty floors
    await owner.post('/api/resources').send({ locationId: loc.id, kind: 'room', name: 'Z', floor: '2' }).expect(201);
    await owner.put('/api/floor-plan').send({ locationId: loc.id, floors: ['1', '2'] }).expect(200);
  });

  it('lets the editor keep an empty floor', async () => {
    const { app, loc } = await setup();
    const owner = await login(app, 'owner@test.dev');
    await owner.put('/api/floor-plan').send({ locationId: loc.id, floors: ['4'] }).expect(200);
    const got = await owner.get(`/api/floors?locationId=${loc.id}`).expect(200);
    expect(got.body.floors).toContain('4');
  });

  it('stores the limit on a package, empty meaning unlimited', async () => {
    const { app } = await setup();
    const root = await login(app, 'root@platform.dev');
    const a = await root.post('/api/platform/packages').send({ name: 'F2', interval: 'month', priceCents: 1, features: [], maxFloors: 2 }).expect(201);
    expect(a.body.maxFloors).toBe(2);
    const b = await root.post('/api/platform/packages').send({ name: 'F-any', interval: 'month', priceCents: 1, features: [] }).expect(201);
    expect(b.body.maxFloors).toBeNull();
    const c = await root.patch(`/api/platform/packages/${a.body.id}`).send({ maxFloors: null }).expect(200);
    expect(c.body.maxFloors).toBeNull();
    await root.patch(`/api/platform/packages/${a.body.id}`).send({ maxFloors: 0 }).expect(400);
  });
});

describe('deleting floors', () => {
  it('removes an empty floor, frees its place under the limit, and refuses one with things on it', async () => {
    const { app, loc, fullPackage } = await setup();
    const root = await login(app, 'root@platform.dev');
    const owner = await login(app, 'owner@test.dev');
    await root.patch(`/api/platform/packages/${fullPackage.id}`).send({ maxFloors: 2 }).expect(200);
    await owner.post('/api/floors').send({ locationId: loc.id, names: ['Spare'] }).expect(201);
    await owner.post('/api/floors').send({ locationId: loc.id, names: ['Another'] }).expect(403);

    const res = await owner.delete(`/api/floors?locationId=${loc.id}&name=Spare`).expect(200);
    expect(res.body.floors).not.toContain('Spare');
    await owner.post('/api/floors').send({ locationId: loc.id, names: ['Another'] }).expect(201);

    await owner.delete(`/api/floors?locationId=${loc.id}&name=Nope`).expect(404);
    await owner.post('/api/resources').send({ locationId: loc.id, kind: 'room', name: 'R', floor: 'Another' }).expect(201);
    await owner.delete(`/api/floors?locationId=${loc.id}&name=Another`).expect(409);
  });

  it('keeps other tenants out', async () => {
    const { app, locB } = await setup();
    const owner = await login(app, 'owner@test.dev');
    await owner.delete(`/api/floors?locationId=${locB.id}&name=X`).expect(403);
  });
});
