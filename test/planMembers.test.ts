import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { attendance, bookings, invoiceItems, invoices, locations, memberDesks, memberShifts, members, resources, users } from '../src/db/schema.js';
import { addDays, localDate } from '../src/lib/time.js';
import { inDays, login, setup, TZ } from './helpers.js';

/** A monthly plan with Morning (9 to 12, Rs 5,000) and Evening (16 to 20, Rs 4,000) on three hot desks. */
async function planWithShifts(ctx: Awaited<ReturnType<typeof setup>>, interval: 'month' | 'day' = 'month') {
  const owner = await login(ctx.app, 'owner@test.dev');
  const plan = (await owner.post('/api/plans').send({ locationId: ctx.loc.id, name: `Hot Desk ${interval}`, interval }).expect(201)).body;
  const desks = [ctx.desk, ctx.desk2];
  const extra = await ctx.db.insert(resources).values({ locationId: ctx.loc.id, kind: 'hot_desk', name: `Desk 3 ${interval}` }).returning().get();
  desks.push(extra);
  const shift = async (name: string, startTime: string, endTime: string, priceCents: number) =>
    (await owner.post('/api/shifts').send({ locationId: ctx.loc.id, planId: plan.id, name, startTime, endTime, priceCents, spaceIds: desks.map((d) => d.id) }).expect(201)).body;
  const morning = await shift('Morning', '09:00', '12:00', 500_000);
  const evening = await shift('Evening', '16:00', '20:00', 400_000);
  return { owner, plan, morning, evening, desks };
}

const newMember = (ctx: Awaited<ReturnType<typeof setup>>, p: Awaited<ReturnType<typeof planWithShifts>>, extra: Record<string, unknown> = {}) =>
  p.owner.post('/api/members').send({ locationId: ctx.loc.id, name: 'New Person', email: 'new@x.dev', planId: p.plan.id, status: 'active', startDate: inDays(1), shiftIds: [p.morning.id], deskIds: [p.desks[0]!.id], ...extra });

