import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { amenityOrders, bookings, members } from '../src/db/schema.js';
import { inDays, login, setup } from './helpers.js';

async function withTea(price = 200) {
  const ctx = await setup();
  const owner = await login(ctx.app, 'owner@test.dev');
  const tea = (await owner.post('/api/amenities').send({ locationId: ctx.loc.id, name: 'Tea', priceCents: price }).expect(201)).body;
  return { ctx, owner, tea };
}

describe('amenities', () => {
  it('lets the owner keep a list of amenities with a name and a price, and the front desk but not a member read it', async () => {
    const { ctx, owner, tea } = await withTea();
    expect(tea).toMatchObject({ name: 'Tea', priceCents: 200, active: true });
    await owner.patch(`/api/amenities/${tea.id}`).send({ priceCents: 250 }).expect(200);
    const list = (await owner.get(`/api/amenities?locationId=${ctx.loc.id}`).expect(200)).body;
    expect(list).toMatchObject([{ name: 'Tea', priceCents: 250 }]);
    const desk = await login(ctx.app, 'desk@test.dev');
    await desk.get(`/api/amenities?locationId=${ctx.loc.id}`).expect(200);
    await desk.post('/api/amenities').send({ locationId: ctx.loc.id, name: 'Coffee', priceCents: 300 }).expect(403); // setup is the owner's
    const pro = await login(ctx.app, 'pro@test.dev');
    await pro.get(`/api/amenities?locationId=${ctx.loc.id}`).expect(403);
  });

  it('gives the free amount to members when they are added or edited', async () => {
    const { ctx, owner, tea } = await withTea();
    const made = (await owner.post('/api/members').send({ locationId: ctx.loc.id, name: 'Sam', email: 'sam@x.dev', amenities: [{ amenityId: tea.id, freePerDay: 2 }], meetingCredits: 4 }).expect(201)).body;
    expect(made.meetingCredits).toBe(4);
    let detail = (await owner.get(`/api/members/${made.id}`).expect(200)).body;
    expect(detail.amenities).toMatchObject([{ name: 'Tea', freePerDay: 2, usedToday: 0 }]);
    await owner.patch(`/api/members/${made.id}`).send({ amenities: [{ amenityId: tea.id, freePerDay: 5 }], meetingCredits: 6 }).expect(200);
    detail = (await owner.get(`/api/members/${made.id}`).expect(200)).body;
    expect(detail.amenities[0].freePerDay).toBe(5);
    expect(detail.meetingCredits).toBe(6);
    await owner.patch(`/api/members/${made.id}`).send({ amenities: [] }).expect(200);
    expect((await owner.get(`/api/members/${made.id}`).expect(200)).body.amenities).toHaveLength(0);
    // another place's amenity cannot be given
    const uptown = (await owner.post('/api/amenities').send({ locationId: ctx.other.id, name: 'Juice', priceCents: 100 }).expect(201)).body;
    await owner.patch(`/api/members/${made.id}`).send({ amenities: [{ amenityId: uptown.id, freePerDay: 1 }] }).expect(400);
  });

  it('charges only what is beyond the free amount for the day, and keeps the total to collect', async () => {
    const { ctx, owner, tea } = await withTea(200);
    await owner.patch(`/api/members/${ctx.pro.member.id}`).send({ amenities: [{ amenityId: tea.id, freePerDay: 2 }] }).expect(200);
    const desk = await login(ctx.app, 'desk@test.dev');
    const order = (qty: number) => desk.post('/api/amenities/orders').send({ memberId: ctx.pro.member.id, amenityId: tea.id, quantity: qty });
    expect((await order(1).expect(201)).body).toMatchObject({ quantity: 1, freeQuantity: 1, chargeCents: 0 });
    expect((await order(1).expect(201)).body).toMatchObject({ freeQuantity: 1, chargeCents: 0 });
    expect((await order(1).expect(201)).body).toMatchObject({ freeQuantity: 0, chargeCents: 200 }); // the third is paid
    expect((await order(2).expect(201)).body).toMatchObject({ freeQuantity: 0, chargeCents: 400 });
    // a member with no free amount pays for the first one
    expect((await desk.post('/api/amenities/orders').send({ memberId: ctx.basic.member.id, amenityId: tea.id, quantity: 1 }).expect(201)).body.chargeCents).toBe(200);
    // one order that straddles the limit is split
    const other = (await owner.post('/api/members').send({ locationId: ctx.loc.id, name: 'Kim', email: 'kim@x.dev', amenities: [{ amenityId: tea.id, freePerDay: 2 }] }).expect(201)).body;
    expect((await desk.post('/api/amenities/orders').send({ memberId: other.id, amenityId: tea.id, quantity: 3 }).expect(201)).body).toMatchObject({ freeQuantity: 2, chargeCents: 200 });
    // the free amount starts again tomorrow
    await ctx.db.update(amenityOrders).set({ date: inDays(-1) }).where(eq(amenityOrders.memberId, ctx.pro.member.id)).run();
    expect((await order(1).expect(201)).body).toMatchObject({ freeQuantity: 1, chargeCents: 0 });
  });

  it('shows the member what they owe, shows finance what to collect, and counts it as income once collected', async () => {
    const { ctx, owner, tea } = await withTea(200);
    const desk = await login(ctx.app, 'desk@test.dev');
    await desk.post('/api/amenities/orders').send({ memberId: ctx.basic.member.id, amenityId: tea.id, quantity: 3 }).expect(201);
    const pro = await login(ctx.app, 'basic@test.dev');
    expect((await pro.get('/api/me/summary').expect(200)).body.amenityDueCents).toBe(600);

    const finance = async () => (await owner.get(`/api/reports/finance?locationId=${ctx.loc.id}`).expect(200)).body;
    let f = await finance();
    expect(f.amenities).toMatchObject({ owedCents: 600, collectedCents: 0, owedBy: [{ name: 'basic', owedCents: 600 }] });
    expect(f.totals.collectedCents).toBe(0);

    await desk.post('/api/amenities/collect').send({ memberId: ctx.basic.member.id }).expect(200);
    await desk.post('/api/amenities/collect').send({ memberId: ctx.basic.member.id }).expect(409); // nothing left to collect
    expect((await pro.get('/api/me/summary').expect(200)).body.amenityDueCents).toBe(0);
    f = await finance();
    expect(f.amenities).toMatchObject({ owedCents: 0, collectedCents: 600, owedBy: [] });
    expect(f.totals.collectedCents).toBe(600);
    expect(f.incomeByKind).toContainEqual({ kind: 'amenities', amountCents: 600 });
  });

  it('keeps the history when an amenity is removed, and stops a member who was given amenities from being deleted', async () => {
    const { ctx, owner, tea } = await withTea();
    const desk = await login(ctx.app, 'desk@test.dev');
    await desk.post('/api/amenities/orders').send({ memberId: ctx.basic.member.id, amenityId: tea.id, quantity: 1 }).expect(201);
    await owner.delete(`/api/amenities/${tea.id}`).expect(204);
    expect((await owner.get(`/api/amenities?locationId=${ctx.loc.id}`).expect(200)).body).toHaveLength(0);
    await desk.post('/api/amenities/orders').send({ memberId: ctx.basic.member.id, amenityId: tea.id, quantity: 1 }).expect(400); // no longer offered
    expect(await ctx.db.select().from(amenityOrders).all()).toHaveLength(1);
    await owner.delete(`/api/members/${ctx.basic.member.id}`).expect(409);
  });
});

