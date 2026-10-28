import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { resources } from '../src/db/schema.js';
import { addDays, todayIn } from '../src/lib/time.js';
import { roomPriceCents, type RateCard } from '../src/services/pricing.js';
import { inDays, login, setup, TZ, tomorrow } from './helpers.js';

const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

const rack = (over: Partial<RateCard> = {}): RateCard => ({ hourlyRateCents: 6000, dailyRateCents: 2500, offPeakRateCents: null, peakStart: null, peakEnd: null, halfDayRateCents: null, fullDayRateCents: null, noPlanRateCents: null, ...over });

describe('the price of a room', () => {
  it('is the hourly rate times the hours when nothing else is set', () => {
    expect(roomPriceCents(rack(), '09:00', '11:30', true)).toBe(15000);
  });

  it('splits a booking across peak and off-peak hours', () => {
    const c = rack({ offPeakRateCents: 3000, peakStart: '09:00', peakEnd: '17:00' });
    expect(roomPriceCents(c, '08:00', '10:00', true)).toBe(9000); // an hour off-peak, an hour peak
    expect(roomPriceCents(c, '18:00', '19:00', true)).toBe(3000);
    expect(roomPriceCents(c, '10:00', '12:00', true)).toBe(12000);
  });

  it('lets a half-day or a day price win only when it is cheaper', () => {
    const c = rack({ halfDayRateCents: 20000, fullDayRateCents: 25000 });
    expect(roomPriceCents(c, '09:00', '11:00', true)).toBe(12000); // two hours is cheaper by the hour
    expect(roomPriceCents(c, '09:00', '13:00', true)).toBe(20000); // four hours: the half day
    expect(roomPriceCents(c, '09:00', '14:00', true)).toBe(25000); // five hours: the day
    expect(roomPriceCents(c, '08:00', '20:00', true)).toBe(25000);
  });

  it('charges members without a plan their own rate', () => {
    const c = rack({ noPlanRateCents: 9000 });
    expect(roomPriceCents(c, '09:00', '10:00', true)).toBe(6000);
    expect(roomPriceCents(c, '09:00', '10:00', false)).toBe(9000);
  });
});