describe('a member created with a plan, shifts and desks', () => {
  it('needs at least one shift when the plan has shifts', async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    await newMember(ctx, p, { shiftIds: [], deskIds: [] }).expect(400);
    await newMember(ctx, p, { planId: null }).expect(400); // shifts belong to a plan
    await newMember(ctx, p, { shiftIds: [], deskIds: [p.desks[0]!.id] }).expect(400);
  });

  it('books each desk for each shift on open days, with the plan paying: the Bookings tab shows them', async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    const res = await newMember(ctx, p, { shiftIds: [p.morning.id, p.evening.id], deskIds: [p.desks[0]!.id, p.desks[1]!.id] }).expect(201);
    const rows = await ctx.db.select().from(bookings).where(eq(bookings.memberId, res.body.id)).all();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((b) => b.source === 'plan' && b.priceCents === 0 && b.status === 'confirmed')).toBe(true);
    // both desks, both shifts, so bookings come in fours per open day
    expect(rows.length % 4).toBe(0);
    const first = rows.filter((b) => b.resourceId === p.desks[0]!.id).sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0]!;
    expect(new Date(first.startsAt).getTime()).toBeLessThan(new Date(first.endsAt).getTime());

    const list = await p.owner.get(`/api/bookings?locationId=${ctx.loc.id}&from=${inDays(1)}&to=${inDays(1)}`).expect(200);
    expect(list.body.filter((b: { memberId: string }) => b.memberId === res.body.id).length).toBeGreaterThan(0);

    // the price is the shifts added together, billed once for the period
    const billed = await ctx.db.select().from(invoices).where(eq(invoices.memberId, res.body.id)).all();
    expect(billed).toHaveLength(1);
    expect(billed[0]!.subtotalCents).toBe(900_000);
  });

  it('hides desks someone already holds in those shift times, and refuses them when asked for anyway', async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    await newMember(ctx, p, { shiftIds: [p.morning.id], deskIds: [p.desks[0]!.id] }).expect(201);
    const ask = (shiftIds: string[]) => p.owner.get(`/api/members/available-spaces?locationId=${ctx.loc.id}&planId=${p.plan.id}&shiftIds=${shiftIds.join(',')}&startDate=${inDays(1)}`).expect(200);
    const morning = (await ask([p.morning.id])).body.spaces.map((s: { id: string }) => s.id);
    expect(morning).not.toContain(p.desks[0]!.id);
    expect(morning).toContain(p.desks[1]!.id);
    // the same desk is still free in the evening
    expect((await ask([p.evening.id])).body.spaces.map((s: { id: string }) => s.id)).toContain(p.desks[0]!.id);
    await newMember(ctx, p, { email: 'two@x.dev', shiftIds: [p.morning.id], deskIds: [p.desks[0]!.id] }).expect(409);
  });

  it('runs for a month on a monthly plan and one day on a day pass', async () => {
    const ctx = await setup();
    const m = await planWithShifts(ctx, 'month');
    const mem = await newMember(ctx, m).expect(201);
    expect(mem.body.planStart).toBe(inDays(1));
    expect(mem.body.planEnd).toBe(addDays(addMonthsOne(inDays(1)), -1));

    const d = await planWithShifts(ctx, 'day');
    const pass = await newMember(ctx, d, { email: 'day@x.dev', shiftIds: [d.morning.id], deskIds: [d.desks[1]!.id] }).expect(201);
    expect(pass.body.planEnd).toBe(inDays(1));
    const rows = await ctx.db.select().from(bookings).where(eq(bookings.memberId, pass.body.id)).all();
    expect(rows).toHaveLength(1); // one desk, one shift, one day
    expect(localDate(rows[0]!.startsAt, TZ)).toBe(inDays(1));
  });

  it('can be renewed after the period, with the same shifts and desks, and not before it ends', async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    const mem = (await newMember(ctx, p).expect(201)).body;
    // A month early: not allowed yet.
    const early = await p.owner.post(`/api/members/${mem.id}/renew`).send({}).expect(400);
    expect(JSON.stringify(early.body)).toMatch(/Renewal opens 2 days before/);
    // Two days before it ends, renewing opens.
    await ctx.db.update(members).set({ planEnd: inDays(2) }).where(eq(members.id, mem.id)).run();
    mem.planEnd = inDays(2);
    await p.owner.post(`/api/members/${mem.id}/renew`).send({ startDate: inDays(1) }).expect(400); // overlaps the current period
    const next = await p.owner.post(`/api/members/${mem.id}/renew`).send({}).expect(200);
    expect(next.body.start).toBe(addDays(mem.planEnd, 1));
    const detail = (await p.owner.get(`/api/members/${mem.id}`).expect(200)).body;
    expect(detail.planEnd).toBe(next.body.end);
    expect(detail.shifts.map((s: { name: string }) => s.name)).toEqual(['Morning']);
    expect(detail.desks).toHaveLength(1);
  });

  it('keeps a desk free for a shift from being given to a second plan member, and lets offices and dedicated desks be given too', async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    const office = await ctx.db.insert(resources).values({ locationId: ctx.loc.id, kind: 'office', name: 'Suite 1', capacity: 1 }).returning().get();
    const s = (await p.owner.post('/api/shifts').send({ locationId: ctx.loc.id, planId: p.plan.id, name: 'Office day', startTime: '08:00', endTime: '17:00', priceCents: 1_000_000, spaceIds: [office.id, ctx.dedicated.id] }).expect(201)).body;
    await newMember(ctx, p, { shiftIds: [s.id], deskIds: [office.id] }).expect(201);
    await newMember(ctx, p, { email: 'b@x.dev', shiftIds: [s.id], deskIds: [office.id] }).expect(409);
    await newMember(ctx, p, { email: 'c@x.dev', shiftIds: [s.id], deskIds: [ctx.dedicated.id] }).expect(201);
  });

  it('skips closed weekdays and cancels future plan bookings when the member is cancelled', async () => {
    const ctx = await setup();
    const wd = new Date(`${inDays(1)}T00:00:00Z`).getUTCDay();
    await ctx.db.update(locations).set({ closedWeekdays: String(wd) }).where(eq(locations.id, ctx.loc.id)).run();
    const p = await planWithShifts(ctx);
    const mem = (await newMember(ctx, p).expect(201)).body;
    const rows = await ctx.db.select().from(bookings).where(eq(bookings.memberId, mem.id)).all();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((b) => localDate(b.startsAt, TZ) === inDays(1))).toBe(false); // the first day is a closed weekday
    expect(rows.some((b) => localDate(b.startsAt, TZ) === inDays(2))).toBe(true);
    await p.owner.patch(`/api/members/${mem.id}`).send({ status: 'cancelled' }).expect(200);
    const after = await ctx.db.select().from(bookings).where(eq(bookings.memberId, mem.id)).all();
    expect(after.every((b) => b.status === 'cancelled')).toBe(true);
  });
});

