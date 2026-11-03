import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { contracts, depositEntries, invoices, payments } from '../src/db/schema.js';
import { addDays } from '../src/lib/time.js';
import { manualInvoice, ownerOf, planMember, planWithShifts, rows, setup, today, type Agent } from './helpers/finance.js';

type Ctx = Awaited<ReturnType<typeof setup>>;

const report = async (owner: Agent, ctx: Ctx, from = `${today().slice(0, 7)}-01`, to = today()) => (await owner.get(`/api/reports/finance?locationId=${ctx.loc.id}&from=${from}&to=${to}`).expect(200)).body;
const channel = async (owner: Agent, ctx: Ctx, method: string) => (await owner.get(`/api/reports/finance/channel?locationId=${ctx.loc.id}&method=${method}&from=${today().slice(0, 7)}-01&to=${today()}`).expect(200)).body;

describe('payment channels', () => {
  it('are cash, card, online transfer (bank_transfer) and cheque; others are refused, and no channel means cash', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const inv = await manualInvoice(owner, ctx.pro.member.id, 10_000);
    for (const old of ['jazzcash', 'easypaisa', 'other']) await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 100, method: old }).expect(400);
    const made = (await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 100 }).expect(201)).body;
    expect(made.payment.method).toBe('cash');
    expect(made.payment.status).toBe('cleared');
  });
});

describe('cheques on invoices', () => {
  it('do not pay the invoice until they clear, then count on the day they cleared', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const inv = await manualInvoice(owner, ctx.pro.member.id, 10_000); // 11,000 with tax
    const { payment } = (await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 11_000, method: 'cheque', reference: 'CHQ-1' }).expect(201)).body;
    expect(payment.status).toBe('pending');
    let i = (await rows.invoice(ctx, inv.id))!;
    expect(i.status).toBe('open');
    expect(i.paidCents).toBe(0);

    // The cheque holds the balance: nothing more can be taken on top of it, and the invoice cannot be voided under it.
    await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 100, method: 'cash' }).expect(409);
    await owner.post(`/api/invoices/${inv.id}/void`).expect(409);
    // A pending cheque is not reversed; it bounces or clears.
    await owner.post(`/api/payments/${payment.id}/reverse`).send({}).expect(409);

    let rep = await report(owner, ctx);
    expect(rep.totals.collectedCents).toBe(0);
    expect(rep.channels.pendingCheques).toEqual({ count: 1, amountCents: 11_000 });
    expect(rep.currentMonth.owedOnMonthInvoicesCents).toBe(11_000);

    const pending = (await owner.get(`/api/cheques?locationId=${ctx.loc.id}&status=pending`).expect(200)).body;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ source: 'payment', id: payment.id, amountCents: 11_000, reference: 'CHQ-1', invoiceNumber: inv.number });

    await owner.post(`/api/cheques/payment/${payment.id}/clear`).send({ clearedOn: addDays(today(), 1) }).expect(400);
    const cleared = (await owner.post(`/api/cheques/payment/${payment.id}/clear`).send({}).expect(200)).body;
    expect(cleared.invoice.status).toBe('paid');
    i = (await rows.invoice(ctx, inv.id))!;
    expect(i.paidCents).toBe(11_000);
    await owner.post(`/api/cheques/payment/${payment.id}/bounce`).send({}).expect(409);

    rep = await report(owner, ctx);
    expect(rep.totals.collectedCents).toBe(11_000);
    expect(rep.channels.pendingCheques.count).toBe(0);
    expect(rep.channels.flows.find((f: { method: string }) => f.method === 'cheque').salesInCents).toBe(11_000);
    expect(rep.channels.bankCents).toBe(11_000);
    expect(rep.channels.cashInHandCents).toBe(0);
    expect(rep.currentMonth.collectionRatePct).toBe(100);
  });

  it('that bounce leave the invoice open for the full amount and count nowhere', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const inv = await manualInvoice(owner, ctx.pro.member.id, 10_000);
    const { payment } = (await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 11_000, method: 'cheque' }).expect(201)).body;
    const out = (await owner.post(`/api/cheques/payment/${payment.id}/bounce`).send({ reason: 'Insufficient funds' }).expect(200)).body;
    expect(out.invoice.status).toBe('open');
    expect(out.invoice.paidCents).toBe(0);
    expect((await rows.payment(ctx, payment.id))!.status).toBe('bounced');
    await owner.post(`/api/cheques/payment/${payment.id}/clear`).send({}).expect(409);
    // The member pays another way.
    await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 11_000, method: 'bank_transfer' }).expect(201);
    const rep = await report(owner, ctx);
    expect(rep.totals.collectedCents).toBe(11_000);
    expect(rep.channels.flows.find((f: { method: string }) => f.method === 'cheque').salesInCents).toBe(0);
    const book = await channel(owner, ctx, 'cheque');
    expect(book.rows).toHaveLength(1);
    expect(book.rows[0].status).toBe('bounced');
    expect(book.netCents).toBe(0);
  });
});

