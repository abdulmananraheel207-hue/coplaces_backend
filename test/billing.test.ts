import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bookings, invoices, members } from '../src/db/schema.js';
import { addDays, todayIn } from '../src/lib/time.js';
import { generateSubscriptionInvoices } from '../src/services/billing.js';
import { login, setup, TZ } from './helpers.js';

const item = (description: string, unitPriceCents: number, quantity = 1) => ({ description, unitPriceCents, quantity });

describe('invoices and payments', () => {
  it('creates a manual invoice with tax and sequential numbers', async () => {
    const { app, basic } = await setup();
    const staff = await login(app, 'desk@test.dev');
    const a = await staff
      .post('/api/invoices')
      .send({ memberId: basic.member.id, items: [item('Printing', 500, 4), item('Locker', 1_000)] })
      .expect(201);
    // subtotal 3000, 10% tax
    expect(a.body.subtotalCents).toBe(3_000);
    expect(a.body.taxCents).toBe(300);
    expect(a.body.totalCents).toBe(3_300);
    expect(a.body.status).toBe('open');
    expect(a.body.number).toBe('DTN-00001');
    const b = await staff.post('/api/invoices').send({ memberId: basic.member.id, items: [item('x', 100)] }).expect(201);
    expect(b.body.number).toBe('DTN-00002');
  });

  it('tracks partial and full payments and rejects overpayment', async () => {
    const { app, basic } = await setup();
    const staff = await login(app, 'desk@test.dev');
    const inv = await staff.post('/api/invoices').send({ memberId: basic.member.id, items: [item('Fee', 10_000)] }).expect(201);
    const total = inv.body.totalCents; // 11000

    const p1 = await staff.post(`/api/invoices/${inv.body.id}/payments`).send({ amountCents: 4_000, method: 'cash' }).expect(201);
    expect(p1.body.invoice.status).toBe('open');
    expect(p1.body.invoice.paidCents).toBe(4_000);

    await staff.post(`/api/invoices/${inv.body.id}/payments`).send({ amountCents: total, method: 'card' }).expect(400);
    await staff.post(`/api/invoices/${inv.body.id}/payments`).send({ amountCents: 0, method: 'card' }).expect(400);

    const p2 = await staff
      .post(`/api/invoices/${inv.body.id}/payments`)
      .send({ amountCents: total - 4_000, method: 'bank_transfer', reference: 'WIRE-1' })
      .expect(201);
    expect(p2.body.invoice.status).toBe('paid');
    await staff.post(`/api/invoices/${inv.body.id}/payments`).send({ amountCents: 100, method: 'cash' }).expect(409);

    const detail = await staff.get(`/api/invoices/${inv.body.id}`).expect(200);
    expect(detail.body.payments).toHaveLength(2);
    expect(detail.body.balanceCents).toBe(0);
  });

  it('reopens an invoice when a payment is deleted, but only managers may delete', async () => {
    const { app, basic } = await setup();
    const staff = await login(app, 'desk@test.dev');
    const manager = await login(app, 'manager@test.dev');
    const inv = await staff.post('/api/invoices').send({ memberId: basic.member.id, items: [item('Fee', 1_000)] }).expect(201);
    const paid = await staff
      .post(`/api/invoices/${inv.body.id}/payments`)
      .send({ amountCents: inv.body.totalCents, method: 'cash' })
      .expect(201);
    expect(paid.body.invoice.status).toBe('paid');

    await staff.delete(`/api/payments/${paid.body.payment.id}`).expect(403);
    const reopened = await manager.delete(`/api/payments/${paid.body.payment.id}`).expect(200);
    expect(reopened.body.status).toBe('open');
    expect(reopened.body.paidCents).toBe(0);
  });

  it('voids unpaid invoices only and releases their bookings', async () => {
    const { app, db, room, basic } = await setup();
    const staff = await login(app, 'desk@test.dev');
    const manager = await login(app, 'manager@test.dev');
    const b = await staff
      .post('/api/bookings')
      .send({ resourceId: room.id, memberId: basic.member.id, date: addDays(todayIn(TZ), 1), startTime: '10:00', endTime: '11:00' })
      .expect(201);

    const inv = await staff.post('/api/invoices').send({ memberId: basic.member.id, items: [item('Fee', 1_000)] }).expect(201);
    await db.update(bookings).set({ invoiceId: inv.body.id }).where(eq(bookings.id, b.body.id)).run();

    await staff.post(`/api/invoices/${inv.body.id}/void`).expect(403);
    await staff.post(`/api/invoices/${inv.body.id}/payments`).send({ amountCents: 100, method: 'cash' }).expect(201);
    await manager.post(`/api/invoices/${inv.body.id}/void`).expect(409);

    const clean = await staff.post('/api/invoices').send({ memberId: basic.member.id, items: [item('Other', 500)] }).expect(201);
    await db.update(bookings).set({ invoiceId: clean.body.id }).where(eq(bookings.id, b.body.id)).run();
    const voided = await manager.post(`/api/invoices/${clean.body.id}/void`).expect(200);
    expect(voided.body.status).toBe('void');
    expect((await db.select().from(bookings).where(eq(bookings.id, b.body.id)).get())!.invoiceId).toBeNull();
    await staff.post(`/api/invoices/${clean.body.id}/payments`).send({ amountCents: 100, method: 'cash' }).expect(409);
  });

  it('flags overdue invoices', async () => {
    const { app, basic } = await setup();
    const staff = await login(app, 'desk@test.dev');
    const today = todayIn(TZ);
    await staff
      .post('/api/invoices')
      .send({ memberId: basic.member.id, issueDate: addDays(today, -30), dueDate: addDays(today, -10), items: [item('Old', 1_000)] })
      .expect(201);
    await staff.post('/api/invoices').send({ memberId: basic.member.id, items: [item('New', 1_000)] }).expect(201);
    const loc = (await staff.get('/api/auth/me')).body.locations[0].id;
    const overdue = await staff.get(`/api/invoices?locationId=${loc}&status=overdue`).expect(200);
    expect(overdue.body).toHaveLength(1);
    expect(overdue.body[0].overdue).toBe(true);
  });

  it('lets members see only their own invoices', async () => {
    const { app, loc, pro, basic } = await setup();
    const staff = await login(app, 'desk@test.dev');
    const mine = await staff.post('/api/invoices').send({ memberId: basic.member.id, items: [item('Mine', 1_000)] }).expect(201);
    const theirs = await staff.post('/api/invoices').send({ memberId: pro.member.id, items: [item('Theirs', 1_000)] }).expect(201);

    const agent = await login(app, 'basic@test.dev');
    const list = await agent.get(`/api/invoices?locationId=${loc.id}`).expect(200);
    expect(list.body.map((i: { id: string }) => i.id)).toEqual([mine.body.id]);
    await agent.get(`/api/invoices/${theirs.body.id}`).expect(403);
    await agent.get(`/api/invoices/${mine.body.id}`).expect(200);
    await agent.post('/api/invoices').send({ memberId: basic.member.id, items: [item('Free money', 0)] }).expect(403);
  });
});

