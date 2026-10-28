import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { floorObjects, resources } from '../src/db/schema.js';
import { login, setup, tomorrow } from './helpers.js';

const plan = (x: number, z: number, extra: Record<string, unknown> = {}) => ({ x, z, rot: 0, w: null, d: null, ...extra });

describe('floor plan', () => {
  it('saves a whole editing session: new spaces, moves, removals and objects', async () => {
    const { app, db, loc, room, desk, desk2 } = await setup();
    const owner = await login(app, 'owner@test.dev');

    const res = await owner
      .put('/api/floor-plan')
      .send({
        locationId: loc.id,
        update: [
          { id: room.id, plan: plan(4, 2, { rot: 1, w: 6, d: 4 }), props: { style: 'huddle', capacity: 6 } },
          { id: desk.id, plan: plan(10, 3) },
        ],
        create: [
          { kind: 'corporate_room', style: 'boardroom', name: 'Executive Suite', floor: '2', capacity: 14, hourlyRateCents: 900_000, plan: plan(0, 0, { w: 9, d: 5 }) },
          { kind: 'hot_desk', style: 'standing', name: 'Standing Desk 1', floor: '1', dailyRateCents: 150_000, plan: plan(12, 3) },
        ],
        retire: [desk2.id],
        objects: { upsert: [{ type: 'coffee_machine', floor: '1', label: 'Lobby coffee', x: 2, z: 8, rot: 0 }, { type: 'kitchen', floor: '1', x: 6, z: 8, rot: 2 }], remove: [] },
      })
      .expect(200);
    expect(res.body.created).toHaveLength(2);

    const list = await owner.get(`/api/resources?locationId=${loc.id}`).expect(200);
    const byName = (n: string) => list.body.find((r: { name: string }) => r.name === n);
    expect(byName('Boardroom')).toMatchObject({ planX: 4, planZ: 2, planRot: 1, planW: 6, planD: 4, style: 'huddle', capacity: 6 });
    expect(byName('Executive Suite')).toMatchObject({ kind: 'corporate_room', style: 'boardroom', floor: '2', planW: 9 });
    expect(byName('Standing Desk 1')).toMatchObject({ kind: 'hot_desk', style: 'standing' });
    expect(byName('Desk 2')).toMatchObject({ status: 'retired', planX: null });

    const objects = await owner.get(`/api/floor-plan/objects?locationId=${loc.id}`).expect(200);
    expect(objects.body.map((o: { type: string }) => o.type).sort()).toEqual(['coffee_machine', 'kitchen']);

    // A second save can move and remove objects.
    const coffee = objects.body.find((o: { type: string }) => o.type === 'coffee_machine');
    await owner
      .put('/api/floor-plan')
      .send({ locationId: loc.id, objects: { upsert: [{ id: coffee.id, type: 'coffee_machine', floor: '1', x: 3, z: 9, rot: 1 }], remove: [objects.body.find((o: { type: string }) => o.type === 'kitchen').id] } })
      .expect(200);
    const after = await db.select().from(floorObjects).where(eq(floorObjects.locationId, loc.id)).all();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ x: 3, z: 9, rot: 1 });
  });

  it('applies all of a save or none of it', async () => {
    const { app, db, loc, desk } = await setup();
    const owner = await login(app, 'owner@test.dev');
    // The second new space reuses a name, so the first must not be kept either.
    await owner
      .put('/api/floor-plan')
      .send({
        locationId: loc.id,
        update: [{ id: desk.id, plan: plan(7, 7) }],
        create: [
          { kind: 'room', name: 'Atrium', floor: '1', plan: plan(0, 0) },
          { kind: 'room', name: 'Atrium', floor: '1', plan: plan(5, 0) },
        ],
      })
      .expect(409);
    expect(await db.select().from(resources).where(eq(resources.name, 'Atrium')).all()).toHaveLength(0);
    expect((await db.select().from(resources).where(eq(resources.id, desk.id)).get())!.planX).toBeNull();
  });

  it('refuses to remove a space that still has bookings or an assignment', async () => {
    const { app, loc, room, dedicated, pro } = await setup();
    const owner = await login(app, 'owner@test.dev');

    const booking = await owner
      .post('/api/bookings')
      .send({ resourceId: room.id, memberId: pro.member.id, date: tomorrow(), startTime: '10:00', endTime: '11:00' })
      .expect(201);
    const blocked = await owner.put('/api/floor-plan').send({ locationId: loc.id, retire: [room.id] }).expect(409);
    expect(blocked.body.error).toMatch(/bookings coming up/);
    // The same rule holds when retiring from the edit form.
    await owner.patch(`/api/resources/${room.id}`).send({ status: 'retired' }).expect(409);

    await owner.post(`/api/bookings/${booking.body.id}/cancel`).expect(200);
    await owner.put('/api/floor-plan').send({ locationId: loc.id, retire: [room.id] }).expect(200);

    await owner.post('/api/assignments').send({ resourceId: dedicated.id, memberId: pro.member.id, startDate: tomorrow() }).expect(201);
    const assigned = await owner.put('/api/floor-plan').send({ locationId: loc.id, retire: [dedicated.id] }).expect(409);
    expect(assigned.body.error).toMatch(/assigned to a member/);
  });

  it('validates styles, sizes and coordinates', async () => {
    const { app, loc, room } = await setup();
    const owner = await login(app, 'owner@test.dev');
    const put = (b: object) => owner.put('/api/floor-plan').send({ locationId: loc.id, ...b });

    await put({ create: [{ kind: 'room', style: 'standing', name: 'Odd', floor: '1', plan: plan(0, 0) }] }).expect(400);
    await put({ update: [{ id: room.id, props: { style: 'boardroom' } }] }).expect(400); // a corporate style on a meeting room
    await put({ update: [{ id: room.id, plan: plan(9999, 0) }] }).expect(400);
    await put({ update: [{ id: room.id, plan: plan(0, 0, { rot: 4 }) }] }).expect(400);
    await put({ update: [{ id: room.id, plan: plan(0, 0, { w: 0.1 }) }] }).expect(400);
    await put({ objects: { upsert: [{ type: 'jacuzzi', floor: '1', x: 0, z: 0, rot: 0 }] } }).expect(400);
    await owner.post('/api/resources').send({ locationId: loc.id, kind: 'office', style: 'standing', name: 'Nope' }).expect(400);
    await owner.post('/api/resources').send({ locationId: loc.id, kind: 'corporate_room', style: 'training_hall', name: 'Hall', capacity: 40, hourlyRateCents: 1 }).expect(201);
  });

  it('is only for managers and owners of a package that includes the 3D view', async () => {
    const { app, loc, locB, room } = await setup();
    const empty = { update: [], create: [], retire: [] };

    for (const who of ['desk@test.dev', 'pro@test.dev']) {
      const agent = await login(app, who);
      await agent.put('/api/floor-plan').send({ locationId: loc.id, ...empty }).expect(403);
    }
    await (await login(app, 'manager@test.dev')).put('/api/floor-plan').send({ locationId: loc.id, ...empty }).expect(200);

    // Hive's package has no features, so even its owner is turned away.
    const hive = await login(app, 'owner@hive.dev');
    const refused = await hive.put('/api/floor-plan').send({ locationId: locB.id, ...empty }).expect(403);
    expect(refused.body.error).toMatch(/not included in your current package/);
    await hive.get(`/api/floor-plan/objects?locationId=${locB.id}`).expect(403);

    // Members and front desk can look at the objects but not change them.
    await (await login(app, 'pro@test.dev')).get(`/api/floor-plan/objects?locationId=${loc.id}`).expect(200);
    await (await login(app, 'desk@test.dev')).get(`/api/floor-plan/objects?locationId=${loc.id}`).expect(200);
    expect(room.id).toBeTruthy();
  });

  it('keeps one tenant out of another tenants floor plan', async () => {
    const { app, db, loc, locB, other, room, fullPackage } = await setup();
    const { organizations } = await import('../src/db/schema.js');
    // Give Hive the 3D view so only tenancy, not the package, can stop it.
    await db.update(organizations).set({ packageId: fullPackage.id }).where(eq(organizations.id, locB.organizationId)).run();
    const hive = await login(app, 'owner@hive.dev');
    const hiveRoom = await db.insert(resources).values({ locationId: locB.id, kind: 'room', name: 'Hive Room' }).returning().get();
    const nestObject = await db.insert(floorObjects).values({ locationId: loc.id, floor: '1', type: 'kitchen', x: 1, z: 1 }).returning().get();
    const hiveObject = await db.insert(floorObjects).values({ locationId: locB.id, floor: '1', type: 'kitchen', x: 1, z: 1 }).returning().get();

    // Hive cannot name Nest's location, nor Nest's spaces under its own.
    await hive.put('/api/floor-plan').send({ locationId: loc.id, update: [{ id: room.id, plan: plan(1, 1) }] }).expect(403);
    await hive.put('/api/floor-plan').send({ locationId: locB.id, update: [{ id: room.id, plan: plan(1, 1) }] }).expect(404);
    await hive.put('/api/floor-plan').send({ locationId: locB.id, retire: [room.id] }).expect(404);
    await hive.put('/api/floor-plan').send({ locationId: locB.id, objects: { upsert: [{ id: nestObject.id, type: 'plant', floor: '1', x: 0, z: 0, rot: 0 }], remove: [] } }).expect(404);
    await hive.put('/api/floor-plan').send({ locationId: locB.id, objects: { upsert: [], remove: [nestObject.id] } }).expect(404);
    await hive.get(`/api/floor-plan/objects?locationId=${loc.id}`).expect(403);

    // The same holds between two locations of one tenant: you edit the location you name.
    const nest = await login(app, 'owner@test.dev');
    await nest.put('/api/floor-plan').send({ locationId: other.id, update: [{ id: room.id, plan: plan(1, 1) }] }).expect(404);

    expect(await db.select().from(floorObjects).where(eq(floorObjects.id, nestObject.id)).get()).toBeTruthy();
    expect(await db.select().from(floorObjects).where(eq(floorObjects.id, hiveObject.id)).get()).toBeTruthy();
    expect((await db.select().from(resources).where(eq(resources.id, hiveRoom.id)).get())!.planX).toBeNull();
    expect((await db.select().from(resources).where(eq(resources.id, room.id)).get())!.planX).toBeNull();
  });
});