describe('cheques for advances and security deposits', () => {
  it('take the advance (and take it off the invoice) and hold the deposit only once they clear', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const p = await planWithShifts(ctx, owner);
    const m = await planMember(ctx, owner, p);
    await owner.post(`/api/members/${m.id}/money`).send({ advanceCents: 200_000, depositCents: 300_000, method: 'cheque', reference: 'CHQ-9' }).expect(204);
    let row = (await rows.member(ctx, m.id))!;
    expect(row.advanceCents).toBe(0);
    expect(row.depositStatus).toBe('pending');
    // A second cheque for the same thing waits for the first.
    await owner.post(`/api/members/${m.id}/money`).send({ advanceCents: 200_000, method: 'cash' }).expect(409);

    let rep = await report(owner, ctx);
    expect(rep.totals.collectedCents).toBe(0);
    expect(rep.deposits.heldCents).toBe(0);
    expect(rep.channels.pendingCheques).toEqual({ count: 2, amountCents: 500_000 });

    const pending = (await owner.get(`/api/cheques?locationId=${ctx.loc.id}&status=pending`).expect(200)).body as { id: string; kind: string }[];
    for (const c of pending) await owner.post(`/api/cheques/entry/${c.id}/clear`).send({}).expect(200);
    row = (await rows.member(ctx, m.id))!;
    expect(row.advanceCents).toBe(200_000);
    expect(row.advanceUsedCents).toBeGreaterThan(0); // came off the open plan invoice
    expect(row.depositStatus).toBe('held');
    rep = await report(owner, ctx);
    expect(rep.deposits.heldCents).toBe(300_000);
    expect(rep.deposits.advanceCents).toBe(200_000);
    // Deposit money sits in the bank but is not income; the advance is income.
    expect(rep.channels.bankCents).toBe(500_000);
    expect(rep.totals.collectedCents).toBe(200_000);
  });

  it('a bounced contract advance can be received again', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const c = (await owner.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.pro.member.id, resourceId: ctx.dedicated.id, startDate: today(), rentCents: 100_000, advanceCents: 50_000, depositCents: 80_000 }).expect(201)).body;
    await owner.post(`/api/contracts/${c.id}/advance`).send({ method: 'cheque' }).expect(200);
    expect((await ctx.db.select().from(contracts).where(eq(contracts.id, c.id)).get())!.advanceReceivedAt).toBeNull();
    await owner.post(`/api/contracts/${c.id}/advance`).send({ method: 'cash' }).expect(409);
    await owner.patch(`/api/contracts/${c.id}`).send({ advanceCents: 60_000 }).expect(409);
    await owner.post(`/api/contracts/${c.id}/cancel`).expect(409);
    const e = (await ctx.db.select().from(depositEntries).where(eq(depositEntries.contractId, c.id)).get())!;
    await owner.post(`/api/cheques/entry/${e.id}/bounce`).send({ reason: 'Stopped' }).expect(200);
    await owner.post(`/api/contracts/${c.id}/advance`).send({ method: 'bank_transfer' }).expect(200);
    expect((await ctx.db.select().from(contracts).where(eq(contracts.id, c.id)).get())!.advanceReceivedAt).not.toBeNull();
  });
});