describe('meeting room credit hours', () => {
  const book = (agent: Awaited<ReturnType<typeof login>>, ctx: Awaited<ReturnType<typeof setup>>, memberId: string, startTime: string, endTime: string) =>
    agent.post('/api/bookings').send({ resourceId: ctx.room.id, memberId, date: inDays(2), startTime, endTime, notes: '' });

  it('treats two credit hours as one free hour, and charges the room rate for the rest', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    // Basic has no included minutes; 4 credit hours are 2 free hours a month.
    await owner.patch(`/api/members/${ctx.basic.member.id}`).send({ meetingCredits: 4 }).expect(200);
    expect((await ctx.db.select().from(members).where(eq(members.id, ctx.basic.member.id)).get())!.meetingCredits).toBe(4);
    const first = (await book(owner, ctx, ctx.basic.member.id, '09:00', '11:00').expect(201)).body;
    expect(first).toMatchObject({ priceCents: 0, billableMinutes: 0 }); // both hours are free
    const second = (await book(owner, ctx, ctx.basic.member.id, '12:00', '13:30').expect(201)).body;
    expect(second).toMatchObject({ priceCents: 9_000, billableMinutes: 90 }); // all of it is beyond the credits: 1.5 hours at the room rate
    expect(await ctx.db.select().from(bookings).where(eq(bookings.memberId, ctx.basic.member.id)).all()).toHaveLength(2);
  });

  it('splits one booking between the free time left and the paid rest, and adds to the plan\'s own minutes', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    // Pro has 60 included minutes; 2 credit hours add another hour.
    await owner.patch(`/api/members/${ctx.pro.member.id}`).send({ meetingCredits: 2 }).expect(200);
    expect((await book(owner, ctx, ctx.pro.member.id, '09:00', '12:00').expect(201)).body).toMatchObject({ billableMinutes: 60, priceCents: 6_000 }); // 2 free hours, 1 paid
    const me = (await (await login(ctx.app, 'pro@test.dev')).get('/api/me/summary').expect(200)).body;
    expect(me.meetingMinutes.included).toBe(120); // 60 from the plan, 60 from the credit hours
  });
});
