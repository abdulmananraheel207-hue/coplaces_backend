import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditLog, payments } from '../src/db/schema.js';
import { addMonths, zonedToUtc } from '../src/lib/time.js';
import { login, setup, TZ } from './helpers.js';
import { financeReport, manualInvoice, ownerOf, rows, staffWith, sum, today } from './helpers/finance.js';

describe('taking a payment back', () => {
  it('writes a reversal instead of deleting, so last month keeps its money and this month shows it going back', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const inv = await manualInvoice(owner, ctx.basic.member.id, 10_000); // 11,000
    const lastMonth = addMonths(today().slice(0, 7), -1);
    const paid = (await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 11_000, method: 'card', paidAt: zonedToUtc(`${lastMonth}-15`, '12:00', TZ).toISOString() }).expect(201)).body.payment;
    const before = await financeReport(owner, ctx.loc.id, `${lastMonth}-01`, today());

    const invoice = (await owner.post(`/api/payments/${paid.id}/reverse`).send({ reason: 'Card charge failed' }).expect(200)).body;
    expect(invoice).toMatchObject({ status: 'open', paidCents: 0 });

    const all = await ctx.db.select().from(payments).where(eq(payments.invoiceId, inv.id)).all();
    expect(all).toHaveLength(2);
    const original = all.find((p) => p.id === paid.id)!;
    const reversal = all.find((p) => p.id !== paid.id)!;
    expect(original).toMatchObject({ amountCents: 11_000, reversedById: expect.any(String) });
    expect(original.reversedAt).not.toBeNull();
    expect(reversal).toMatchObject({ amountCents: -11_000, method: 'card', reversesPaymentId: paid.id, notes: 'Card charge failed' });

    const after = await financeReport(owner, ctx.loc.id, `${lastMonth}-01`, today());
    const month = (rep: typeof after, m: string) => rep.monthly.find((x: { month: string }) => x.month === m).collectedCents;
    expect(month(after, lastMonth)).toBe(month(before, lastMonth)); // the past is not rewritten
    expect(month(after, today().slice(0, 7))).toBe(month(before, today().slice(0, 7)) - 11_000);
    expect(after.totals.collectedCents).toBe(before.totals.collectedCents - 11_000);
    expect(sum(after.paymentsByMethod.map((m: { amountCents: number }) => m.amountCents))).toBe(0);

    // The payment list shows both lines.
    const list = (await owner.get(`/api/payments?locationId=${ctx.loc.id}`).expect(200)).body as { amountCents: number }[];
    expect(list.map((p) => p.amountCents).sort((a, b) => a - b)).toEqual([-11_000, 11_000]);
  });

  it('cannot reverse a payment twice, or reverse a reversal', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const inv = await manualInvoice(owner, ctx.basic.member.id, 10_000);
    const paid = (await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 5_000, method: 'cash' }).expect(201)).body.payment;
    await owner.post(`/api/payments/${paid.id}/reverse`).send({}).expect(200);
    await owner.post(`/api/payments/${paid.id}/reverse`).send({}).expect(409);
    await owner.delete(`/api/payments/${paid.id}`).expect(409);
    const reversal = (await ctx.db.select().from(payments).where(eq(payments.reversesPaymentId, paid.id)).get())!;
    await owner.post(`/api/payments/${reversal.id}/reverse`).send({}).expect(409);
    expect((await rows.invoice(ctx, inv.id))!).toMatchObject({ paidCents: 0, status: 'open' });
    // Once the money is taken back, the invoice can be voided.
    await owner.post(`/api/invoices/${inv.id}/void`).expect(200);
  });

  it('needs billing controls, like deleting did', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const inv = await manualInvoice(owner, ctx.basic.member.id, 10_000);
    const paid = (await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 5_000, method: 'cash' }).expect(201)).body.payment;
    const clerk = await staffWith(ctx, owner, 'clerk@test.dev', ['invoices']);
    await clerk.post(`/api/payments/${paid.id}/reverse`).send({}).expect(403);
  });
});

describe('the audit log', () => {
  it('records every money change with who made it, and nobody can change it', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const inv = await manualInvoice(owner, ctx.basic.member.id, 10_000);
    const paid = (await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 5_000, method: 'cash', reference: 'R-1' }).expect(201)).body.payment;
    await owner.post(`/api/payments/${paid.id}/reverse`).send({ reason: 'typo' }).expect(200);
    await owner.post(`/api/invoices/${inv.id}/void`).expect(200);
    const exp = (await owner.post('/api/expenses').send({ locationId: ctx.loc.id, category: 'rent', amountCents: 9_000 }).expect(201)).body;
    await owner.patch(`/api/expenses/${exp.id}`).send({ amountCents: 9_500 }).expect(200);
    await owner.delete(`/api/expenses/${exp.id}`).expect(204);
    await owner.post(`/api/members/${ctx.basic.member.id}/money`).send({ depositCents: 20_000, method: 'bank_transfer', reference: 'B-9' }).expect(204);

    const log = (await owner.get(`/api/audit?locationId=${ctx.loc.id}`).expect(200)).body as { action: string; amountCents: number; actorName: string; entityId: string; data: Record<string, unknown> }[];
    expect(log.map((l) => l.action).sort()).toEqual(['deposit.receive', 'expense.create', 'expense.delete', 'expense.update', 'invoice.create', 'invoice.void', 'payment.record', 'payment.reverse'].sort());
    expect(log.every((l) => l.actorName === 'owner@test.dev')).toBe(true);
    const deleted = log.find((l) => l.action === 'expense.delete')!;
    expect(deleted).toMatchObject({ entityId: exp.id, amountCents: 9_500, data: expect.objectContaining({ category: 'rent', amountCents: 9_500 }) });
    expect(log.find((l) => l.action === 'payment.reverse')!.data).toMatchObject({ reason: 'typo', method: 'cash' });
    expect(log.find((l) => l.action === 'deposit.receive')!).toMatchObject({ amountCents: 20_000, data: { method: 'bank_transfer', reference: 'B-9' } });

    // Filtered by record, and closed to anyone without billing controls or reports.
    const forPayment = (await owner.get(`/api/audit?locationId=${ctx.loc.id}&entity=payment&entityId=${paid.id}`).expect(200)).body;
    expect(forPayment.map((l: { action: string }) => l.action).sort()).toEqual(['payment.record', 'payment.reverse']);
    const desk = await login(ctx.app, 'desk@test.dev'); // the old front desk preset
    await desk.get(`/api/audit?locationId=${ctx.loc.id}`).expect(403);
    const hive = await login(ctx.app, 'owner@hive.dev');
    await hive.get(`/api/audit?locationId=${ctx.loc.id}`).expect(403);
    // There is no way to edit or remove a line.
    await owner.delete(`/api/audit/${log[0]!.entityId}`).expect(404);
    expect((await ctx.db.select().from(auditLog).all()).length).toBe(log.length);
  });

  it('refuses platform payments dated in the future', async () => {
    const ctx = await setup();
    const root = await login(ctx.app, 'root@platform.dev');
    await root.post(`/api/platform/organizations/${ctx.org.id}/payments`).send({ amountCents: 100, method: 'cash', paidAt: new Date(Date.now() + 86_400_000).toISOString() }).expect(400);
    const ok = (await root.post(`/api/platform/organizations/${ctx.org.id}/payments`).send({ amountCents: 100, method: 'cash' }).expect(201)).body;
    const line = await ctx.db.select().from(auditLog).where(eq(auditLog.entityId, ok.payment.id)).get();
    expect(line).toMatchObject({ action: 'platform_payment.record', organizationId: ctx.org.id, amountCents: 100 });
  });
});