describe('cash in hand and the bank', () => {
  it('follow every channel: money in, refunds, reversals and expenses by how they were paid', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const a = await manualInvoice(owner, ctx.pro.member.id, 10_000);
    const b = await manualInvoice(owner, ctx.basic.member.id, 20_000);
    await owner.post(`/api/invoices/${a.id}/payments`).send({ amountCents: 11_000, method: 'cash' }).expect(201);
    const card = (await owner.post(`/api/invoices/${b.id}/payments`).send({ amountCents: 22_000, method: 'card' }).expect(201)).body.payment;
    await owner.post(`/api/payments/${card.id}/reverse`).send({ reason: 'Charged twice' }).expect(200);
    await owner.post(`/api/invoices/${b.id}/payments`).send({ amountCents: 22_000, method: 'bank_transfer' }).expect(201);
    await owner.post('/api/expenses').send({ locationId: ctx.loc.id, category: 'supplies', amountCents: 3_000, method: 'cash' }).expect(201);
    const ex = (await owner.post('/api/expenses').send({ locationId: ctx.loc.id, category: 'internet', amountCents: 5_000, method: 'bank_transfer', reference: 'TT-1' }).expect(201)).body;
    expect(ex.method).toBe('bank_transfer');
    expect((await owner.post('/api/expenses').send({ locationId: ctx.loc.id, category: 'cleaning', amountCents: 1 }).expect(201)).body.method).toBe('cash');

    const rep = await report(owner, ctx);
    const flow = (m: string) => rep.channels.flows.find((f: { method: string }) => f.method === m);
    expect(flow('cash')).toMatchObject({ salesInCents: 11_000, expensesOutCents: 3_001, netCents: 7_999 });
    expect(flow('card')).toMatchObject({ salesInCents: 22_000, refundsOutCents: 22_000, netCents: 0 });
    expect(flow('bank_transfer')).toMatchObject({ salesInCents: 22_000, expensesOutCents: 5_000, netCents: 17_000 });
    expect(rep.channels.cashInHandCents).toBe(7_999);
    expect(rep.channels.bankCents).toBe(17_000);
    // Shares of what was sold add up to 100%.
    expect(rep.channels.flows.reduce((s: number, f: { sharePct: number }) => s + f.sharePct, 0)).toBeCloseTo(100, 0);

    const cash = await channel(owner, ctx, 'cash');
    expect(cash.balanceEndCents).toBe(7_999);
    expect(cash.rows.map((r: { kind: string }) => r.kind).sort()).toEqual(['expense', 'expense', 'payment']);
    await owner.get(`/api/reports/finance/channel?locationId=${ctx.loc.id}&method=jazzcash`).expect(400);
  });
});

describe('this month, aging and renewals', () => {
  it('show billed, collected and overdue together, aging per member, and contracts ending soon', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const late = await manualInvoice(owner, ctx.pro.member.id, 10_000);
    await ctx.db.update(invoices).set({ issueDate: addDays(today(), -50), dueDate: addDays(today(), -45) }).where(eq(invoices.id, late.id)).run();
    const now = await manualInvoice(owner, ctx.basic.member.id, 20_000);
    await owner.post(`/api/invoices/${now.id}/payments`).send({ amountCents: 2_000, method: 'cash' }).expect(201);
    await owner.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.basic.member.id, resourceId: ctx.dedicated.id, startDate: addDays(today(), -100), endDate: addDays(today(), 20), rentCents: 150_000 }).expect(201);
    const c = (await ctx.db.select().from(contracts).get())!;
    await owner.post(`/api/contracts/${c.id}/activate`).expect(200);

    const rep = await report(owner, ctx);
    expect(rep.currentMonth.invoicedCents).toBe(22_000);
    expect(rep.currentMonth.owedOnMonthInvoicesCents).toBe(20_000);
    expect(rep.currentMonth.overdueNowCents).toBe(11_000);
    expect(rep.currentMonth.overdueNowCount).toBe(1);
    const pro = rep.agingByMember.find((x: { memberId: string }) => x.memberId === ctx.pro.member.id);
    expect(pro).toMatchObject({ days31to60Cents: 11_000, totalCents: 11_000 });
    expect(rep.renewals.in30).toEqual({ count: 1, monthlyCents: 150_000 });
    expect(rep.renewals.rows[0]).toMatchObject({ kind: 'contract', contractId: c.id, daysLeft: 20, within: 30 });
    expect(rep.churn.lostCount).toBe(0);
    expect(rep.churn.activeNow).toBeGreaterThanOrEqual(1);
    expect((await ctx.db.select().from(payments).all()).every((p) => p.status === 'cleared')).toBe(true);
  });
});