describe('pricing, hours and status when booking', () => {
  const book = (agent: Awaited<ReturnType<typeof login>>, ctx: Awaited<ReturnType<typeof setup>>, resourceId: string, memberId: string, date: string, startTime?: string, endTime?: string) =>
    agent.post('/api/bookings').send({ resourceId, memberId, date, startTime, endTime });

  it('prices a booking with peak hours, a half day and a day pass', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    await owner.patch(`/api/resources/${ctx.room.id}`).send({ offPeakRateCents: 3000, peakStart: '09:00', peakEnd: '17:00', halfDayRateCents: 20000, fullDayRateCents: 25000 }).expect(200);

    const early = await book(owner, ctx, ctx.room.id, ctx.basic.member.id, inDays(2), '08:00', '10:00').expect(201);
    expect(early.body.priceCents).toBe(9000);
    const half = await book(owner, ctx, ctx.room.id, ctx.basic.member.id, inDays(3), '09:00', '13:00').expect(201);
    expect(half.body.priceCents).toBe(20000);
    const day = await book(owner, ctx, ctx.room.id, ctx.basic.member.id, inDays(4), '09:00', '15:00').expect(201);
    expect(day.body.priceCents).toBe(25000);
  });

  it("charges only the minutes beyond a plan's allowance", async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    await owner.patch(`/api/resources/${ctx.room.id}`).send({ fullDayRateCents: 9000 }).expect(200);
    // Pro has 60 included minutes. Three hours would be 18000 by the hour, 9000 as a day pass, and one of the three hours is free.
    const b = await book(owner, ctx, ctx.room.id, ctx.pro.member.id, inDays(2), '09:00', '12:00').expect(201);
    expect(b.body.billableMinutes).toBe(120);
    expect(b.body.priceCents).toBe(6000);
  });

  it('quotes a booking without making it, with the same price and the same refusals', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    await owner.patch(`/api/resources/${ctx.room.id}`).send({ offPeakRateCents: 3000, peakStart: '09:00', peakEnd: '17:00' }).expect(200);
    const quote = await owner.post('/api/bookings/quote').send({ resourceId: ctx.room.id, memberId: ctx.basic.member.id, date: inDays(2), startTime: '08:00', endTime: '10:00' }).expect(200);
    expect(quote.body).toMatchObject({ priceCents: 9000, billableMinutes: 120 });
    expect(((await owner.get(`/api/bookings?locationId=${ctx.loc.id}`)).body as unknown[]).length).toBe(0);
    const real = await book(owner, ctx, ctx.room.id, ctx.basic.member.id, inDays(2), '08:00', '10:00').expect(201);
    expect(real.body.priceCents).toBe(quote.body.priceCents);
    // the quote refuses what booking would: a clash, a closed day, a time outside hours
    await owner.post('/api/bookings/quote').send({ resourceId: ctx.room.id, memberId: ctx.pro.member.id, date: inDays(2), startTime: '09:00', endTime: '10:00' }).expect(409);
    await owner.post('/api/bookings/quote').send({ resourceId: ctx.room.id, memberId: ctx.pro.member.id, date: inDays(3), startTime: '03:00', endTime: '04:00' }).expect(400);
    // a member can quote for themselves, and a team member without the bookings permission cannot quote for others
    const member = await login(ctx.app, 'pro@test.dev');
    expect((await member.post('/api/bookings/quote').send({ resourceId: ctx.room.id, date: inDays(4), startTime: '09:00', endTime: '10:00' }).expect(200)).body.priceCents).toBe(0);
    await (await login(ctx.app, 'owner@hive.dev')).post('/api/bookings/quote').send({ resourceId: ctx.room.id, memberId: ctx.pro.member.id, date: inDays(4), startTime: '09:00', endTime: '10:00' }).expect(403);
  });

  it('keeps the old price when no extras are set', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const b = await book(owner, ctx, ctx.room.id, ctx.basic.member.id, inDays(2), '09:00', '10:30').expect(201);
    expect(b.body.priceCents).toBe(9000);
  });

  it('charges a member with no plan the no-plan rate, for rooms and desks', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const walkIn = await ctx.member('walkin@test.dev', null);
    await owner.patch(`/api/resources/${ctx.room.id}`).send({ noPlanRateCents: 9000 }).expect(200);
    await owner.patch(`/api/resources/${ctx.desk.id}`).send({ noPlanRateCents: 4000 }).expect(200);
    expect((await book(owner, ctx, ctx.room.id, walkIn.member.id, inDays(2), '09:00', '10:00').expect(201)).body.priceCents).toBe(9000);
    expect((await book(owner, ctx, ctx.room.id, ctx.basic.member.id, inDays(2), '11:00', '12:00').expect(201)).body.priceCents).toBe(6000);
    expect((await book(owner, ctx, ctx.desk.id, walkIn.member.id, inDays(2)).expect(201)).body.priceCents).toBe(4000);
    expect((await book(owner, ctx, ctx.desk2.id, ctx.basic.member.id, inDays(2)).expect(201)).body.priceCents).toBe(2500);
  });

  it('follows the space’s own opening hours and closed days', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    await owner.patch(`/api/resources/${ctx.room.id}`).send({ openTime: '10:00', closeTime: '16:00' }).expect(200);
    const early = await book(owner, ctx, ctx.room.id, ctx.pro.member.id, inDays(2), '09:00', '10:00').expect(400);
    expect(early.body.error).toMatch(/10:00/);
    await book(owner, ctx, ctx.room.id, ctx.pro.member.id, inDays(2), '10:00', '11:00').expect(201);

    const wd = new Date(`${inDays(3)}T00:00:00Z`).getUTCDay();
    await owner.patch(`/api/resources/${ctx.room.id}`).send({ closedWeekdays: String(wd) }).expect(200);
    const shut = await book(owner, ctx, ctx.room.id, ctx.pro.member.id, inDays(3), '10:00', '11:00').expect(400);
    expect(shut.body.error).toMatch(/closed on this day/);
    // another room is unaffected
    await book(owner, ctx, ctx.desk.id, ctx.pro.member.id, inDays(3)).expect(201);
  });

  it('refuses a bad window and an off-peak rate with no peak hours', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    await owner.patch(`/api/resources/${ctx.room.id}`).send({ openTime: '18:00', closeTime: '09:00' }).expect(400);
    await owner.patch(`/api/resources/${ctx.room.id}`).send({ openTime: '09:00' }).expect(400);
    await owner.patch(`/api/resources/${ctx.room.id}`).send({ offPeakRateCents: 1000 }).expect(400);
    await owner.patch(`/api/resources/${ctx.room.id}`).send({ peakStart: '17:00', peakEnd: '09:00' }).expect(400);
    await owner.patch(`/api/resources/${ctx.room.id}`).send({ closedWeekdays: '9' }).expect(400);
  });

  it('cannot be booked while being cleaned or reserved', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    for (const status of ['cleaning', 'reserved', 'maintenance']) {
      await owner.patch(`/api/resources/${ctx.room.id}`).send({ status }).expect(200);
      await book(owner, ctx, ctx.room.id, ctx.pro.member.id, inDays(2), '09:00', '10:00').expect(409);
    }
    await owner.patch(`/api/resources/${ctx.room.id}`).send({ status: 'available' }).expect(200);
    await book(owner, ctx, ctx.room.id, ctx.pro.member.id, inDays(2), '09:00', '10:00').expect(201);
  });
});