describe('corporate rooms', () => {
  it('are booked by the hour at their own rate and leave the included minutes alone', async () => {
    const { app, db, loc, room, pro } = await setup();
    const owner = await login(app, 'owner@test.dev');
    const hall = await db
      .insert(resources)
      .values({ locationId: loc.id, kind: 'corporate_room', style: 'boardroom', name: 'Executive Suite', capacity: 14, hourlyRateCents: 900_000 })
      .returning()
      .get();
    const book = (resourceId: string, startTime: string, endTime: string) =>
      owner.post('/api/bookings').send({ resourceId, memberId: pro.member.id, date: tomorrow(), startTime, endTime });

    // The Pro plan includes 60 minutes of meeting rooms, but a corporate room never uses them.
    const corporate = await book(hall.id, '10:00', '11:00').expect(201);
    expect(corporate.body).toMatchObject({ priceCents: 900_000, billableMinutes: 60 });

    // So the same hour in an ordinary room is still free.
    const ordinary = await book(room.id, '13:00', '14:00').expect(201);
    expect(ordinary.body).toMatchObject({ priceCents: 0, billableMinutes: 0 });

    await book(hall.id, '10:30', '11:30').expect(409); // it is a bookable room like any other
    await owner.post('/api/bookings').send({ resourceId: hall.id, memberId: pro.member.id, date: tomorrow() }).expect(400); // needs times

    const schedule = await owner.get(`/api/bookings/schedule?locationId=${loc.id}&date=${tomorrow()}`).expect(200);
    expect(schedule.body.resources.map((r: { name: string }) => r.name)).toContain('Executive Suite');

    const dash = await owner.get(`/api/reports/dashboard?locationId=${loc.id}`).expect(200);
    expect(dash.body.ops.rooms.total).toBe(2); // the meeting room and the corporate room
  });
});
