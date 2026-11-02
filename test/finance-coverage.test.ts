import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { contracts, expenses, invoices, members, payments } from '../src/db/schema.js';
import { login, setup } from './helpers.js';
import { acme, financeReport, generate, manualInvoice, monthFromNow, ownerOf, rows, sum, today, upgradeHive } from './helpers/finance.js';

/**
 * Finance behaviour the audit found untested. Everything here passes today; where a case turned out to be a bug, it is in
 * finance-bugs.test.ts instead (T1, L4, S1, M5) and only the parts that already work are checked here.
 */

const monthOf = (rep: { monthly: { month: string; collectedCents: number; invoicedCents: number; expensesCents: number }[] }, m: string) => rep.monthly.find((x) => x.month === m)!;

describe('finance report month boundaries in a non-UTC timezone (America/New_York)', () => {
  it('puts 23:59 and 00:01 local on month ends in the right month, through a leap February and a DST change', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const inv = await manualInvoice(owner, ctx.basic.member.id, 1_000_000, { issueDate: '2024-01-31', dueDate: '2024-02-14' });
    // Written as UTC instants by hand, so the check does not lean on the application's own timezone code.
    const pays: [string, number][] = [
      ['2024-02-01T04:59:00.000Z', 1], // 23:59 EST on 31 January  -> January
      ['2024-02-01T05:01:00.000Z', 2], // 00:01 EST on 1 February  -> February
      ['2024-03-01T04:59:00.000Z', 4], // 23:59 EST on 29 February (leap year) -> February
      ['2024-03-01T05:01:00.000Z', 8], // 00:01 EST on 1 March     -> March
      ['2024-04-01T03:59:00.000Z', 16], // 23:59 EDT on 31 March (after the 10 March DST change) -> March
      ['2024-04-01T04:01:00.000Z', 32], // 00:01 EDT on 1 April    -> April, outside the report
    ];
    for (const [paidAt, amountCents] of pays) await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents, method: 'cash', paidAt }).expect(201);
    await owner.post('/api/expenses').send({ locationId: ctx.loc.id, category: 'rent', amountCents: 100, incurredOn: '2024-02-29' }).expect(201);
    await owner.post('/api/expenses').send({ locationId: ctx.loc.id, category: 'rent', amountCents: 200, incurredOn: '2024-03-01' }).expect(201);

    const q1 = await financeReport(owner, ctx.loc.id, '2024-01-01', '2024-03-31');
    expect(q1.monthly.map((m: { month: string }) => m.month)).toEqual(['2024-01', '2024-02', '2024-03']);
    expect([monthOf(q1, '2024-01').collectedCents, monthOf(q1, '2024-02').collectedCents, monthOf(q1, '2024-03').collectedCents]).toEqual([1, 6, 24]);
    expect([monthOf(q1, '2024-02').expensesCents, monthOf(q1, '2024-03').expensesCents]).toEqual([100, 200]);
    expect(monthOf(q1, '2024-01').invoicedCents).toBe(1_100_000);
    expect(q1.totals.collectedCents).toBe(31);
    expect(q1.previous).toMatchObject({ from: '2023-10-02', to: '2023-12-31', collectedCents: 0 });

    // A report that ends on the leap day includes its last minute and nothing after.
    const feb = await financeReport(owner, ctx.loc.id, '2024-02-01', '2024-02-29');
    expect(feb.totals).toMatchObject({ collectedCents: 6, expensesCents: 100, invoicedCents: 0 });
    // The payments list uses the same local-day edges.
    const list = (await owner.get(`/api/payments?locationId=${ctx.loc.id}&from=2024-02-01&to=2024-02-29`).expect(200)).body as { amountCents: number }[];
    expect(sum(list.map((p) => p.amountCents))).toBe(6);
    // So does the expense list.
    const spent = (await owner.get(`/api/expenses?locationId=${ctx.loc.id}&from=2024-02-29&to=2024-02-29`).expect(200)).body as { amountCents: number }[];
    expect(spent.map((e) => e.amountCents)).toEqual([100]);
  });
});

