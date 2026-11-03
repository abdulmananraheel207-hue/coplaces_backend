import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { contracts, invoices, members } from '../src/db/schema.js';
import { addDays, addMonths, daysBetween } from '../src/lib/time.js';
import { setup } from './helpers.js';
import { generate, invoicesOf, monthFromNow, ownerOf, planMember, planWithShifts, rows, sum, today } from './helpers/finance.js';

const lastDayOf = (month: string) => addDays(`${addMonths(month, 1)}-01`, -1);

describe('contract rent on the monthly invoices', () => {
  it('bills a single contract by the day in the months it starts and ends, once per month, on its own invoice', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const m1 = monthFromNow(-3);
    const m2 = monthFromNow(-2);
    const { member } = await ctx.member('renter@test.dev', null);
    await ctx.db.update(members).set({ startDate: `${m1}-01` }).where(eq(members.id, member.id)).run();
    // From the 11th of m1 to the 10th of m2, 3,000.00 a month.
    const c = (await owner.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: member.id, resourceId: ctx.dedicated.id, startDate: `${m1}-11`, endDate: `${m2}-10`, rentCents: 300_000 }).expect(201)).body;
    await owner.post(`/api/contracts/${c.id}/activate`).expect(200);
    await generate(owner, ctx.loc.id, m1);
    await generate(owner, ctx.loc.id, m2);
    await generate(owner, ctx.loc.id, m2); // again: nothing new

    const bills = (await invoicesOf(ctx, member.id)).filter((i) => i.status !== 'void');
    expect(bills).toHaveLength(2);
    const daysIn = (m: string) => daysBetween(`${m}-01`, `${addMonths(m, 1)}-01`);
    const first = bills.find((b) => b.periodStart === `${m1}-01`)!;
    const second = bills.find((b) => b.periodStart === `${m2}-01`)!;
    const firstDays = daysBetween(`${m1}-11`, lastDayOf(m1)) + 1;
    expect(first.items).toMatchObject([{ amountCents: Math.round((300_000 * firstDays) / daysIn(m1)), category: 'rent', resourceId: ctx.dedicated.id }]);
    expect(first.items[0]!.description).toContain(`${firstDays} of ${daysIn(m1)} days`);
    expect(second.items).toMatchObject([{ amountCents: Math.round((300_000 * 10) / daysIn(m2)), category: 'rent' }]);
    expect([first.contractId, second.contractId]).toEqual([c.id, c.id]);
    expect(first.taxRateBps).toBe(1_000);
  });

  it('takes a contract advance received after the invoice off that invoice, and gives it back if the invoice is voided', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const month = monthFromNow(-2);
    const { member } = await ctx.member('late@test.dev', null);
    await ctx.db.update(members).set({ startDate: `${month}-01` }).where(eq(members.id, member.id)).run();
    const c = (await owner.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: member.id, startDate: `${month}-01`, rentCents: 300_000, advanceCents: 100_000 }).expect(201)).body;
    await owner.post(`/api/contracts/${c.id}/activate`).expect(200);
    await generate(owner, ctx.loc.id, month);
    const bill = (await invoicesOf(ctx, member.id))[0]!;
    expect(bill).toMatchObject({ subtotalCents: 300_000, totalCents: 330_000 });

    await owner.post(`/api/contracts/${c.id}/advance`).send({ method: 'cash' }).expect(200);
    expect((await rows.invoice(ctx, bill.id))!).toMatchObject({ subtotalCents: 200_000, taxCents: 20_000, totalCents: 220_000 });
    expect((await ctx.db.select().from(contracts).where(eq(contracts.id, c.id)).get())!.advanceUsedCents).toBe(100_000);

    await owner.post(`/api/invoices/${bill.id}/void`).expect(200);
    expect((await ctx.db.select().from(contracts).where(eq(contracts.id, c.id)).get())!.advanceUsedCents).toBe(0);
    // The month can be billed again, and the advance comes off the new invoice.
    await generate(owner, ctx.loc.id, month);
    const again = (await invoicesOf(ctx, member.id)).find((i) => i.status !== 'void')!;
    expect(again).toMatchObject({ subtotalCents: 200_000, contractId: c.id });
  });

  it('does not bill a draft or cancelled contract, and stops after it ends', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const month = monthFromNow(-2);
    await ctx.db.update(members).set({ startDate: `${month}-01` }).where(eq(members.id, ctx.basic.member.id)).run();
    await owner.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.basic.member.id, startDate: `${month}-01`, rentCents: 300_000 }).expect(201); // stays a draft
    const ended = (await owner.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.pro.member.id, startDate: `${monthFromNow(-4)}-01`, endDate: lastDayOf(monthFromNow(-3)), rentCents: 300_000 }).expect(201)).body;
    await owner.post(`/api/contracts/${ended.id}/activate`).expect(200);
    await generate(owner, ctx.loc.id, month);
    const withRent = await ctx.db.select().from(invoices).where(and(eq(invoices.locationId, ctx.loc.id), eq(invoices.periodStart, `${month}-01`))).all();
    expect(withRent.filter((i) => i.contractId)).toHaveLength(0);
  });
});

