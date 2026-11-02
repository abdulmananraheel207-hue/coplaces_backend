import { eq } from 'drizzle-orm';
import { amenityOrders, depositEntries, expenses, invoiceItems, invoices, members, organizations, payments, resources, users } from '../../src/db/schema.js';
import { addDays, addMonths, todayIn } from '../../src/lib/time.js';
import { inDays, login, setup, TZ, type Ctx } from '../helpers.js';

/** Shared builders for the finance tests: plans with shifts, company contracts, staff with chosen permissions, report readers. */

export type Agent = Awaited<ReturnType<typeof login>>;
export const today = () => todayIn(TZ);
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
/** 'YYYY-MM' of the month `n` months from this one. */
export const monthFromNow = (n: number) => addMonths(today().slice(0, 7), n);
export const lastDayOf = (month: string) => addDays(`${addMonths(month, 1)}-01`, -1);

export async function ownerOf(ctx: Ctx) {
  return login(ctx.app, 'owner@test.dev');
}

/** A monthly plan with Morning (9 to 12, 5,000.00) and Evening (16 to 20, 4,000.00) on three hot desks. */
export async function planWithShifts(ctx: Ctx, owner: Agent, name = 'Hot Desk') {
  const plan = (await owner.post('/api/plans').send({ locationId: ctx.loc.id, name, interval: 'month' }).expect(201)).body;
  const desks = [ctx.desk, ctx.desk2];
  desks.push(await ctx.db.insert(resources).values({ locationId: ctx.loc.id, kind: 'hot_desk', name: `${name} desk 3` }).returning().get());
  const shift = async (shiftName: string, startTime: string, endTime: string, priceCents: number) =>
    (await owner.post('/api/shifts').send({ locationId: ctx.loc.id, planId: plan.id, name: shiftName, startTime, endTime, priceCents, spaceIds: desks.map((d) => d.id) }).expect(201)).body;
  const morning = await shift('Morning', '09:00', '12:00', 500_000);
  const evening = await shift('Evening', '16:00', '20:00', 400_000);
  return { plan, morning, evening, desks, shift };
}

let people = 0;
/** A new member on the plan's Morning shift at the first desk, starting tomorrow. Extra fields go to POST /members as they are. */
export async function planMember(ctx: Ctx, owner: Agent, p: Awaited<ReturnType<typeof planWithShifts>>, extra: Record<string, unknown> = {}) {
  const n = ++people;
  return (
    await owner
      .post('/api/members')
      .send({ locationId: ctx.loc.id, name: `Plan Person ${n}`, email: `plan${n}@x.dev`, planId: p.plan.id, status: 'active', startDate: inDays(1), shiftIds: [p.morning.id], deskIds: [p.desks[0]!.id], ...extra })
      .expect(201)
  ).body as typeof members.$inferSelect;
}

/** A team member of org A at the main location with exactly these permissions. */
export async function staffWith(ctx: Ctx, owner: Agent, email: string, permissions: string[]) {
  await owner.post('/api/staff').send({ name: email, email, permissions, locationIds: [ctx.loc.id], password: 'password123' }).expect(201);
  return login(ctx.app, email);
}

const emp = (n: string) => ({ name: `Emp ${n}`, email: `${n.toLowerCase()}${++people}@acme.dev`, phone: '0300', password: 'password123', deskResourceId: null });

/**
 * Acme: six people sharing the Boardroom set to five seats, 10,000.00 each and 5,000.00 for the extra person: 55,000.00 a month.
 * Starts on the first day of `month` so that month is billed in full.
 */
export async function acme(ctx: Ctx, owner: Agent, month: string, over: Record<string, unknown> = {}) {
  await ctx.db.update(resources).set({ capacity: 5 }).where(eq(resources.id, ctx.room.id)).run();
  const contract = (
    await owner
      .post('/api/contracts/company')
      .send({
        locationId: ctx.loc.id,
        companyName: 'Acme Ltd',
        startDate: `${month}-01`,
        endDate: inDays(200),
        pricingMode: 'per_member',
        pricePerMemberCents: 1_000_000,
        extraMemberCents: 500_000,
        fixedPriceCents: 0,
        spaceIds: [ctx.room.id],
        people: ['A', 'B', 'C', 'D', 'E', 'F'].map(emp),
        ...over,
      })
      .expect(201)
  ).body as { id: string; memberId: string };
  await owner.post(`/api/contracts/${contract.id}/activate`).expect(200);
  return contract;
}

export const generate = (owner: Agent, locationId: string, month: string) => owner.post('/api/invoices/generate').send({ locationId, month }).expect(201);

export async function financeReport(owner: Agent, locationId: string, from: string, to: string) {
  return (await owner.get(`/api/reports/finance?locationId=${locationId}&from=${from}&to=${to}`).expect(200)).body;
}

/** Every invoice of a member with its lines, oldest first. */
export async function invoicesOf(ctx: Ctx, memberId: string) {
  const rows = await ctx.db.select().from(invoices).where(eq(invoices.memberId, memberId)).all();
  return Promise.all(
    rows
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(async (i) => ({ ...i, items: await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, i.id)).all() })),
  );
}

/** What a member's standing (non-void) invoices took off for their advance. */
export async function advanceTaken(ctx: Ctx, memberId: string) {
  return -sum((await invoicesOf(ctx, memberId)).filter((i) => i.status !== 'void').flatMap((i) => i.items.filter((l) => l.amountCents < 0).map((l) => l.amountCents)));
}

/** A manual invoice for a member, created through the API. */
export async function manualInvoice(owner: Agent, memberId: string, unitPriceCents: number, extra: Record<string, unknown> = {}) {
  return (await owner.post('/api/invoices').send({ memberId, items: [{ description: 'Service', quantity: 1, unitPriceCents }], ...extra }).expect(201)).body as typeof invoices.$inferSelect;
}

export async function ownerUserId(ctx: Ctx) {
  return (await ctx.db.select().from(users).where(eq(users.email, 'owner@test.dev')).get())!.id;
}

/** Gives org B (Hive) every feature, so cross-tenant tests reach the record checks instead of stopping at the package. */
export async function upgradeHive(ctx: Ctx) {
  await ctx.db.update(organizations).set({ packageId: ctx.fullPackage.id }).where(eq(organizations.id, ctx.orgB.id)).run();
}

export const rows = {
  payment: (ctx: Ctx, id: string) => ctx.db.select().from(payments).where(eq(payments.id, id)).get(),
  invoice: (ctx: Ctx, id: string) => ctx.db.select().from(invoices).where(eq(invoices.id, id)).get(),
  expense: (ctx: Ctx, id: string) => ctx.db.select().from(expenses).where(eq(expenses.id, id)).get(),
  member: (ctx: Ctx, id: string) => ctx.db.select().from(members).where(eq(members.id, id)).get(),
  amenityOrder: (ctx: Ctx, id: string) => ctx.db.select().from(amenityOrders).where(eq(amenityOrders.id, id)).get(),
  depositEntries: (ctx: Ctx, locationId: string) => ctx.db.select().from(depositEntries).where(eq(depositEntries.locationId, locationId)).all(),
};

export { setup, TZ, inDays };