describe('another tenant guessing finance record ids', () => {
  it('can neither read nor change them, and learns nothing but a refusal', async () => {
    const ctx = await setup();
    await upgradeHive(ctx);
    const owner = await ownerOf(ctx);
    const hive = await login(ctx.app, 'owner@hive.dev');
    const inv = await manualInvoice(owner, ctx.basic.member.id, 10_000);
    const pay = (await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 1_000, method: 'cash' }).expect(201)).body.payment;
    const exp = (await owner.post('/api/expenses').send({ locationId: ctx.loc.id, category: 'rent', amountCents: 5_000 }).expect(201)).body;
    const con = (await owner.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.basic.member.id, startDate: today(), depositCents: 100, advanceCents: 100 }).expect(201)).body;

    const m = ctx.basic.member.id;
    const tries: [string, () => PromiseLike<{ status: number; body: Record<string, unknown> }>][] = [
      ['read invoice', () => hive.get(`/api/invoices/${inv.id}`)],
      ['pay invoice', () => hive.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 1, method: 'cash' })],
      ['void invoice', () => hive.post(`/api/invoices/${inv.id}/void`)],
      ['delete payment', () => hive.delete(`/api/payments/${pay.id}`)],
      ['edit expense', () => hive.patch(`/api/expenses/${exp.id}`).send({ amountCents: 1 })],
      ['delete expense', () => hive.delete(`/api/expenses/${exp.id}`)],
      ['read deposit entries', () => hive.get(`/api/contracts/${con.id}/deposit-entries`)],
      ['receive contract deposit', () => hive.post(`/api/contracts/${con.id}/deposit`).send({ action: 'receive' })],
      ['receive contract advance', () => hive.post(`/api/contracts/${con.id}/advance`).send({})],
      ['edit contract', () => hive.patch(`/api/contracts/${con.id}`).send({ notes: 'x' })],
      ['read member', () => hive.get(`/api/members/${m}`)],
      ['record member money', () => hive.post(`/api/members/${m}/money`).send({ depositCents: 1 })],
      ['settle member deposit', () => hive.post(`/api/members/${m}/deposit`).send({ action: 'forfeit' })],
      ['list invoices', () => hive.get(`/api/invoices?locationId=${ctx.loc.id}`)],
      ['list payments', () => hive.get(`/api/payments?locationId=${ctx.loc.id}`)],
      ['list expenses', () => hive.get(`/api/expenses?locationId=${ctx.loc.id}`)],
      ['finance report', () => hive.get(`/api/reports/finance?locationId=${ctx.loc.id}`)],
      ['generate invoices', () => hive.post('/api/invoices/generate').send({ locationId: ctx.loc.id, month: today().slice(0, 7) })],
    ];
    for (const [label, send] of tries) {
      const res = await send();
      expect([403, 404], label).toContain(res.status);
      expect(Object.keys(res.body), `${label} body`).toEqual(expect.arrayContaining(['error']));
      expect(JSON.stringify(res.body), label).not.toContain(inv.number); // nothing of the record comes back
    }
    // Nothing changed.
    expect((await rows.invoice(ctx, inv.id))!).toMatchObject({ status: 'open', paidCents: 1_000 });
    expect(await rows.payment(ctx, pay.id)).toBeDefined();
    expect((await rows.expense(ctx, exp.id))!.amountCents).toBe(5_000);
    expect((await ctx.db.select().from(contracts).where(eq(contracts.id, con.id)).get())!).toMatchObject({ depositStatus: 'pending', advanceReceivedAt: null, notes: '' });
    expect((await rows.member(ctx, ctx.basic.member.id))!).toMatchObject({ depositStatus: 'pending', advanceCents: 0 });
    expect(await rows.depositEntries(ctx, ctx.loc.id)).toHaveLength(0);

    // Ids that do not exist anywhere answer 404 (S1 in finance-bugs: another tenant's ids should look exactly the same).
    const nobody = '00000000-0000-4000-8000-000000000000';
    for (const path of [`/api/invoices/${nobody}`, `/api/contracts/${nobody}/deposit-entries`, `/api/members/${nobody}`]) expect((await hive.get(path)).status, path).toBe(404);
    for (const path of [`/api/payments/${nobody}`, `/api/expenses/${nobody}`]) expect((await hive.delete(path)).status, path).toBe(404);
  });
});