describe('the new kinds of space', () => {
  it('accepts the new styles and refuses a style from another kind', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const make = (kind: string, style: string, name: string) => owner.post('/api/resources').send({ locationId: ctx.loc.id, kind, style, name });
    await make('room', 'studio', 'Podcast Studio').expect(201);
    await make('room', 'interview', 'Interview Room').expect(201);
    await make('room', 'focus', 'Quiet Room').expect(201);
    await make('room', 'video_call', 'Call Room').expect(201);
    await make('corporate_room', 'event_hall', 'Event Hall').expect(201);
    await make('hot_desk', 'day_office', 'Day Office 1').expect(201);
    await make('dedicated_desk', 'team_pod', 'Pod A').expect(201);
    await make('storage', 'locker', 'Locker 1').expect(201);
    await make('storage', 'mailbox', 'Mailbox 1').expect(201);
    await make('storage', 'parking', 'Bay 1').expect(201);
    await make('storage', 'studio', 'Wrong').expect(400);
    await make('room', 'locker', 'Wrong 2').expect(400);
  });

  it('lets lockers, mailboxes and parking be assigned to a member, but not booked', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const locker = (await owner.post('/api/resources').send({ locationId: ctx.loc.id, kind: 'storage', style: 'locker', name: 'Locker 7' }).expect(201)).body;
    await owner.post('/api/bookings').send({ resourceId: locker.id, memberId: ctx.pro.member.id, date: tomorrow() }).expect(400);
    await owner.post('/api/assignments').send({ resourceId: locker.id, memberId: ctx.pro.member.id, startDate: todayIn(TZ) }).expect(201);
    await owner.post('/api/assignments').send({ resourceId: locker.id, memberId: ctx.basic.member.id, startDate: todayIn(TZ) }).expect(409);
    const list = (await owner.get(`/api/resources?locationId=${ctx.loc.id}`)).body as { id: string; occupied: boolean }[];
    expect(list.find((x) => x.id === locker.id)?.occupied).toBe(true);
    // and it can be rented on a contract
    await owner.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.basic.member.id, resourceId: locker.id, startDate: tomorrow() }).expect(201);
    const dash = (await owner.get(`/api/reports/dashboard?locationId=${ctx.loc.id}`)).body;
    expect(dash.ops.storage).toEqual({ total: 1, assigned: 1 });
  });

  it('keeps the descriptions and hours a space was given', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const r = await owner.patch(`/api/resources/${ctx.room.id}`).send({ description: 'A bright room with a projector.', openTime: '09:00', closeTime: '18:00' }).expect(200);
    expect(r.body).toMatchObject({ description: 'A bright room with a projector.', openTime: '09:00', closeTime: '18:00' });
    const member = await login(ctx.app, 'pro@test.dev');
    const seen = (await member.get(`/api/resources/${ctx.room.id}`).expect(200)).body;
    expect(seen.description).toBe('A bright room with a projector.');
  });
});