describe('a member’s own monthly invoice', () => {
  it('takes an advance received after the invoice off it, for a member on a plan from before shifts', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    await generate(owner, ctx.loc.id, today().slice(0, 7));
    const bill = (await invoicesOf(ctx, ctx.basic.member.id))[0]!; // Basic: 5,000 + 10%
    expect(bill.items).toMatchObject([{ category: 'plan', planId: ctx.basicPlan.id, amountCents: 5_000 }]);
    await owner.post(`/api/members/${ctx.basic.member.id}/money`).send({ advanceCents: 2_000, method: 'cash' }).expect(204);
    expect((await rows.invoice(ctx, bill.id))!).toMatchObject({ subtotalCents: 3_000, taxCents: 300, totalCents: 3_300 });
    expect((await rows.member(ctx, ctx.basic.member.id))!.advanceUsedCents).toBe(2_000);
  });

  it('tags booking and amenity lines with what they are for', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const tea = (await owner.post('/api/amenities').send({ locationId: ctx.loc.id, name: 'Tea', priceCents: 200 }).expect(201)).body;
    await owner.post('/api/amenities/orders').send({ memberId: ctx.basic.member.id, amenityId: tea.id, quantity: 1 }).expect(201);
    await generate(owner, ctx.loc.id, today().slice(0, 7));
    const bill = (await invoicesOf(ctx, ctx.basic.member.id))[0]!;
    expect(bill.items.map((l) => l.category).sort()).toEqual(['amenity', 'plan']);
  });

  it('plan shift invoices are tagged with their plan, and use credit as well as advance', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const p = await planWithShifts(ctx, owner);
    const mem = await planMember(ctx, owner, p);
    await ctx.db.update(members).set({ creditCents: 100_000 }).where(eq(members.id, mem.id)).run();
    await ctx.db.update(members).set({ planEnd: addDays(today(), 2) }).where(eq(members.id, mem.id)).run();
    await owner.post(`/api/members/${mem.id}/renew`).send({}).expect(200);
    const renewal = (await invoicesOf(ctx, mem.id)).at(-1)!;
    expect(renewal.items.map((l) => [l.category, l.amountCents])).toEqual([
      ['plan', 500_000],
      ['credit', -100_000],
    ]);
    expect(renewal.items[0]!.planId).toBe(p.plan.id);
    expect((await rows.member(ctx, mem.id))!.creditUsedCents).toBe(100_000);
  });
});

