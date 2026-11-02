import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { resources } from '../src/db/schema.js';
import { inDays, login, setup } from './helpers.js';

const price = (ctx: Awaited<ReturnType<typeof setup>>, prices: { resourceId: string; hourlyRateCents: number }[], locationId = ctx.loc.id) => ({ locationId, prices });

describe('the Pricing tab', () => {
  it('lets the owner price several spaces at once, and take a price away', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const res = await owner.put('/api/resources/pricing').send(price(ctx, [{ resourceId: ctx.desk.id, hourlyRateCents: 900 }, { resourceId: ctx.desk2.id, hourlyRateCents: 900 }, { resourceId: ctx.dedicated.id, hourlyRateCents: 1_500 }])).expect(200);
    expect(res.body.changed).toBe(3);
    const rate = async (id: string) => (await ctx.db.select().from(resources).where(eq(resources.id, id)).get())!.hourlyRateCents;
    expect([await rate(ctx.desk.id), await rate(ctx.desk2.id), await rate(ctx.dedicated.id)]).toEqual([900, 900, 1_500]);
    // saving the same prices again changes nothing
    expect((await owner.put('/api/resources/pricing').send(price(ctx, [{ resourceId: ctx.desk.id, hourlyRateCents: 900 }])).expect(200)).body.changed).toBe(0);
    await owner.put('/api/resources/pricing').send(price(ctx, [{ resourceId: ctx.dedicated.id, hourlyRateCents: 0 }])).expect(200);
    expect(await rate(ctx.dedicated.id)).toBe(0);
    // the list members and staff read carries the price
    const list = (await owner.get(`/api/resources?locationId=${ctx.loc.id}`).expect(200)).body as { id: string; hourlyRateCents: number }[];
    expect(list.find((r) => r.id === ctx.desk.id)!.hourlyRateCents).toBe(900);
  });

  it('is only for people who may change prices, and only in their own location', async () => {
    const ctx = await setup();
    const body = price(ctx, [{ resourceId: ctx.desk.id, hourlyRateCents: 900 }]);
    await (await login(ctx.app, 'desk@test.dev')).put('/api/resources/pricing').send(body).expect(403); // front desk has no pricing permission
    await (await login(ctx.app, 'pro@test.dev')).put('/api/resources/pricing').send(body).expect(403);
    const owner = await login(ctx.app, 'owner@test.dev');
    // a space of another location, or of another business, is not found
    await owner.put('/api/resources/pricing').send(price(ctx, [{ resourceId: ctx.desk.id, hourlyRateCents: 900 }], ctx.other.id)).expect(404);
    await (await login(ctx.app, 'owner@hive.dev')).put('/api/resources/pricing').send(body).expect(403);
    // nonsense is refused
    await owner.put('/api/resources/pricing').send(price(ctx, [{ resourceId: ctx.desk.id, hourlyRateCents: -5 }])).expect(400);
    await owner.put('/api/resources/pricing').send(price(ctx, [])).expect(400);
    await owner.put('/api/resources/pricing').send(price(ctx, [{ resourceId: 'nope', hourlyRateCents: 100 }])).expect(404);
    expect((await ctx.db.select().from(resources).where(eq(resources.id, ctx.desk.id)).get())!.hourlyRateCents).toBe(250);
  });

  it('is what decides where members and staff can book', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const pro = await login(ctx.app, 'pro@test.dev');
    const ask = (id: string) => pro.post('/api/requests').send({ resourceId: id, date: inDays(3), startTime: '10:00', endTime: '11:00', notes: '' });
    await ask(ctx.dedicated.id).expect(400);
    await owner.put('/api/resources/pricing').send(price(ctx, [{ resourceId: ctx.dedicated.id, hourlyRateCents: 700 }])).expect(200);
    await ask(ctx.dedicated.id).expect(201);
    const grid = (await pro.get(`/api/bookings/schedule?locationId=${ctx.loc.id}&date=${inDays(3)}`).expect(200)).body.resources as { id: string }[];
    expect(grid.map((r) => r.id)).toContain(ctx.dedicated.id);
    // taking the price away hides it from the grid and from new requests, but a request already made is kept
    await owner.put('/api/resources/pricing').send(price(ctx, [{ resourceId: ctx.dedicated.id, hourlyRateCents: 0 }])).expect(200);
    expect(((await pro.get(`/api/bookings/schedule?locationId=${ctx.loc.id}&date=${inDays(3)}`).expect(200)).body.resources as { id: string }[]).map((r) => r.id)).not.toContain(ctx.dedicated.id);
    await ask(ctx.dedicated.id).expect(400);
  });

  it('is no longer on the space itself: prices sent to the floor plan or the space are ignored', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const made = (await owner.post('/api/resources').send({ locationId: ctx.loc.id, kind: 'room', name: 'Sneaky', hourlyRateCents: 9_999, dailyRateCents: 1, offPeakRateCents: 1 }).expect(201)).body;
    expect(made.hourlyRateCents).toBe(0);
    await owner.patch(`/api/resources/${ctx.room.id}`).send({ hourlyRateCents: 1, name: 'Boardroom 2' }).expect(200);
    expect((await ctx.db.select().from(resources).where(eq(resources.id, ctx.room.id)).get())!.hourlyRateCents).toBe(6_000);
    const plan = await owner.post('/api/floor-plan').send({ locationId: ctx.loc.id, create: [{ kind: 'room', name: 'Plan room', hourlyRateCents: 5_000, plan: { x: 1, z: 1, rot: 0, w: 3, d: 3 } }], floors: [] });
    if (plan.status === 200 || plan.status === 201) {
      const created = (await ctx.db.select().from(resources).all()).find((r) => r.name === 'Plan room');
      expect(created?.hourlyRateCents ?? 0).toBe(0);
    }
  });
});