describe('photos of a space', () => {
  it('stores a photo, lists it, serves it to members and removes it', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const up = await owner.post(`/api/resources/${ctx.room.id}/photos`).set('Content-Type', 'image/png').send(png()).expect(201);
    const list = (await owner.get(`/api/resources?locationId=${ctx.loc.id}`)).body as { id: string; photoIds: string[] }[];
    expect(list.find((x) => x.id === ctx.room.id)?.photoIds).toEqual([up.body.id]);

    const member = await login(ctx.app, 'pro@test.dev');
    const file = await member.get(`/api/resources/photos/${up.body.id}/file`).expect(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(file.body as Buffer).length).toBeGreaterThan(0);

    await owner.delete(`/api/resources/${ctx.room.id}/photos/${up.body.id}`).expect(204);
    await member.get(`/api/resources/photos/${up.body.id}/file`).expect(404);
  });

  it('refuses anything that is not a real photo, too many photos, and people without the permission', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    await owner.post(`/api/resources/${ctx.room.id}/photos`).set('Content-Type', 'image/png').send(Buffer.from('<svg onload=alert(1)>')).expect(400);
    await owner.post(`/api/resources/${ctx.room.id}/photos`).set('Content-Type', 'image/svg+xml').send(Buffer.from('<svg/>')).expect(400);
    await owner.post(`/api/resources/${ctx.room.id}/photos`).set('Content-Type', 'text/html').send(Buffer.from('<p>')).expect(400);
    for (let i = 0; i < 8; i++) await owner.post(`/api/resources/${ctx.room.id}/photos`).set('Content-Type', 'image/png').send(png()).expect(201);
    await owner.post(`/api/resources/${ctx.room.id}/photos`).set('Content-Type', 'image/png').send(png()).expect(409);

    await (await login(ctx.app, 'desk@test.dev')).post(`/api/resources/${ctx.desk.id}/photos`).set('Content-Type', 'image/png').send(png()).expect(403);
    await (await login(ctx.app, 'pro@test.dev')).post(`/api/resources/${ctx.desk.id}/photos`).set('Content-Type', 'image/png').send(png()).expect(403);
  });

  it('never shows another tenant’s photos', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const up = await owner.post(`/api/resources/${ctx.room.id}/photos`).set('Content-Type', 'image/png').send(png()).expect(201);
    const hive = await login(ctx.app, 'owner@hive.dev');
    await hive.get(`/api/resources/photos/${up.body.id}/file`).expect(403);
    await hive.get(`/api/resources/${ctx.room.id}`).expect(403);
  });
});

describe('structure, facilities and templates on the floor plan', () => {
  const put = (agent: Awaited<ReturnType<typeof login>>, locationId: string, objects: object[]) => agent.put('/api/floor-plan').send({ locationId, objects: { upsert: objects } });
  const obj = (type: string, x = 0, extra: object = {}) => ({ type, floor: '1', label: '', x, z: 0, rot: 0, w: null, d: null, ...extra });

  it('saves the new kinds of object with their variant and colour', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    await put(owner, ctx.loc.id, [
      obj('washroom_women', 0),
      obj('prayer_room', 5),
      obj('wall', 10, { w: 6, d: 0.2 }),
      obj('door', 12, { variant: 'double' }),
      obj('zone', 14, { variant: 'l', tint: 'blue', label: 'Quiet zone', w: 8, d: 6 }),
      obj('fire_exit', 20),
      obj('terrace', 22),
    ]).expect(200);
    const saved = (await owner.get(`/api/floor-plan/objects?locationId=${ctx.loc.id}`)).body as { type: string; variant: string; tint: string; label: string }[];
    expect(saved).toHaveLength(7);
    expect(saved.find((o) => o.type === 'zone')).toMatchObject({ variant: 'l', tint: 'blue', label: 'Quiet zone' });
    expect(saved.find((o) => o.type === 'door')?.variant).toBe('double');
  });

  it('refuses an unknown object, variant or colour', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    await put(owner, ctx.loc.id, [obj('hovercraft')]).expect(400);
    await put(owner, ctx.loc.id, [obj('zone', 0, { variant: 'star' })]).expect(400);
    await put(owner, ctx.loc.id, [obj('zone', 0, { tint: 'neon' })]).expect(400);
  });

  it('saves a template, lists it for the whole organization, and deletes it', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const things = [
      { type: 'resource', kind: 'hot_desk', style: 'standard', name: 'Hot Desk 1', capacity: 1, hourlyRateCents: 0, dailyRateCents: 2500, amenities: '', x: 0, z: 0, rot: 0, w: null, d: null },
      { type: 'object', object: 'plant', label: '', variant: '', tint: '', x: 2, z: 0, rot: 0, w: null, d: null },
    ];
    const made = await owner.post('/api/floor-plan/templates').send({ name: 'Open plan pod', things }).expect(201);
    await owner.post('/api/floor-plan/templates').send({ name: 'Open plan pod', things }).expect(409);
    const list = (await owner.get('/api/floor-plan/templates').expect(200)).body as { id: string; name: string; things: unknown[] }[];
    expect(list).toHaveLength(1);
    expect(list[0]!.things).toHaveLength(2);

    await owner.post('/api/floor-plan/templates').send({ name: 'Empty', things: [] }).expect(400);
    await owner.post('/api/floor-plan/templates').send({ name: 'Bad', things: [{ type: 'resource', kind: 'spaceship' }] }).expect(400);
    await (await login(ctx.app, 'desk@test.dev')).get('/api/floor-plan/templates').expect(403);
    await (await login(ctx.app, 'owner@hive.dev')).delete(`/api/floor-plan/templates/${made.body.id}`).expect(403);
    await owner.delete(`/api/floor-plan/templates/${made.body.id}`).expect(204);
    await owner.delete(`/api/floor-plan/templates/${made.body.id}`).expect(404);
  });
});