describe('a person who left a company contract', () => {
  it('is billed on their own for what they do after leaving', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const month = monthFromNow(-1);
    const company = (await owner
      .post('/api/contracts/company')
      .send({
        locationId: ctx.loc.id,
        companyName: 'Short Co',
        startDate: `${monthFromNow(-3)}-01`,
        endDate: lastDayOf(monthFromNow(-2)),
        pricingMode: 'per_member',
        pricePerMemberCents: 100_000,
        extraMemberCents: 0,
        fixedPriceCents: 0,
        spaceIds: [ctx.room.id],
        people: [{ name: 'Ex', email: 'ex@short.dev', password: 'password123', deskResourceId: null }],
      })
      .expect(201)).body;
    await owner.post(`/api/contracts/${company.id}/activate`).expect(200);
    // The contract ended before `month`; the person stays on as a member of their own, on the Basic plan.
    await ctx.db.update(members).set({ status: 'active', endDate: null, planId: ctx.basicPlan.id }).where(eq(members.id, company.memberId)).run();
    await generate(owner, ctx.loc.id, month);
    const own = (await invoicesOf(ctx, company.memberId)).filter((i) => i.periodStart === `${month}-01` && !i.contractId);
    expect(own).toHaveLength(1);
    expect(sum(own[0]!.items.map((l) => l.amountCents))).toBe(5_000);
  });
});

describe('changing plan part way through a period', () => {
  const periodOf = (start: string) => {
    const end = addDays(addMonths(start.slice(0, 7), 1) + start.slice(7), -1);
    return { end, total: daysBetween(start, end) + 1, left: daysBetween(today(), end) + 1 };
  };

  it('with an unpaid invoice: voids it, bills the days already used at the old shifts and the rest at the new ones', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const p = await planWithShifts(ctx, owner);
    const start = addDays(today(), -10);
    const mem = await planMember(ctx, owner, p, { startDate: start });
    const { total, left } = periodOf(start);
    await owner.put(`/api/members/${mem.id}/plan`).send({ planId: p.plan.id, shiftIds: [p.morning.id, p.evening.id], deskIds: [p.desks[0]!.id] }).expect(200);
    const bills = await invoicesOf(ctx, mem.id);
    expect(bills.map((b) => b.status)).toEqual(['void', 'open']);
    const used = total - left;
    expect(bills[1]!.subtotalCents).toBe(Math.round((500_000 * used) / total) + Math.round((500_000 * left) / total) + Math.round((400_000 * left) / total));
    expect(bills[1]!.items.some((l) => l.description.includes(`used ${used} of ${total} days`))).toBe(true);
  });

  it('with a paid invoice: keeps it, credits the unused paid days and bills only the new shift for the days left', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const p = await planWithShifts(ctx, owner);
    const start = addDays(today(), -10);
    const mem = await planMember(ctx, owner, p, { startDate: start });
    const first = (await invoicesOf(ctx, mem.id))[0]!;
    await owner.post(`/api/invoices/${first.id}/payments`).send({ amountCents: first.totalCents, method: 'cash' }).expect(201);
    const { total, left } = periodOf(start);
    await owner.put(`/api/members/${mem.id}/plan`).send({ planId: p.plan.id, shiftIds: [p.morning.id, p.evening.id], deskIds: [p.desks[0]!.id] }).expect(200);
    const bills = await invoicesOf(ctx, mem.id);
    expect(bills.map((b) => b.status)).toEqual(['paid', 'open']);
    const credit = Math.round((500_000 * left) / total);
    const charged = Math.round((500_000 * left) / total) + Math.round((400_000 * left) / total);
    expect(bills[1]!.subtotalCents).toBe(charged - credit);
    expect(bills[1]!.items.find((l) => l.category === 'credit')!.amountCents).toBe(-credit);
    expect((await rows.member(ctx, mem.id))!).toMatchObject({ creditCents: credit, creditUsedCents: credit });
  });
});