describe('very large amounts', () => {
  it('keeps exact totals up to a trillion and refuses numbers JavaScript cannot hold exactly', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const inv = (await owner.post('/api/invoices').send({ memberId: ctx.basic.member.id, items: [{ description: 'Big', quantity: 3, unitPriceCents: 333_333_333_333 }] }).expect(201)).body;
    // 999,999,999,999 + 10% tax (99,999,999,999.9, rounded once) = 1,099,999,999,999
    expect(inv).toMatchObject({ subtotalCents: 999_999_999_999, taxCents: 100_000_000_000, totalCents: 1_099_999_999_999 });
    await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 1_099_999_999_998, method: 'bank_transfer' }).expect(201);
    expect((await rows.invoice(ctx, inv.id))!).toMatchObject({ status: 'open', paidCents: 1_099_999_999_998 });
    await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 1, method: 'cash' }).expect(201);
    expect((await rows.invoice(ctx, inv.id))!.status).toBe('paid');
    const rep = await financeReport(owner, ctx.loc.id, `${today().slice(0, 7)}-01`, today());
    expect(rep.totals.collectedCents).toBe(1_099_999_999_999);

    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    await owner.post('/api/expenses').send({ locationId: ctx.loc.id, category: 'rent', amountCents: unsafe }).expect(400);
    await owner.post('/api/invoices').send({ memberId: ctx.basic.member.id, items: [{ description: 'x', quantity: 1, unitPriceCents: unsafe }] }).expect(400);
    await owner.post('/api/invoices').send({ memberId: ctx.basic.member.id, items: [{ description: 'x', quantity: 10_001, unitPriceCents: 1 }] }).expect(400);
    await owner.post(`/api/members/${ctx.basic.member.id}/money`).send({ advanceCents: 1_000_000_000_001 }).expect(400);
    // An unsafe quantity x price total gives a server error today; that is L4 in finance-bugs.
  });
});