describe('changing a member\'s plan, shifts and desks', () => {
  const put = (p: Awaited<ReturnType<typeof planWithShifts>>, id: string, body: Record<string, unknown>) => p.owner.put(`/api/members/${id}/plan`).send(body);

  it('re-books what has not happened yet and replaces an unpaid invoice with the new total', async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    const mem = (await newMember(ctx, p).expect(201)).body; // Morning on desk 1, from tomorrow
    const before = await ctx.db.select().from(bookings).where(eq(bookings.memberId, mem.id)).all();
    expect(before.length).toBeGreaterThan(0);

    // They forgot the evening shift and a second desk.
    const res = await put(p, mem.id, { planId: p.plan.id, shiftIds: [p.morning.id, p.evening.id], deskIds: [p.desks[0]!.id, p.desks[1]!.id] }).expect(200);
    expect(res.body.invoiceId).toBeTruthy();
    const after = await ctx.db.select().from(bookings).where(eq(bookings.memberId, mem.id)).all();
    expect(after.filter((b) => b.status === 'confirmed').length).toBe(before.length * 4);
    expect(after.filter((b) => b.status === 'cancelled')).toHaveLength(before.length);

    const bills = await ctx.db.select().from(invoices).where(eq(invoices.memberId, mem.id)).all();
    expect(bills.filter((b) => b.status !== 'void').map((b) => b.subtotalCents)).toEqual([900_000]);
    expect(bills.filter((b) => b.status === 'void')).toHaveLength(1);

    const detail = (await p.owner.get(`/api/members/${mem.id}`).expect(200)).body;
    expect(detail.shifts.map((x: { name: string }) => x.name)).toEqual(['Morning', 'Evening']);
    expect(detail.desks).toHaveLength(2);
    expect(detail.planEnd).toBe(mem.planEnd); // the period itself did not move
  });

  it("shows a member's own desk as free to them, but not to everyone else", async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    const mem = (await newMember(ctx, p).expect(201)).body;
    const ask = (extra = '') => p.owner.get(`/api/members/available-spaces?locationId=${ctx.loc.id}&planId=${p.plan.id}&shiftIds=${p.morning.id}&startDate=${inDays(1)}${extra}`).expect(200);
    expect((await ask()).body.spaces.map((s: { id: string }) => s.id)).not.toContain(p.desks[0]!.id);
    expect((await ask(`&memberId=${mem.id}`)).body.spaces.map((s: { id: string }) => s.id)).toContain(p.desks[0]!.id);
  });

  it('refuses a desk someone else holds, and changes nothing when it does', async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    const a = (await newMember(ctx, p).expect(201)).body;
    await newMember(ctx, p, { email: 'other@x.dev', deskIds: [p.desks[1]!.id] }).expect(201);
    await put(p, a.id, { planId: p.plan.id, shiftIds: [p.morning.id], deskIds: [p.desks[1]!.id] }).expect(409);
    const rows = await ctx.db.select().from(bookings).where(eq(bookings.memberId, a.id)).all();
    expect(rows.every((b) => b.status === 'confirmed' && b.resourceId === p.desks[0]!.id)).toBe(true);
    expect((await ctx.db.select().from(memberDesks).where(eq(memberDesks.memberId, a.id)).all()).map((d) => d.resourceId)).toEqual([p.desks[0]!.id]);
  });

  it('bills only the extra shift when the first invoice was already paid', async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    const mem = (await newMember(ctx, p).expect(201)).body;
    await ctx.db.update(invoices).set({ paidCents: 500_000, status: 'paid' }).where(eq(invoices.memberId, mem.id)).run();
    await put(p, mem.id, { planId: p.plan.id, shiftIds: [p.morning.id, p.evening.id], deskIds: [p.desks[0]!.id] }).expect(200);
    const bills = await ctx.db.select().from(invoices).where(eq(invoices.memberId, mem.id)).all();
    expect(bills.map((b) => b.subtotalCents).sort()).toEqual([400_000, 500_000]); // the paid one kept, plus only the evening shift
    expect(bills.some((b) => b.status === 'void')).toBe(false);
  });

  it('can take the plan away, and needs shifts when the plan has them', async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    const mem = (await newMember(ctx, p).expect(201)).body;
    await put(p, mem.id, { planId: p.plan.id, shiftIds: [], deskIds: [] }).expect(400);
    await put(p, mem.id, { planId: null, shiftIds: [], deskIds: [] }).expect(200);
    const rows = await ctx.db.select().from(bookings).where(eq(bookings.memberId, mem.id)).all();
    expect(rows.every((b) => b.status === 'cancelled')).toBe(true);
    expect(await ctx.db.select().from(memberShifts).where(eq(memberShifts.memberId, mem.id)).all()).toHaveLength(0);
    expect((await ctx.db.select().from(members).where(eq(members.id, mem.id)).get())!.planId).toBeNull();
  });
});