describe('loose ends that touched money', () => {
  it('gives back what is left of a member advance: income goes down that day, and it cannot also come off an invoice', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    await owner.post(`/api/members/${ctx.basic.member.id}/money`).send({ advanceCents: 10_000, method: 'card' }).expect(204);
    const clerk = await (await import('./helpers/finance.js')).staffWith(ctx, owner, 'clerk@test.dev', ['members', 'invoices']);
    await clerk.post(`/api/members/${ctx.basic.member.id}/advance-refund`).send({ method: 'card' }).expect(403); // a billing control
    await owner.post(`/api/members/${ctx.basic.member.id}/advance-refund`).send({ amountCents: 10_001, method: 'card' }).expect(400);
    await owner.post(`/api/members/${ctx.basic.member.id}/advance-refund`).send({ amountCents: 4_000, method: 'card' }).expect(200);
    expect((await rows.member(ctx, ctx.basic.member.id))!).toMatchObject({ advanceCents: 10_000, advanceUsedCents: 4_000 });
    const rep = (await owner.get(`/api/reports/finance?locationId=${ctx.loc.id}&from=${today().slice(0, 7)}-01&to=${today()}`).expect(200)).body;
    expect(rep.totals.collectedCents).toBe(6_000);
    expect(rep.paymentsByMethod).toEqual([{ method: 'card', amountCents: 6_000 }]);
    expect(rep.incomeByKind.find((k: { kind: string }) => k.kind === 'advance').amountCents).toBe(6_000);
    // The 6,000 left comes off the next invoice, no more.
    await generate(owner, ctx.loc.id, today().slice(0, 7));
    const bill = (await invoicesOf(ctx, ctx.basic.member.id))[0]!;
    expect(bill.items.find((l) => l.category === 'advance')!.amountCents).toBe(-5_000); // the 5,000 plan price is all it can take
    await owner.post(`/api/members/${ctx.basic.member.id}/advance-refund`).send({ method: 'card' }).expect(200); // the last 1,000
    await owner.post(`/api/members/${ctx.basic.member.id}/advance-refund`).send({ method: 'card' }).expect(409);
  });

  it('gives back what is left of a contract advance', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const c = (await owner.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.basic.member.id, startDate: today(), advanceCents: 50_000 }).expect(201)).body;
    await owner.post(`/api/contracts/${c.id}/advance`).send({ method: 'cash' }).expect(200);
    const back = (await owner.post(`/api/contracts/${c.id}/advance-refund`).send({ method: 'cash' }).expect(200)).body;
    expect(back.advanceUsedCents).toBe(50_000);
    const log = (await owner.get(`/api/audit?locationId=${ctx.loc.id}&action=advance.refund`).expect(200)).body;
    expect(log).toHaveLength(1);
  });

  it('keeps an invoiced booking as it was billed', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const month = monthFromNow(-1);
    await ctx.db.update(members).set({ startDate: `${month}-01` }).where(eq(members.id, ctx.basic.member.id)).run();
    const by = (await import('./helpers/finance.js')).ownerUserId;
    const { bookings } = await import('../src/db/schema.js');
    const { zonedToUtc } = await import('../src/lib/time.js');
    const { TZ } = await import('./helpers.js');
    const b = await ctx.db
      .insert(bookings)
      .values({ locationId: ctx.loc.id, resourceId: ctx.room.id, memberId: ctx.basic.member.id, startsAt: zonedToUtc(`${month}-10`, '10:00', TZ).toISOString(), endsAt: zonedToUtc(`${month}-10`, '11:00', TZ).toISOString(), status: 'completed', billableMinutes: 60, priceCents: 6_000, createdById: await by(ctx) })
      .returning()
      .get();
    await generate(owner, ctx.loc.id, month);
    await owner.patch(`/api/bookings/${b.id}`).send({ status: 'no_show' }).expect(409);
    await owner.patch(`/api/bookings/${b.id}`).send({ status: 'completed' }).expect(200); // the same status is fine
  });

  it('refuses to delete a plan members are on, and to change a shift plan around the plan change', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const p = await planWithShifts(ctx, owner);
    const mem = await planMember(ctx, owner, p);
    await owner.delete(`/api/plans/${p.plan.id}`).expect(409);
    await owner.patch(`/api/members/${mem.id}`).send({ planId: ctx.proPlan.id }).expect(409);
    await owner.patch(`/api/members/${mem.id}`).send({ planId: p.plan.id, notes: 'same plan' }).expect(200);
    const empty = (await owner.post('/api/plans').send({ locationId: ctx.loc.id, name: 'Unused' }).expect(201)).body;
    await owner.delete(`/api/plans/${empty.id}`).expect(204);
  });
});
