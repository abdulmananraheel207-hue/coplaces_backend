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