describe('invalid and negative inputs', () => {
  it('are refused with 400 and change nothing', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const root = await login(ctx.app, 'root@platform.dev');
    const inv = await manualInvoice(owner, ctx.basic.member.id, 10_000);
    const m = ctx.basic.member.id;
    const bad: [() => PromiseLike<{ status: number }>, string][] = [
      [() => owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 0, method: 'cash' }), 'zero payment'],
      [() => owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: -100, method: 'cash' }), 'negative payment'],
      [() => owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 1.5, method: 'cash' }), 'fractional payment'],
      [() => owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: '100', method: 'cash' }), 'payment as text'],
      [() => owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 100 }), 'no method'],
      [() => owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 100, method: 'bitcoin' }), 'unknown method'],
      [() => owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 100, method: 'cash', paidAt: 'yesterday' }), 'bad paidAt'],
      [() => owner.post('/api/invoices').send({ memberId: m, items: [] }), 'no lines'],
      [() => owner.post('/api/invoices').send({ memberId: m, items: [{ description: 'x', quantity: 0, unitPriceCents: 1 }] }), 'zero quantity'],
      [() => owner.post('/api/invoices').send({ memberId: m, items: [{ description: 'x', quantity: 1, unitPriceCents: -1 }] }), 'negative price'],
      [() => owner.post('/api/invoices').send({ memberId: m, items: [{ description: 'x', quantity: 1.5, unitPriceCents: 1 }] }), 'fractional quantity'],
      [() => owner.post('/api/invoices').send({ memberId: m, issueDate: '2024-03-10', dueDate: '2024-03-01', items: [{ description: 'x', quantity: 1, unitPriceCents: 1 }] }), 'due before issue'],
      [() => owner.post('/api/invoices').send({ memberId: m, issueDate: '2024-02-30', items: [{ description: 'x', quantity: 1, unitPriceCents: 1 }] }), 'impossible date'],
      [() => owner.post('/api/invoices/generate').send({ locationId: ctx.loc.id, month: '2024-13' }), 'month 13'],
      [() => owner.post('/api/invoices/generate').send({ locationId: ctx.loc.id, month: '2024-01', dueInDays: 121 }), 'due too far'],
      [() => owner.post('/api/invoices/generate').send({ locationId: ctx.loc.id, month: '2024-01', dueInDays: -1 }), 'negative due days'],
      [() => owner.post('/api/expenses').send({ locationId: ctx.loc.id, category: 'rent', amountCents: 0 }), 'zero expense'],
      [() => owner.post('/api/expenses').send({ locationId: ctx.loc.id, category: 'bribes', amountCents: 10 }), 'unknown category'],
      [() => owner.post('/api/expenses').send({ locationId: ctx.loc.id, category: 'rent', amountCents: 10, incurredOn: '2024-02-30' }), 'impossible expense date'],
      [() => owner.post(`/api/members/${m}/money`).send({ advanceCents: -1 }), 'negative advance'],
      [() => owner.post(`/api/members/${m}/money`).send({ depositCents: 10.5 }), 'fractional deposit'],
      [() => owner.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: m, startDate: today(), rentCents: -1 }), 'negative rent'],
      [() => owner.post('/api/amenities').send({ locationId: ctx.loc.id, name: 'Tea', priceCents: -1 }), 'negative amenity price'],
      [() => owner.post('/api/plans').send({ locationId: ctx.loc.id, name: 'P', priceCents: -1 }), 'negative plan price'],
      [() => owner.post('/api/shifts').send({ locationId: ctx.loc.id, name: 'S', startTime: '09:00', endTime: '10:00', priceCents: -1 }), 'negative shift price'],
      [() => owner.put('/api/resources/pricing').send({ locationId: ctx.loc.id, prices: [{ resourceId: ctx.room.id, hourlyRateCents: -1 }] }), 'negative hourly price'],
      [() => root.post(`/api/platform/organizations/${ctx.org.id}/payments`).send({ amountCents: 0, method: 'cash' }), 'zero platform payment'],
      [() => root.post(`/api/platform/organizations/${ctx.org.id}/payments`).send({ amountCents: 100, method: 'cash', periods: 0 }), 'zero periods'],
      [() => owner.post(`/api/invoices/${inv.id}/payments`).set('Content-Type', 'application/json').send('{"amountCents": 1,'), 'malformed JSON'],
    ];
    for (const [send, label] of bad) expect((await send()).status, label).toBe(400);
    expect((await rows.invoice(ctx, inv.id))!.paidCents).toBe(0);
    expect(await ctx.db.select().from(invoices).where(eq(invoices.locationId, ctx.loc.id)).all()).toHaveLength(1);
    expect(await ctx.db.select().from(expenses).all()).toHaveLength(0);
  });

  it('refuses returning more of a deposit than was held', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const c = (await owner.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.basic.member.id, startDate: today(), depositCents: 10_000 }).expect(201)).body;
    await owner.post(`/api/contracts/${c.id}/deposit`).send({ action: 'receive', method: 'cash' }).expect(200);
    await owner.post(`/api/contracts/${c.id}/activate`).expect(200);
    await owner.post(`/api/contracts/${c.id}/end`).send({}).expect(200);
    await owner.post(`/api/contracts/${c.id}/deposit`).send({ action: 'refund', returnedCents: 10_001, method: 'cash' }).expect(400);
    await owner.post(`/api/contracts/${c.id}/deposit`).send({ action: 'refund', returnedCents: -1, method: 'cash' }).expect(400);
    await owner.post(`/api/contracts/${c.id}/deposit`).send({ action: 'refund', returnedCents: 4_000, method: 'cash' }).expect(200);
    expect((await rows.depositEntries(ctx, ctx.loc.id)).map((e) => [e.kind, e.amountCents]).sort()).toEqual([
      ['kept', 6_000],
      ['received', 10_000],
      ['refunded', 4_000],
    ]);
  });
});