describe('monthly invoice generation', () => {
  it('bills plan fees plus unbilled bookings, once per member per month', async () => {
    const { app, db, loc, room, pro, basic, member } = await setup();
    const month = todayIn(TZ).slice(0, 7);
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const staff = await login(app, 'desk@test.dev');

    const paidBooking = await db
      .insert(bookings)
      .values({
        locationId: loc.id,
        resourceId: room.id,
        memberId: basic.member.id,
        startsAt: twoHoursAgo,
        endsAt: oneHourAgo,
        priceCents: 6_000,
        billableMinutes: 60,
        createdById: basic.user.id,
      })
      .returning()
      .get();
    const freeBooking = await db
      .insert(bookings)
      .values({
        locationId: loc.id,
        resourceId: room.id,
        memberId: pro.member.id,
        startsAt: twoHoursAgo,
        endsAt: oneHourAgo,
        priceCents: 0,
        createdById: pro.user.id,
      })
      .returning()
      .get();
    // A member with no plan and no billable activity gets nothing.
    await member('idle@test.dev', null);

    const manager = await login(app, 'manager@test.dev');
    const res = await manager.post('/api/invoices/generate').send({ locationId: loc.id, month }).expect(201);
    expect(res.body.created).toBe(2);
    expect(res.body.skipped).toBe(1);

    const list = (await staff.get(`/api/invoices?locationId=${loc.id}`).expect(200)).body as {
      memberId: string;
      subtotalCents: number;
      totalCents: number;
      kind: string;
      id: string;
    }[];
    const basicInv = list.find((i) => i.memberId === basic.member.id)!;
    const proInv = list.find((i) => i.memberId === pro.member.id)!;
    expect(proInv.subtotalCents).toBe(20_000);
    expect(basicInv.subtotalCents).toBe(5_000 + 6_000);
    expect(basicInv.totalCents).toBe(12_100); // 10% tax
    expect(basicInv.kind).toBe('subscription');

    const detail = await staff.get(`/api/invoices/${basicInv.id}`).expect(200);
    expect(detail.body.items).toHaveLength(2);
    expect((await db.select().from(bookings).where(eq(bookings.id, paidBooking.id)).get())!.invoiceId).toBe(basicInv.id);
    expect((await db.select().from(bookings).where(eq(bookings.id, freeBooking.id)).get())!.invoiceId).toBeNull();

    // Re-running creates nothing new.
    const again = await manager.post('/api/invoices/generate').send({ locationId: loc.id, month }).expect(201);
    expect(again.body.created).toBe(0);
    expect(again.body.skipped).toBe(3);

    // Voiding frees the month so it can be regenerated.
    await manager.post(`/api/invoices/${basicInv.id}/void`).expect(200);
    const regen = await manager.post('/api/invoices/generate').send({ locationId: loc.id, month }).expect(201);
    expect(regen.body.created).toBe(1);
    expect((await db.select().from(invoices).all()).filter((i) => i.memberId === basic.member.id)).toHaveLength(2);
  });

  it('skips paused members, cancelled members, and members who start after the month', async () => {
    const { db, loc, basicPlan, member } = await setup();
    const month = todayIn(TZ).slice(0, 7);
    const paused = await member('paused@test.dev', basicPlan.id);
    const cancelled = await member('cancelled@test.dev', basicPlan.id);
    const future = await member('future@test.dev', basicPlan.id);
    await db.update(members).set({ status: 'paused' }).where(eq(members.id, paused.member.id)).run();
    await db.update(members).set({ status: 'cancelled' }).where(eq(members.id, cancelled.member.id)).run();
    await db.update(members).set({ startDate: addDays(todayIn(TZ), 60) }).where(eq(members.id, future.member.id)).run();

    const { created } = await generateSubscriptionInvoices(db, { locationId: loc.id, month, dueInDays: 7 });
    const billed = new Set(created.map((i) => i.memberId));
    // Only the two seeded active plan members (pro, basic) are billed.
    expect(created).toHaveLength(2);
    for (const m of [paused, cancelled, future]) expect(billed.has(m.member.id)).toBe(false);
  });
});
