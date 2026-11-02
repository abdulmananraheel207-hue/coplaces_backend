import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { bookings, invoices, locations, memberShifts, members } from '../src/db/schema.js';
import { addDays, addMonths, zonedToUtc } from '../src/lib/time.js';
import { inDays, login, setup, TZ } from './helpers.js';
import {
  acme,
  advanceTaken,
  financeReport,
  generate,
  invoicesOf,
  manualInvoice,
  monthFromNow,
  ownerOf,
  ownerUserId,
  planMember,
  planWithShifts,
  rows,
  staffWith,
  sum,
  today,
  upgradeHive,
} from './helpers/finance.js';

/**
 * Known finance bugs, one test each. Every test asserts the CORRECT behaviour, so it fails today; `it.fails` turns that failure into a
 * pass and keeps the suite green. The fix for a bug makes its test pass, which makes `it.fails` fail: change that one `knownBug` to
 * `it` in the same commit as the fix.
 *
 * To see the bugs as ordinary failing tests (and check each one fails on its own assertion, not on its setup):
 *   SHOW_BUGS=1 npx vitest run test/finance-bugs.test.ts
 */
const knownBug = process.env.SHOW_BUGS ? it : it.fails;

describe('KNOWN finance bugs (each fails today; the fix flips it)', () => {
  it('H1: a company contract advance is taken off the company invoices', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const month = monthFromNow(-2);
    const c = await acme(ctx, owner, month, { advanceCents: 1_000_000 });
    await owner.post(`/api/contracts/${c.id}/advance`).send({ method: 'cash' }).expect(200);
    await generate(owner, ctx.loc.id, month);

    const company = (await invoicesOf(ctx, c.memberId)).filter((i) => i.status !== 'void' && i.periodStart === `${month}-01`);
    expect(company).toHaveLength(1);
    expect(company[0]!.items.some((l) => l.amountCents > 0 && l.description.startsWith('Acme Ltd'))).toBe(true); // rent was billed
    // The 10,000.00 advance was income the day it arrived, so it must come off what the company is asked to pay.
    expect(sum(company[0]!.items.filter((l) => l.amountCents < 0).map((l) => l.amountCents))).toBe(-1_000_000);
  });

  it('H2: a single-member contract bills its rent every month and uses its advance', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const month = monthFromNow(-2);
    const { member } = await ctx.member('renter@test.dev', null);
    await ctx.db.update(members).set({ startDate: `${month}-01` }).where(eq(members.id, member.id)).run();
    const contract = (
      await owner
        .post('/api/contracts')
        .send({ locationId: ctx.loc.id, memberId: member.id, resourceId: ctx.dedicated.id, startDate: `${month}-01`, rentCents: 300_000, advanceCents: 300_000 })
        .expect(201)
    ).body;
    await owner.post(`/api/contracts/${contract.id}/activate`).expect(200);
    await owner.post(`/api/contracts/${contract.id}/advance`).send({ method: 'cash' }).expect(200);
    await generate(owner, ctx.loc.id, month);

    const bills = (await invoicesOf(ctx, member.id)).filter((i) => i.status !== 'void' && i.periodStart === `${month}-01`);
    expect(bills).toHaveLength(1); // today: no invoice at all, the rent is never billed
    expect(bills[0]!.items.some((l) => l.amountCents === 300_000)).toBe(true);
    expect(sum(bills[0]!.items.filter((l) => l.amountCents < 0).map((l) => l.amountCents))).toBe(-300_000);
  });

  it('H3: a legacy-plan member’s advance comes off their monthly invoice', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    // basic is on the Basic plan (5,000 a month, no shifts, so no plan period): the monthly invoice bills the plan price.
    await owner.post(`/api/members/${ctx.basic.member.id}/money`).send({ advanceCents: 5_000, method: 'cash' }).expect(204);
    await generate(owner, ctx.loc.id, today().slice(0, 7));

    const bill = (await invoicesOf(ctx, ctx.basic.member.id)).find((i) => i.kind === 'subscription' && i.status !== 'void')!;
    expect(bill.items.some((l) => l.amountCents === 5_000)).toBe(true); // the plan price was billed
    expect((await rows.member(ctx, ctx.basic.member.id))!.advanceUsedCents).toBe(5_000);
    expect(bill.totalCents).toBe(0); // paid in advance, so nothing more is owed
  });

  it('H4: generating a month again after the company contact changed does not bill the company twice', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const month = monthFromNow(-2);
    const c = await acme(ctx, owner, month);
    await generate(owner, ctx.loc.id, month);

    const list = (await owner.get(`/api/contracts?locationId=${ctx.loc.id}`).expect(200)).body as { id: string; people: { id: string; memberId: string }[] }[];
    const contact = list.find((x) => x.id === c.id)!.people.find((p) => p.memberId === c.memberId)!;
    await owner.post(`/api/contracts/${c.id}/people/${contact.id}/leave`).send({ date: today() }).expect(204);
    await generate(owner, ctx.loc.id, month);

    const rentInvoices = (await ctx.db.select().from(invoices).where(and(eq(invoices.locationId, ctx.loc.id), eq(invoices.periodStart, `${month}-01`))).all()).filter((i) => i.status !== 'void');
    const withRent = [];
    for (const i of rentInvoices) if ((await invoicesOf(ctx, i.memberId)).find((x) => x.id === i.id)!.items.some((l) => l.description.startsWith('Acme Ltd'))) withRent.push(i);
    expect(withRent).toHaveLength(1);
  });

  it('H5a: removing a payment leaves a record of it (no hard delete)', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const inv = await manualInvoice(owner, ctx.basic.member.id, 10_000);
    const pay = (await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 11_000, method: 'cash' }).expect(201)).body.payment;
    await owner.delete(`/api/payments/${pay.id}`).expect(200);
    // The invoice is open again, but the cash that was recorded must still be traceable (reversed, not erased).
    expect(await rows.payment(ctx, pay.id)).toBeDefined();
  });

  it('H5b: a payment cannot be dated years back or in the future', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const inv = await manualInvoice(owner, ctx.basic.member.id, 10_000);
    const future = new Date(Date.now() + 365 * 86_400_000).toISOString();
    const ancient = new Date(Date.now() - 10 * 365 * 86_400_000).toISOString();
    const a = await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 100, method: 'cash', paidAt: future });
    const b = await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 100, method: 'cash', paidAt: ancient });
    expect([a.status, b.status]).toEqual([400, 400]);
  });

  it('H6a: moving to another plan after paying credits the unused, already-paid period', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const p = await planWithShifts(ctx, owner);
    const mem = await planMember(ctx, owner, p); // Morning from tomorrow: 5,000 + 10% = 5,500 billed
    const first = (await invoicesOf(ctx, mem.id))[0]!;
    await owner.post(`/api/invoices/${first.id}/payments`).send({ amountCents: first.totalCents, method: 'cash' }).expect(201);

    const plan2 = (await owner.post('/api/plans').send({ locationId: ctx.loc.id, name: 'Afternoons', interval: 'month' }).expect(201)).body;
    const day = (await owner.post('/api/shifts').send({ locationId: ctx.loc.id, planId: plan2.id, name: 'Day', startTime: '13:00', endTime: '15:00', priceCents: 400_000, spaceIds: p.desks.map((d) => d.id) }).expect(201)).body;
    await owner.put(`/api/members/${mem.id}/plan`).send({ planId: plan2.id, shiftIds: [day.id], deskIds: [p.desks[0]!.id] }).expect(200);

    // Not one day of the paid period was used (it started tomorrow and was cancelled), and it was worth more than the new plan.
    const detail = (await owner.get(`/api/members/${mem.id}`).expect(200)).body;
    expect(detail.balanceDueCents).toBe(0);
  });

  it('H6b: a plan change whose new invoice fails changes nothing, and never loses or reuses the advance', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const p = await planWithShifts(ctx, owner);
    const mem = await planMember(ctx, owner, p, { advanceCents: 200_000 });
    const before = (await invoicesOf(ctx, mem.id))[0]!;
    expect(before.status).toBe('open');

    // Take the next invoice number, so creating the replacement invoice fails half way through the change.
    const loc = (await ctx.db.select().from(locations).where(eq(locations.id, ctx.loc.id)).get())!;
    await ctx.db
      .insert(invoices)
      .values({ locationId: loc.id, memberId: ctx.basic.member.id, number: `${loc.code}-${String(loc.invoiceSeq + 1).padStart(5, '0')}`, issueDate: today(), dueDate: today(), subtotalCents: 1, totalCents: 1 })
      .run();
    const res = await owner.put(`/api/members/${mem.id}/plan`).send({ planId: p.plan.id, shiftIds: [p.morning.id, p.evening.id], deskIds: [p.desks[0]!.id] });
    expect(res.status).toBeGreaterThanOrEqual(400);

    expect((await rows.invoice(ctx, before.id))!.status).toBe('open'); // today: voided, with no replacement
    expect((await rows.member(ctx, mem.id))!.advanceUsedCents).toBe(await advanceTaken(ctx, mem.id)); // today: 2,000 used by no invoice
    expect((await ctx.db.select().from(memberShifts).where(eq(memberShifts.memberId, mem.id)).all()).map((s) => s.shiftId)).toEqual([p.morning.id]);
  });

  it('M1: cancelled and paused members’ completed bookings and amenities still get billed', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const month = monthFromNow(-2);
    const by = await ownerUserId(ctx);
    const tea = (await owner.post('/api/amenities').send({ locationId: ctx.loc.id, name: 'Tea', priceCents: 200 }).expect(201)).body;
    const made: { bookingId: string; orderId: string }[] = [];
    for (const [email, status] of [['gone@test.dev', 'cancelled'], ['away@test.dev', 'paused']] as const) {
      const { member } = await ctx.member(email, null);
      await ctx.db.update(members).set({ startDate: `${month}-01` }).where(eq(members.id, member.id)).run();
      const b = await ctx.db
        .insert(bookings)
        .values({ locationId: ctx.loc.id, resourceId: ctx.room.id, memberId: member.id, startsAt: zonedToUtc(`${month}-10`, '10:00', TZ).toISOString(), endsAt: zonedToUtc(`${month}-10`, '11:00', TZ).toISOString(), status: 'completed', billableMinutes: 60, priceCents: 6_000, createdById: by })
        .returning()
        .get();
      const order = (await owner.post('/api/amenities/orders').send({ memberId: member.id, amenityId: tea.id, quantity: 1 }).expect(201)).body;
      await owner.patch(`/api/members/${member.id}`).send({ status }).expect(200);
      made.push({ bookingId: b.id, orderId: order.id });
    }
    await generate(owner, ctx.loc.id, month);
    for (const { bookingId, orderId } of made) {
      expect((await ctx.db.select().from(bookings).where(eq(bookings.id, bookingId)).get())!.invoiceId).not.toBeNull();
      expect((await rows.amenityOrder(ctx, orderId))!.invoiceId).not.toBeNull();
    }
  });

  knownBug('M3: amenity money collected at the desk is a payment with a method, so payments by method reconcile', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const tea = (await owner.post('/api/amenities').send({ locationId: ctx.loc.id, name: 'Tea', priceCents: 200 }).expect(201)).body;
    await owner.post('/api/amenities/orders').send({ memberId: ctx.basic.member.id, amenityId: tea.id, quantity: 2 }).expect(201);
    await owner.post('/api/amenities/collect').send({ memberId: ctx.basic.member.id, method: 'cash' }).expect(200);
    const rep = await financeReport(owner, ctx.loc.id, `${today().slice(0, 7)}-01`, today());
    expect(rep.totals.collectedCents).toBe(400);
    expect(sum(rep.paymentsByMethod.map((m: { amountCents: number }) => m.amountCents))).toBe(400);
  });

  knownBug('M4a: someone with only the members permission cannot bill a plan change', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const p = await planWithShifts(ctx, owner);
    const mem = await planMember(ctx, owner, p);
    const clerk = await staffWith(ctx, owner, 'clerk@test.dev', ['members']);
    const res = await clerk.put(`/api/members/${mem.id}/plan`).send({ planId: p.plan.id, shiftIds: [p.morning.id, p.evening.id], deskIds: [p.desks[0]!.id] });
    expect(res.status).toBe(403); // today: 200, and an invoice is voided and another created
  });

  knownBug('M4b: someone with only the members permission cannot take or refund money', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const clerk = await staffWith(ctx, owner, 'clerk@test.dev', ['members']);
    const take = await clerk.post(`/api/members/${ctx.basic.member.id}/money`).send({ depositCents: 100_000, method: 'cash' });
    await owner.post(`/api/members/${ctx.pro.member.id}/money`).send({ depositCents: 100_000, method: 'cash' }).expect(204);
    await owner.patch(`/api/members/${ctx.pro.member.id}`).send({ status: 'paused' }).expect(200); // settling opens once not active
    const refund = await clerk.post(`/api/members/${ctx.pro.member.id}/deposit`).send({ action: 'refund', method: 'cash' });
    expect([take.status, refund.status]).toEqual([403, 403]);
  });

  knownBug('M5a: amenities cannot be put on an invoice when the package has no invoicing', async () => {
    const ctx = await setup();
    const hive = await login(ctx.app, 'owner@hive.dev'); // Hive's package has no features at all
    const tea = (await hive.post('/api/amenities').send({ locationId: ctx.locB.id, name: 'Tea', priceCents: 100 }).expect(201)).body;
    await hive.post('/api/amenities/orders').send({ memberId: ctx.hiveMember.member.id, amenityId: tea.id, quantity: 2 }).expect(201);
    const res = await hive.post('/api/amenities/invoice').send({ memberId: ctx.hiveMember.member.id });
    expect(res.status).toBe(403);
    expect(await ctx.db.select().from(invoices).where(eq(invoices.locationId, ctx.locB.id)).all()).toHaveLength(0);
  });

  it('M5b: a plan period does not create an invoice when the package has no invoicing', async () => {
    const ctx = await setup();
    const hive = await login(ctx.app, 'owner@hive.dev');
    const desk = (await hive.post('/api/resources').send({ locationId: ctx.locB.id, kind: 'hot_desk', name: 'H1' }).expect(201)).body;
    const plan = (await hive.post('/api/plans').send({ locationId: ctx.locB.id, name: 'Hive plan', interval: 'month' }).expect(201)).body;
    const shift = (await hive.post('/api/shifts').send({ locationId: ctx.locB.id, planId: plan.id, name: 'Morning', startTime: '09:00', endTime: '12:00', priceCents: 100_000, spaceIds: [desk.id] }).expect(201)).body;
    await hive.post('/api/members').send({ locationId: ctx.locB.id, name: 'Hive Plan', email: 'hp@hive.dev', planId: plan.id, status: 'active', startDate: inDays(1), shiftIds: [shift.id], deskIds: [desk.id] });
    expect(await ctx.db.select().from(invoices).where(eq(invoices.locationId, ctx.locB.id)).all()).toHaveLength(0);
  });

  knownBug('M6: deleting a member never erases an invoice that was issued', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const { member } = await ctx.member('mistake@test.dev', null);
    const inv = await manualInvoice(owner, member.id, 10_000);
    const res = await owner.delete(`/api/members/${member.id}`);
    // Either the delete is refused, or the invoice stays (voided). It must not vanish.
    expect(res.status === 409 || !!(await rows.invoice(ctx, inv.id))).toBe(true);
  });

  knownBug('R1: when every bill is paid exactly, money collected equals money invoiced (advance included)', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const p = await planWithShifts(ctx, owner);
    const mem = await planMember(ctx, owner, p, { advanceCents: 200_000 }); // 5,000 shift, 2,000 advance, 3,000 + 10% left
    const bill = (await invoicesOf(ctx, mem.id))[0]!;
    await owner.post(`/api/invoices/${bill.id}/payments`).send({ amountCents: bill.totalCents, method: 'cash' }).expect(201);
    const rep = await financeReport(owner, ctx.loc.id, `${today().slice(0, 7)}-01`, today());
    expect(rep.totals.collectedCents).toBe(rep.totals.invoicedCents); // today: 5,300 collected against 3,300 invoiced
  });

  knownBug('R2: tax collected is not counted as income in the profit and loss', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const inv = await manualInvoice(owner, ctx.basic.member.id, 10_000); // + 10% tax = 11,000
    await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 11_000, method: 'cash' }).expect(201);
    const rep = await financeReport(owner, ctx.loc.id, `${today().slice(0, 7)}-01`, today());
    expect(sum(rep.profitLoss.income.map((r: { totalCents: number }) => r.totalCents))).toBe(10_000);
  });

  knownBug('R3: a long report’s monthly series adds up to its totals (no 60-month cap)', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const inv = await manualInvoice(owner, ctx.basic.member.id, 10_000);
    // The cap keeps the first 60 months of the range and drops the rest, so a payment made today falls off a six-year report.
    await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 1_000, method: 'cash' }).expect(201);
    const rep = await financeReport(owner, ctx.loc.id, `${addMonths(today().slice(0, 7), -72)}-01`, today());
    expect(rep.totals.collectedCents).toBe(1_000);
    expect(sum(rep.monthly.map((m: { collectedCents: number }) => m.collectedCents))).toBe(rep.totals.collectedCents);
  });

  knownBug('R4a: receivables aging is as of the report’s end date', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    await manualInvoice(owner, ctx.basic.member.id, 10_000); // issued today
    const yesterday = addDays(today(), -1);
    const rep = await financeReport(owner, ctx.loc.id, addDays(yesterday, -30), yesterday);
    expect(sum(Object.values(rep.receivablesAging).map((b) => (b as { amountCents: number }).amountCents))).toBe(0);
  });

  knownBug('R4b: deposits held are as of the report’s end date', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const c = (await owner.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.basic.member.id, startDate: today(), depositCents: 100_000 }).expect(201)).body;
    await owner.post(`/api/contracts/${c.id}/deposit`).send({ action: 'receive', method: 'cash' }).expect(200); // received today
    const yesterday = addDays(today(), -1);
    const rep = await financeReport(owner, ctx.loc.id, addDays(yesterday, -30), yesterday);
    expect(rep.deposits.heldCents).toBe(0);
  });

  it('T1: an advance applied later keeps the tax rate the invoice was issued at', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const p = await planWithShifts(ctx, owner);
    const mem = await planMember(ctx, owner, p); // 5,000 at 10%
    await owner.patch(`/api/locations/${ctx.loc.id}`).send({ taxRateBps: 2_000 }).expect(200); // the rate goes up to 20%
    await owner.post(`/api/members/${mem.id}/money`).send({ advanceCents: 200_000, method: 'cash' }).expect(204);
    const bill = (await invoicesOf(ctx, mem.id))[0]!;
    expect(bill).toMatchObject({ subtotalCents: 300_000, taxCents: 30_000, totalCents: 330_000 }); // today: 60,000 tax, at 20%
  });

  it('L4: a manual invoice whose total cannot be held exactly is refused', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const res = await owner.post('/api/invoices').send({ memberId: ctx.basic.member.id, items: [{ description: 'Huge', quantity: 10_000, unitPriceCents: Number.MAX_SAFE_INTEGER }] });
    expect(res.status).toBe(400);
  });

  it('S1: another tenant’s finance record ids answer 404, exactly like ids that do not exist', async () => {
    const ctx = await setup();
    await upgradeHive(ctx);
    const owner = await ownerOf(ctx);
    const hive = await login(ctx.app, 'owner@hive.dev');
    const inv = await manualInvoice(owner, ctx.basic.member.id, 10_000);
    const pay = (await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 1_000, method: 'cash' }).expect(201)).body.payment;
    const exp = (await owner.post('/api/expenses').send({ locationId: ctx.loc.id, category: 'rent', amountCents: 5_000 }).expect(201)).body;
    const con = (await owner.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.basic.member.id, startDate: today(), depositCents: 100 }).expect(201)).body;
    const statuses = [
      (await hive.get(`/api/invoices/${inv.id}`)).status,
      (await hive.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 1, method: 'cash' })).status,
      (await hive.post(`/api/invoices/${inv.id}/void`)).status,
      (await hive.delete(`/api/payments/${pay.id}`)).status,
      (await hive.patch(`/api/expenses/${exp.id}`).send({ amountCents: 1 })).status,
      (await hive.delete(`/api/expenses/${exp.id}`)).status,
      (await hive.get(`/api/contracts/${con.id}/deposit-entries`)).status,
      (await hive.post(`/api/contracts/${con.id}/deposit`).send({ action: 'receive' })).status,
      (await hive.get(`/api/members/${ctx.basic.member.id}`)).status,
      (await hive.post(`/api/members/${ctx.basic.member.id}/money`).send({ depositCents: 1 })).status,
    ];
    expect(statuses).toEqual(statuses.map(() => 404)); // today: 403 "No access to this location", which tells them the id exists
  });
});