describe('paying twice and paying too much', () => {
  it('takes part payments up to the balance and refuses anything beyond it', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const inv = await manualInvoice(owner, ctx.basic.member.id, 10_000); // 11,000 with tax
    await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 11_001, method: 'cash' }).expect(400);
    const first = (await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 5_000, method: 'cash' }).expect(201)).body;
    expect(first.invoice).toMatchObject({ status: 'open', paidCents: 5_000 });
    await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 6_001, method: 'cash' }).expect(400);
    await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 6_000, method: 'card' }).expect(201);
    await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 1, method: 'cash' }).expect(409); // already paid
    await owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 6_000, method: 'card' }).expect(409); // the same payment again
    await owner.post(`/api/invoices/${inv.id}/void`).expect(409); // it has payments
    expect((await rows.invoice(ctx, inv.id))!).toMatchObject({ status: 'paid', paidCents: 11_000 });
    await owner.delete(`/api/payments/${first.payment.id}`).expect(200);
    expect((await rows.invoice(ctx, inv.id))!).toMatchObject({ status: 'open', paidCents: 6_000 });
  });
});

describe('generating the same month twice', () => {
  it('bills members, bookings and a company once', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const month = monthFromNow(-2);
    await ctx.db.update(members).set({ startDate: `${month}-01` }).where(eq(members.locationId, ctx.loc.id)).run();
    await acme(ctx, owner, month);
    const first = (await generate(owner, ctx.loc.id, month)).body;
    expect(first.created).toBeGreaterThanOrEqual(3); // pro, basic and the company
    const count = (await ctx.db.select().from(invoices).where(eq(invoices.locationId, ctx.loc.id)).all()).length;
    const second = (await generate(owner, ctx.loc.id, month)).body;
    expect(second.created).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(first.created);
    expect(await ctx.db.select().from(invoices).where(eq(invoices.locationId, ctx.loc.id)).all()).toHaveLength(count);
  });
});

describe('the tax rate changing', () => {
  it('leaves issued invoices at their rate, and taxes new ones at the new rate', async () => {
    const ctx = await setup();
    const owner = await ownerOf(ctx);
    const before = await manualInvoice(owner, ctx.basic.member.id, 10_000); // 10%
    await owner.patch(`/api/locations/${ctx.loc.id}`).send({ taxRateBps: 2_000 }).expect(200);
    await owner.post(`/api/invoices/${before.id}/payments`).send({ amountCents: 11_000, method: 'cash' }).expect(201);
    expect((await rows.invoice(ctx, before.id))!).toMatchObject({ taxCents: 1_000, totalCents: 11_000, status: 'paid' });
    const after = await manualInvoice(owner, ctx.basic.member.id, 10_000);
    expect(after).toMatchObject({ taxCents: 2_000, totalCents: 12_000 });
    // An advance applied after the change re-taxes the invoice at the new rate: that is T1 in finance-bugs.
  });
});

