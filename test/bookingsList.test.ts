import { describe, expect, it } from 'vitest';
import { inDays, login, setup } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof setup>>;

/** A room booked three times (two soon, one far off, one of them cancelled) and a plan member's desk shifts. */
async function busy(ctx: Ctx) {
  const owner = await login(ctx.app, 'owner@test.dev');
  const book = (memberId: string, date: string, startTime: string, endTime: string) =>
    owner.post('/api/bookings').send({ resourceId: ctx.room.id, memberId, date, startTime, endTime }).expect(201);
  const soon = (await book(ctx.basic.member.id, inDays(2), '10:00', '11:00')).body;
  const later = (await book(ctx.pro.member.id, inDays(2), '14:00', '15:00')).body;
  const far = (await book(ctx.basic.member.id, inDays(40), '10:00', '11:00')).body;
  const edge = (await book(ctx.basic.member.id, inDays(30), '09:00', '10:00')).body;
  await owner.post(`/api/bookings/${later.id}/cancel`).expect(200);

  const plan = (await owner.post('/api/plans').send({ locationId: ctx.loc.id, name: 'Desk plan', interval: 'month' }).expect(201)).body;
  const shift = (await owner.post('/api/shifts').send({ locationId: ctx.loc.id, planId: plan.id, name: 'Day', startTime: '09:00', endTime: '12:00', priceCents: 100_000, spaceIds: [ctx.desk.id] }).expect(201)).body;
  await owner.post('/api/members').send({ locationId: ctx.loc.id, name: 'Planned', email: 'planned@x.dev', planId: plan.id, status: 'active', startDate: inDays(1), shiftIds: [shift.id], deskIds: [ctx.desk.id] }).expect(201);
  return { owner, soon, later, far, edge };
}

describe('the booking list behind the Bookings and Calendar tabs', () => {
  it('lists what is booked from one day to another, both days included, earliest first', async () => {
    const ctx = await setup();
    const { owner, soon, later, far, edge } = await busy(ctx);
    const get = async (from: string, to: string) => (await owner.get(`/api/bookings?locationId=${ctx.loc.id}&from=${from}&to=${to}&limit=5000`).expect(200)).body as { id: string; startsAt: string; source: string; status: string }[];

    const month = await get(inDays(0), inDays(30));
    const ids = month.map((b) => b.id);
    expect(ids).toContain(soon.id);
    expect(ids).toContain(edge.id); // the last day asked for is included
    expect(ids).not.toContain(far.id); // day 40 is beyond "until"
    expect([...month].sort((a, b) => a.startsAt.localeCompare(b.startsAt)).map((b) => b.id)).toEqual(ids); // earliest first

    expect((await get(inDays(31), inDays(60))).map((b) => b.id)).toEqual([far.id]);
    const oneDay = (await get(inDays(2), inDays(2))).map((b) => b.id); // one day on its own: the room's two bookings, and the plan member's desk shifts
    expect(oneDay).toEqual(expect.arrayContaining([soon.id, later.id]));
    expect(oneDay).not.toContain(far.id);
    expect(oneDay).not.toContain(edge.id);
    // a cancelled booking is still listed, marked as cancelled, so a day box can show it greyed
    expect(month.find((b) => b.id === later.id)!.status).toBe('cancelled');
    // looking back is allowed too
    expect(await get(inDays(-30), inDays(-1))).toEqual([]);
  });

  it('can be narrowed to one space, and says whether a plan or a person made each booking', async () => {
    const ctx = await setup();
    const { owner, soon } = await busy(ctx);
    const forSpace = async (id: string) => (await owner.get(`/api/bookings?locationId=${ctx.loc.id}&resourceId=${id}&from=${inDays(0)}&to=${inDays(40)}&limit=5000`).expect(200)).body as { resourceId: string; resourceName: string; memberName: string; source: string; allDay: boolean; checkedInAt: string | null; notes: string }[];

    const room = await forSpace(ctx.room.id);
    expect(room.length).toBeGreaterThan(0);
    expect(room.every((b) => b.resourceId === ctx.room.id && b.source === 'manual')).toBe(true);
    expect(room.find((b) => b.resourceName)!.resourceName).toBe('Boardroom');
    expect(room.some((b) => b.memberName === 'basic')).toBe(true);

    const desk = await forSpace(ctx.desk.id);
    expect(desk.length).toBeGreaterThan(5); // a month of shifts
    expect(desk.every((b) => b.resourceId === ctx.desk.id && b.source === 'plan' && b.memberName === 'Planned')).toBe(true);
    expect(await forSpace(ctx.desk2.id)).toEqual([]); // an unused space has an empty calendar
    expect(soon.id).toBeTruthy();
  });

  it('shows a member only their own bookings, whatever space is asked for', async () => {
    const ctx = await setup();
    await busy(ctx);
    const pro = await login(ctx.app, 'pro@test.dev');
    const rows = (await pro.get(`/api/bookings?locationId=${ctx.loc.id}&resourceId=${ctx.room.id}&from=${inDays(0)}&to=${inDays(60)}`).expect(200)).body as { memberId: string }[];
    expect(rows.every((b) => b.memberId === ctx.pro.member.id)).toBe(true);
  });

  it('needs the bookings permission to be seen by staff in the Calendar tab', async () => {
    const ctx = await setup();
    await busy(ctx);
    // front desk staff have the bookings permission by default; a user from another business sees nothing of this location
    const desk = await login(ctx.app, 'desk@test.dev');
    expect((await desk.get(`/api/bookings?locationId=${ctx.loc.id}&from=${inDays(0)}&to=${inDays(30)}`).expect(200)).body.length).toBeGreaterThan(0);
    await (await login(ctx.app, 'owner@hive.dev')).get(`/api/bookings?locationId=${ctx.loc.id}&from=${inDays(0)}&to=${inDays(30)}`).expect(403);
  });
});
