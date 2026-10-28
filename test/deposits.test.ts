import { describe, expect, it } from 'vitest';
import { login, setup } from './helpers.js';
import { resources } from '../src/db/schema.js';
import { todayIn } from '../src/lib/time.js';
import { TZ } from './helpers.js';

const today = todayIn(TZ);

/** A contract with a 1,000.00 deposit, started and ended so the deposit can be settled. */
async function ended(ctx: Awaited<ReturnType<typeof setup>>, received = true, resourceId = ctx.dedicated.id) {
  const staff = await login(ctx.app, 'owner@test.dev');
  const c = await staff.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.pro.member.id, resourceId, startDate: today, depositCents: 100_000 }).expect(201);
  if (received) await staff.post(`/api/contracts/${c.body.id}/deposit`).send({ action: 'receive', method: 'bank_transfer', reference: 'TRX-77' }).expect(200);
  await staff.post(`/api/contracts/${c.body.id}/activate`).expect(200);
  await staff.post(`/api/contracts/${c.body.id}/end`).send({}).expect(200);
  return { staff, id: c.body.id as string };
}
const report = async (staff: Awaited<ReturnType<typeof login>>, ctx: Awaited<ReturnType<typeof setup>>) =>
  (await staff.get(`/api/reports/finance?locationId=${ctx.loc.id}&from=${today.slice(0, 7)}-01&to=${today}`).expect(200)).body;

describe('deposit ledger', () => {
  it('writes each movement with how it was paid and a reference', async () => {
    const ctx = await setup();
    const { staff, id } = await ended(ctx);
    await staff.post(`/api/contracts/${id}/deposit`).send({ action: 'refund', returnedCents: 70_000, method: 'cash' }).expect(200);
    const rows = (await staff.get(`/api/contracts/${id}/deposit-entries`).expect(200)).body;
    expect(rows.map((r: { kind: string; amountCents: number; method: string | null }) => [r.kind, r.amountCents, r.method])).toEqual([
      ['received', 100_000, 'bank_transfer'],
      ['refunded', 70_000, 'cash'],
      ['kept', 30_000, null],
    ]);
    expect(rows[0].reference).toBe('TRX-77');
  });

  it('shows the deposits held on Finance, and drops them once refunded', async () => {
    const ctx = await setup();
    const { staff, id } = await ended(ctx);
    expect((await report(staff, ctx)).deposits).toMatchObject({ heldCents: 100_000, receivedCents: 100_000, refundedCents: 0, keptCents: 0 });
    await staff.post(`/api/contracts/${id}/deposit`).send({ action: 'refund' }).expect(200);
    expect((await report(staff, ctx)).deposits).toMatchObject({ heldCents: 0, refundedCents: 100_000, keptCents: 0 });
  });

  it('keeps a returned deposit out of income and counts a kept one as income', async () => {
    const ctx = await setup();
    const a = await ended(ctx);
    await a.staff.post(`/api/contracts/${a.id}/deposit`).send({ action: 'refund' }).expect(200);
    const clean = await report(a.staff, ctx);
    expect(clean.totals.collectedCents).toBe(0);
    expect(clean.incomeByKind.find((i: { kind: string }) => i.kind === 'kept_deposit').amountCents).toBe(0);

    const second = await ctx.db.insert(resources).values({ locationId: ctx.loc.id, kind: 'dedicated_desk', name: 'Desk D2' }).returning().get();
    const b = await ended(ctx, true, second.id);
    await b.staff.post(`/api/contracts/${b.id}/deposit`).send({ action: 'refund', returnedCents: 60_000 }).expect(200);
    const r = await report(b.staff, ctx);
    expect(r.deposits).toMatchObject({ heldCents: 0, keptCents: 40_000 });
    expect(r.totals).toMatchObject({ collectedCents: 40_000, netCents: 40_000 });
    expect(r.incomeByKind.find((i: { kind: string }) => i.kind === 'kept_deposit').amountCents).toBe(40_000);
    expect(r.profitLoss.income.find((i: { kind: string }) => i.kind === 'kept_deposit').totalCents).toBe(40_000);
    expect(r.monthly.at(-1).collectedCents).toBe(40_000);
    expect(r.paymentsByMethod).toEqual([]);
  });

  it('counts a forfeited deposit as income in full', async () => {
    const ctx = await setup();
    const { staff, id } = await ended(ctx);
    await staff.post(`/api/contracts/${id}/deposit`).send({ action: 'forfeit' }).expect(200);
    const r = await report(staff, ctx);
    expect(r.totals.collectedCents).toBe(100_000);
    expect(r.deposits.movements.map((m: { kind: string }) => m.kind).sort()).toEqual(['kept', 'received']);
    expect(r.deposits.movements[0]).toMatchObject({ memberName: 'pro', resourceName: 'Desk D1' });
  });

  it('refuses an unknown payment method and a contract from another location', async () => {
    const ctx = await setup();
    const { staff, id } = await ended(ctx, false);
    await staff.post(`/api/contracts/${id}/deposit`).send({ action: 'receive', method: 'bitcoin' }).expect(400);
    const other = await login(ctx.app, 'uptown@test.dev');
    await other.get(`/api/contracts/${id}/deposit-entries`).expect(403);
  });
});

describe('advance', () => {
  it('is income when received, kept apart from the security deposit, and cannot be taken twice', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'owner@test.dev');
    const c = await staff.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.pro.member.id, resourceId: ctx.dedicated.id, startDate: today, depositCents: 100_000, advanceCents: 50_000 }).expect(201);
    expect((await report(staff, ctx)).totals.collectedCents).toBe(0);
    await staff.post(`/api/contracts/${c.body.id}/advance`).send({ method: 'cash' }).expect(200);
    await staff.post(`/api/contracts/${c.body.id}/advance`).send({}).expect(409);
    await staff.post(`/api/contracts/${c.body.id}/deposit`).send({ action: 'receive' }).expect(200);
    const r = await report(staff, ctx);
    expect(r.totals.collectedCents).toBe(50_000);
    expect(r.deposits).toMatchObject({ heldCents: 100_000, receivedCents: 100_000, advanceCents: 50_000 });
    expect(r.incomeByKind.find((i: { kind: string }) => i.kind === 'advance').amountCents).toBe(50_000);
    expect(r.monthly.at(-1).collectedCents).toBe(50_000);
    // Money is already in, so the amounts are locked and the draft cannot just be cancelled.
    await staff.patch(`/api/contracts/${c.body.id}`).send({ advanceCents: 1 }).expect(409);
    await staff.post(`/api/contracts/${c.body.id}/cancel`).expect(409);
  });

  it('refuses an advance on a contract that has none', async () => {
    const ctx = await setup();
    const staff = await login(ctx.app, 'owner@test.dev');
    const c = await staff.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.pro.member.id, startDate: today }).expect(201);
    await staff.post(`/api/contracts/${c.body.id}/advance`).send({}).expect(400);
  });
});