describe('a package without invoicing', () => {
  it('keeps the invoice, payment and finance screens closed', async () => {
    const ctx = await setup();
    const hive = await login(ctx.app, 'owner@hive.dev');
    const L = ctx.locB.id;
    const closed: [string, () => PromiseLike<{ status: number; body: { details?: unknown } }>][] = [
      ['list invoices', () => hive.get(`/api/invoices?locationId=${L}`)],
      ['manual invoice', () => hive.post('/api/invoices').send({ memberId: ctx.hiveMember.member.id, items: [{ description: 'x', quantity: 1, unitPriceCents: 1 }] })],
      ['generate invoices', () => hive.post('/api/invoices/generate').send({ locationId: L, month: today().slice(0, 7) })],
      ['list payments', () => hive.get(`/api/payments?locationId=${L}`)],
      ['finance report', () => hive.get(`/api/reports/finance?locationId=${L}`)],
      ['list expenses', () => hive.get(`/api/expenses?locationId=${L}`)],
    ];
    for (const [label, send] of closed) {
      const res = await send();
      expect(res.status, label).toBe(403);
      expect(res.body.details, label).toMatchObject({ feature: expect.any(String) });
    }
    expect((await hive.get(`/api/reports/dashboard?locationId=${L}`).expect(200)).body.finance).toBeNull();
    // Amenity and plan invoices still get made: M5a and M5b in finance-bugs.
  });
});

describe('concurrency (a file database, so requests really overlap)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coplaces-concurrency-'));
  afterAll(() => {
    // Windows may hold the database files a moment after the client closes; a temp folder left behind is harmless.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* left for the OS to clean */
    }
  });

  it('lets only one of several identical payments through, and never overpays', async () => {
    const ctx = await setup(`file:${join(dir, 'pay.db').replaceAll('\\', '/')}`);
    const owner = await ownerOf(ctx);
    const inv = await manualInvoice(owner, ctx.basic.member.id, 10_000); // 11,000
    const results = await Promise.all(Array.from({ length: 6 }, () => owner.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 11_000, method: 'cash' })));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.every((s) => s === 201 || s >= 400)).toBe(true);
    const made = await ctx.db.select().from(payments).where(eq(payments.invoiceId, inv.id)).all();
    expect(made).toHaveLength(1);
    expect((await rows.invoice(ctx, inv.id))!).toMatchObject({ status: 'paid', paidCents: 11_000 });

    // Part payments racing for the same balance: whatever gets through, the invoice is never paid more than its total.
    const inv2 = await manualInvoice(owner, ctx.basic.member.id, 10_000);
    await Promise.all(Array.from({ length: 6 }, () => owner.post(`/api/invoices/${inv2.id}/payments`).send({ amountCents: 4_000, method: 'cash' })));
    const paid = sum((await ctx.db.select().from(payments).where(eq(payments.invoiceId, inv2.id)).all()).map((p) => p.amountCents));
    expect(paid).toBe(8_000); // two fit in 11,000; a third would overpay
    expect((await rows.invoice(ctx, inv2.id))!.paidCents).toBe(8_000);
    ctx.db.$client.close();
  });

  it('bills each member once when the same month is generated several times at once', async () => {
    const ctx = await setup(`file:${join(dir, 'gen.db').replaceAll('\\', '/')}`);
    const owner = await ownerOf(ctx);
    const month = monthFromNow(-1);
    await ctx.db.update(members).set({ startDate: `${month}-01` }).where(eq(members.locationId, ctx.loc.id)).run();
    const results = await Promise.all(Array.from({ length: 4 }, () => owner.post('/api/invoices/generate').send({ locationId: ctx.loc.id, month })));
    const created = sum(results.filter((r) => r.status === 201).map((r) => r.body.created as number));
    const bills = await ctx.db.select().from(invoices).where(and(eq(invoices.locationId, ctx.loc.id), eq(invoices.periodStart, `${month}-01`))).all();
    expect(bills).toHaveLength(2); // pro and basic, once each
    expect(new Set(bills.map((b) => b.memberId)).size).toBe(2);
    expect(created).toBe(2);
    ctx.db.$client.close();
  });
});