describe('cleaning and maintenance schedule', () => {
  it('runs a repeating job round and finishes a one-off', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'manager@test.dev');
    const today = todayIn(TZ);
    const weekly = (await staff.post('/api/tasks').send({ locationId: ctx.loc.id, resourceId: ctx.room.id, kind: 'cleaning', title: 'Deep clean', everyDays: 7, nextDue: addDays(today, -2) }).expect(201)).body;
    const once = (await staff.post('/api/tasks').send({ locationId: ctx.loc.id, kind: 'inspection', title: 'Fire drill', nextDue: today }).expect(201)).body;

    const list = (await staff.get(`/api/tasks?locationId=${ctx.loc.id}`)).body as { id: string; overdue: boolean; resourceName: string | null }[];
    expect(list.find((t) => t.id === weekly.id)).toMatchObject({ overdue: true, resourceName: 'Boardroom' });
    expect(list.find((t) => t.id === once.id)?.overdue).toBe(false);

    const done = await staff.post(`/api/tasks/${weekly.id}/done`).send({ note: 'All good' }).expect(200);
    expect(done.body.nextDue).toBe(addDays(today, 7));
    const finished = await staff.post(`/api/tasks/${once.id}/done`).send({}).expect(200);
    expect(finished.body.active).toBe(false);
    expect(((await staff.get(`/api/tasks?locationId=${ctx.loc.id}`)).body as unknown[]).length).toBe(1);
    expect(((await staff.get(`/api/tasks?locationId=${ctx.loc.id}&all=1`)).body as unknown[]).length).toBe(2);
    const logs = (await staff.get(`/api/tasks/${weekly.id}/logs`)).body as { note: string }[];
    expect(logs).toHaveLength(1);
    expect(logs[0]!.note).toBe('All good');

    await staff.patch(`/api/tasks/${weekly.id}`).send({ title: 'Deeper clean', everyDays: 14 }).expect(200);
    await staff.delete(`/api/tasks/${weekly.id}`).expect(204);
  });

  it('needs the maintenance permission and stays inside the tenant', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const task = (await owner.post('/api/tasks').send({ locationId: ctx.loc.id, title: 'Water the plants', everyDays: 3 }).expect(201)).body;
    await (await login(ctx.app, 'desk@test.dev')).get(`/api/tasks?locationId=${ctx.loc.id}`).expect(403);
    await (await login(ctx.app, 'pro@test.dev')).get(`/api/tasks?locationId=${ctx.loc.id}`).expect(403);
    const hive = await login(ctx.app, 'owner@hive.dev');
    await hive.get(`/api/tasks?locationId=${ctx.loc.id}`).expect(403);
    await hive.post(`/api/tasks/${task.id}/done`).send({}).expect(403);
    await owner.post('/api/tasks').send({ locationId: ctx.loc.id, resourceId: ctx.room.id, title: 'x', nextDue: 'soon' }).expect(400);
    await owner.post('/api/tasks').send({ locationId: ctx.other.id, resourceId: ctx.room.id, title: 'wrong location' }).expect(404);
  });
});