describe('deleting a member', () => {
  it('removes a member added by mistake with everything made for them, and frees the email and the desk', async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    const mem = (await newMember(ctx, p).expect(201)).body;
    await p.owner.delete(`/api/members/${mem.id}`).expect(204);
    expect(await ctx.db.select().from(members).where(eq(members.id, mem.id)).get()).toBeUndefined();
    expect(await ctx.db.select().from(users).where(eq(users.email, 'new@x.dev')).get()).toBeUndefined();
    expect(await ctx.db.select().from(bookings).where(eq(bookings.memberId, mem.id)).all()).toHaveLength(0);
    expect(await ctx.db.select().from(invoices).where(eq(invoices.memberId, mem.id)).all()).toHaveLength(0);
    await p.owner.delete(`/api/members/${mem.id}`).expect(404);
    // the same email and desk can be used again
    await newMember(ctx, p).expect(201);
  });

  it('refuses a member with history that must stay, and says to cancel instead', async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    const mem = (await newMember(ctx, p).expect(201)).body;
    await ctx.db.insert(attendance).values({ locationId: ctx.loc.id, memberId: mem.id, checkInAt: new Date().toISOString(), checkOutAt: new Date().toISOString() }).run();
    const r = await p.owner.delete(`/api/members/${mem.id}`).expect(409);
    expect(JSON.stringify(r.body)).toMatch(/check-ins.*Cancel their membership instead/);
    expect(await ctx.db.select().from(members).where(eq(members.id, mem.id)).get()).toBeTruthy();

    // a paid invoice is kept too
    const other = (await newMember(ctx, p, { email: 'paid@x.dev', deskIds: [p.desks[1]!.id] }).expect(201)).body;
    await ctx.db.update(invoices).set({ paidCents: 500_000, status: 'paid' }).where(eq(invoices.memberId, other.id)).run();
    await p.owner.delete(`/api/members/${other.id}`).expect(409);
  });

  it('needs the members permission and the right location', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    await owner.post('/api/staff').send({ name: 'Front Only', email: 'front@test.dev', permissions: ['front_desk'], locationIds: [ctx.loc.id], password: 'password123' }).expect(201);
    const front = await login(ctx.app, 'front@test.dev'); // may check people in, but not change members
    await front.delete(`/api/members/${ctx.basic.member.id}`).expect(403);
    const hive = await login(ctx.app, 'owner@hive.dev');
    await hive.delete(`/api/members/${ctx.basic.member.id}`).expect(403);
  });
});

describe('advance and security deposit on a member', () => {
  const itemsOf = async (ctx: Awaited<ReturnType<typeof setup>>, memberId: string) => {
    const bills = (await ctx.db.select().from(invoices).where(eq(invoices.memberId, memberId)).all()).filter((b) => b.status !== 'void');
    const items = bills.length ? await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, bills[bills.length - 1]!.id)).all() : [];
    return { bills, items };
  };

  it('takes the advance off the shift price and records both amounts as received', async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    const mem = (await newMember(ctx, p, { advanceCents: 200_000, depositCents: 1_000_000, method: 'bank_transfer', reference: 'TX-1' }).expect(201)).body;
    expect(mem).toMatchObject({ advanceCents: 200_000, advanceUsedCents: 200_000, depositCents: 1_000_000, depositStatus: 'held' });

    const { bills, items } = await itemsOf(ctx, mem.id);
    expect(bills).toHaveLength(1);
    expect(bills[0]!.subtotalCents).toBe(300_000); // the 5,000 shift less the 2,000 advance
    expect(bills[0]!.taxCents).toBe(30_000); // tax is on what is left, at the location's 10%
    expect(items.map((i) => i.amountCents).sort((a, b) => a - b)).toEqual([-200_000, 500_000]);
    expect(items.find((i) => i.amountCents < 0)!.description).toBe('Advance paid');

    const detail = (await p.owner.get(`/api/members/${mem.id}`).expect(200)).body;
    expect(detail.moneyEntries.map((e: { kind: string; amountCents: number; method: string }) => [e.kind, e.amountCents, e.method])).toEqual([
      ['advance', 200_000, 'bank_transfer'],
      ['received', 1_000_000, 'bank_transfer'],
    ]);
  });

  it('carries on across invoices when the advance is bigger than one shift price', async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    const mem = (await newMember(ctx, p, { advanceCents: 700_000 }).expect(201)).body;
    const first = await itemsOf(ctx, mem.id);
    expect(first.bills[0]).toMatchObject({ subtotalCents: 0, totalCents: 0, status: 'paid' }); // covered entirely
    expect((await ctx.db.select().from(members).where(eq(members.id, mem.id)).get())!.advanceUsedCents).toBe(500_000);

    // The next period uses the 2,000 that is left.
    await ctx.db.update(members).set({ planEnd: inDays(2) }).where(eq(members.id, mem.id)).run();
    await p.owner.post(`/api/members/${mem.id}/renew`).send({}).expect(200);
    const second = await itemsOf(ctx, mem.id);
    expect(second.bills.map((b) => b.subtotalCents)).toEqual([0, 300_000]);
    expect((await ctx.db.select().from(members).where(eq(members.id, mem.id)).get())!.advanceUsedCents).toBe(700_000);
  });

  it('applies an advance added afterwards to the open invoice, once only', async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    const mem = (await newMember(ctx, p).expect(201)).body;
    expect((await itemsOf(ctx, mem.id)).bills[0]!.subtotalCents).toBe(500_000);
    await p.owner.post(`/api/members/${mem.id}/money`).send({ advanceCents: 200_000 }).expect(204);
    const after = await itemsOf(ctx, mem.id);
    expect(after.bills[0]).toMatchObject({ subtotalCents: 300_000, taxCents: 30_000, totalCents: 330_000 });
    await p.owner.post(`/api/members/${mem.id}/money`).send({ advanceCents: 100_000 }).expect(409);
    await p.owner.post(`/api/members/${mem.id}/money`).send({ depositCents: 500_000 }).expect(204);
    await p.owner.post(`/api/members/${mem.id}/money`).send({ depositCents: 500_000 }).expect(409);
  });

  it('gives the advance back to the replacement invoice when the shifts are changed', async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    const mem = (await newMember(ctx, p, { advanceCents: 200_000 }).expect(201)).body;
    await p.owner.put(`/api/members/${mem.id}/plan`).send({ planId: p.plan.id, shiftIds: [p.morning.id, p.evening.id], deskIds: [p.desks[0]!.id] }).expect(200);
    const { bills } = await itemsOf(ctx, mem.id);
    expect(bills.map((b) => b.subtotalCents)).toEqual([700_000]); // 5,000 + 4,000, less the same 2,000
    expect((await ctx.db.select().from(members).where(eq(members.id, mem.id)).get())!.advanceUsedCents).toBe(200_000);
  });

  it('settles the security deposit at the end of the plan period: some back, the rest kept', async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    const mem = (await newMember(ctx, p, { depositCents: 1_000_000 }).expect(201)).body;
    // A month before the end: too early.
    const early = await p.owner.post(`/api/members/${mem.id}/deposit`).send({ action: 'refund', returnedCents: 800_000 }).expect(409);
    expect(JSON.stringify(early.body)).toMatch(/end of the plan period/);
    await ctx.db.update(members).set({ planEnd: inDays(2) }).where(eq(members.id, mem.id)).run();
    await p.owner.post(`/api/members/${mem.id}/deposit`).send({ action: 'refund', returnedCents: 1_200_000 }).expect(400);
    const done = await p.owner.post(`/api/members/${mem.id}/deposit`).send({ action: 'refund', returnedCents: 800_000, method: 'cash' }).expect(200);
    expect(done.body).toMatchObject({ depositStatus: 'refunded', depositReturnedCents: 800_000 });
    const entries = (await p.owner.get(`/api/members/${mem.id}`).expect(200)).body.moneyEntries.map((e: { kind: string; amountCents: number }) => [e.kind, e.amountCents]);
    expect(entries).toEqual([['received', 1_000_000], ['refunded', 800_000], ['kept', 200_000]]);
    await p.owner.post(`/api/members/${mem.id}/deposit`).send({ action: 'forfeit' }).expect(409); // already settled
  });

  it('can keep the whole deposit, and settles at once for a member who is no longer active', async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    const mem = (await newMember(ctx, p, { depositCents: 600_000 }).expect(201)).body;
    await p.owner.patch(`/api/members/${mem.id}`).send({ status: 'cancelled' }).expect(200);
    const done = await p.owner.post(`/api/members/${mem.id}/deposit`).send({ action: 'forfeit' }).expect(200);
    expect(done.body).toMatchObject({ depositStatus: 'forfeited', depositReturnedCents: 0 });
  });

  it('keeps a member with money recorded from being deleted', async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    const mem = (await newMember(ctx, p, { depositCents: 600_000 }).expect(201)).body;
    const r = await p.owner.delete(`/api/members/${mem.id}`).expect(409);
    expect(JSON.stringify(r.body)).toMatch(/advance or security deposit/);
  });
});

function addMonthsOne(date: string) {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}