describe('equipment', () => {
  it('records, edits and removes equipment of a space', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'manager@test.dev');
    const a = (await staff.post('/api/assets').send({ locationId: ctx.loc.id, resourceId: ctx.room.id, name: 'Projector', category: 'AV', serialNumber: 'EP-1234', purchasedOn: '2026-01-15', warrantyUntil: '2028-01-15' }).expect(201)).body;
    await staff.post('/api/assets').send({ locationId: ctx.loc.id, name: 'Spare monitors' }).expect(201);
    const mine = (await staff.get(`/api/assets?locationId=${ctx.loc.id}&resourceId=${ctx.room.id}`)).body as { name: string; resourceName: string }[];
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: 'Projector', resourceName: 'Boardroom' });
    expect(((await staff.get(`/api/assets?locationId=${ctx.loc.id}`)).body as unknown[]).length).toBe(2);
    await staff.patch(`/api/assets/${a.id}`).send({ status: 'needs_repair' }).expect(200);
    expect(((await staff.get(`/api/assets?locationId=${ctx.loc.id}&status=needs_repair`)).body as unknown[]).length).toBe(1);
    await staff.patch(`/api/assets/${a.id}`).send({ status: 'broken' }).expect(400);
    await (await login(ctx.app, 'desk@test.dev')).get(`/api/assets?locationId=${ctx.loc.id}`).expect(403);
    await (await login(ctx.app, 'owner@hive.dev')).delete(`/api/assets/${a.id}`).expect(403);
    await staff.delete(`/api/assets/${a.id}`).expect(204);
  });
});

describe('problems reported about a space', () => {
  it('lets a member report one, and see only their own', async () => {
    const ctx = await setup();
    const member = await login(ctx.app, 'pro@test.dev');
    const other = await login(ctx.app, 'basic@test.dev');
    const mine = (await member.post('/api/issues').send({ resourceId: ctx.room.id, title: 'AC not working', description: 'Very warm', priority: 'urgent' }).expect(201)).body;
    await other.post('/api/issues').send({ resourceId: ctx.room.id, title: 'Light flickers' }).expect(201);

    const seen = (await member.get(`/api/issues?locationId=${ctx.loc.id}`).expect(200)).body as { id: string; title: string; reporter: string; resourceName: string }[];
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: mine.id, title: 'AC not working', resourceName: 'Boardroom' });
    await member.patch(`/api/issues/${mine.id}`).send({ status: 'resolved' }).expect(403);
    await member.get(`/api/issues/open/by-space?locationId=${ctx.loc.id}`).expect(403);
  });

  it('is handled by someone with the maintenance permission, who can turn it into a task', async () => {
    const ctx = await setup();
    const member = await login(ctx.app, 'pro@test.dev');
    const issue = (await member.post('/api/issues').send({ resourceId: ctx.room.id, title: 'AC not working' }).expect(201)).body;
    const staff = await login(ctx.app, 'manager@test.dev');
    expect(((await staff.get(`/api/issues?locationId=${ctx.loc.id}`)).body as unknown[]).length).toBe(1);
    expect((await staff.get(`/api/issues/open/by-space?locationId=${ctx.loc.id}`)).body).toEqual({ [ctx.room.id]: 1 });

    const task = (await staff.post(`/api/issues/${issue.id}/task`).send({}).expect(201)).body;
    expect(task).toMatchObject({ kind: 'maintenance', resourceId: ctx.room.id, title: 'Fix: AC not working' });
    await staff.post(`/api/issues/${issue.id}/task`).send({}).expect(400);
    let now = (await staff.get(`/api/issues?locationId=${ctx.loc.id}`)).body[0];
    expect(now).toMatchObject({ status: 'in_progress', taskId: task.id });

    await staff.patch(`/api/issues/${issue.id}`).send({ status: 'resolved', resolution: 'Filter replaced' }).expect(200);
    now = (await staff.get(`/api/issues?locationId=${ctx.loc.id}`)).body[0];
    expect(now.status).toBe('resolved');
    expect(now.resolvedAt).toBeTruthy();
    await staff.patch(`/api/issues/${issue.id}`).send({ status: 'open' }).expect(200);
    expect((await staff.get(`/api/issues?locationId=${ctx.loc.id}`)).body[0].resolvedAt).toBeNull();
    expect((await staff.get(`/api/issues/open/by-space?locationId=${ctx.loc.id}`)).body).toEqual({ [ctx.room.id]: 1 });
  });

  it('keeps front desk staff to their own reports, and tenants apart', async () => {
    const ctx = await setup();
    const member = await login(ctx.app, 'pro@test.dev');
    await member.post('/api/issues').send({ resourceId: ctx.room.id, title: 'Broken chair' }).expect(201);
    const desk = await login(ctx.app, 'desk@test.dev');
    expect(((await desk.get(`/api/issues?locationId=${ctx.loc.id}`)).body as unknown[]).length).toBe(0);
    await desk.post('/api/issues').send({ resourceId: ctx.desk.id, title: 'Desk wobbles' }).expect(201);
    expect(((await desk.get(`/api/issues?locationId=${ctx.loc.id}`)).body as unknown[]).length).toBe(1);

    const hive = await login(ctx.app, 'owner@hive.dev');
    await hive.post('/api/issues').send({ resourceId: ctx.room.id, title: 'Not yours' }).expect(403);
    await member.post('/api/issues').send({ resourceId: 'nope', title: 'x' }).expect(404);
    await member.post('/api/issues').send({ resourceId: ctx.room.id, title: '' }).expect(400);
  });
});

describe('how busy each space has been', () => {
  it('measures rooms in hours, desks in days and assigned spaces in days held', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const today = todayIn(TZ);
    // closed weekdays would make the denominators awkward, so start with none
    await owner.post('/api/bookings').send({ resourceId: ctx.room.id, memberId: ctx.pro.member.id, date: inDays(1), startTime: '09:00', endTime: '12:00' }).expect(201);
    await owner.post('/api/bookings').send({ resourceId: ctx.desk.id, memberId: ctx.pro.member.id, date: inDays(1) }).expect(201);
    await owner.post('/api/assignments').send({ resourceId: ctx.dedicated.id, memberId: ctx.pro.member.id, startDate: today }).expect(201);

    const rep = (await owner.get(`/api/reports/occupancy?locationId=${ctx.loc.id}&days=10&to=${inDays(5)}`).expect(200)).body as {
      days: number;
      items: { name: string; utilization: number; used: number; unit: string }[];
    };
    expect(rep.days).toBe(10);
    const room = rep.items.find((i) => i.name === 'Boardroom')!;
    expect(room).toMatchObject({ unit: 'hours', used: 3 });
    expect(room.utilization).toBeCloseTo(3 / (10 * 12), 3);
    const desk = rep.items.find((i) => i.name === 'Desk 1')!;
    expect(desk).toMatchObject({ unit: 'days', used: 1 });
    expect(desk.utilization).toBeCloseTo(1 / 10, 3);
    const dedicated = rep.items.find((i) => i.name === 'Desk D1')!;
    expect(dedicated.unit).toBe('days');
    expect(dedicated.used).toBe(6); // today to day 5 of the window
    expect((await (await login(ctx.app, 'pro@test.dev')).get(`/api/reports/occupancy?locationId=${ctx.loc.id}`)).status).toBe(403);
    await (await login(ctx.app, 'desk@test.dev')).get(`/api/reports/occupancy?locationId=${ctx.loc.id}`).expect(200);
  });

  it('leaves out the days the location is closed', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    await owner.post(`/api/locations/${ctx.loc.id}/holidays`).send({ date: inDays(2), name: 'Holiday' }).expect(201);
    const rep = (await owner.get(`/api/reports/occupancy?locationId=${ctx.loc.id}&days=5&to=${inDays(4)}`)).body as { openDays: number };
    expect(rep.openDays).toBe(4);
    // sanity: the DB was not changed by reading
    const row = await ctx.db.select().from(resources).where(eq(resources.id, ctx.room.id)).get();
    expect(row?.status).toBe('available');
  });
});
