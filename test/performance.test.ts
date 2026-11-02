import { describe, expect, it } from 'vitest';
import { resources } from '../src/db/schema.js';
import { inDays, login, setup } from './helpers.js';

/**
 * The database is across the internet, so every statement is a round trip of tens or hundreds of milliseconds. What slows the
 * app down is how many statements a request makes, so these tests count them.
 */
function countStatements(db: Awaited<ReturnType<typeof setup>>['db']) {
  const client = db.$client as unknown as {
    execute: (...a: unknown[]) => Promise<unknown>;
    batch: (...a: unknown[]) => Promise<unknown>;
    transaction: (...a: unknown[]) => Promise<{ execute: (...a: unknown[]) => Promise<unknown> }>;
  };
  let n = 0;
  const execute = client.execute.bind(client);
  const batch = client.batch.bind(client);
  const transaction = client.transaction.bind(client);
  client.execute = (...a) => (n++, execute(...a));
  client.batch = (...a) => (n++, batch(...a));
  client.transaction = async (...a) => {
    const tx = await transaction(...a);
    const inner = tx.execute.bind(tx);
    tx.execute = (...b) => (n++, inner(...b));
    return tx;
  };
  return () => n;
}

async function planWithShifts(ctx: Awaited<ReturnType<typeof setup>>) {
  const owner = await login(ctx.app, 'owner@test.dev');
  const plan = (await owner.post('/api/plans').send({ locationId: ctx.loc.id, name: 'Hot Desk', interval: 'month' }).expect(201)).body;
  const extra = await ctx.db.insert(resources).values({ locationId: ctx.loc.id, kind: 'hot_desk', name: 'Desk 3' }).returning().get();
  const desks = [ctx.desk, ctx.desk2, extra];
  const shift = async (name: string, startTime: string, endTime: string, priceCents: number) =>
    (await owner.post('/api/shifts').send({ locationId: ctx.loc.id, planId: plan.id, name, startTime, endTime, priceCents, spaceIds: desks.map((d) => d.id) }).expect(201)).body;
  return { owner, plan, desks, morning: await shift('Morning', '09:00', '12:00', 500_000), evening: await shift('Evening', '16:00', '20:00', 400_000) };
}

describe('how many database round trips a request makes', () => {
  it('adds a member with two shifts on three desks for a month in a handful of statements, not hundreds', async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    const used = countStatements(ctx.db);
    await p.owner
      .post('/api/members')
      .send({ locationId: ctx.loc.id, name: 'New Person', email: 'new@x.dev', planId: p.plan.id, status: 'active', startDate: inDays(1), shiftIds: [p.morning.id, p.evening.id], deskIds: p.desks.map((d) => d.id) })
      .expect(201);
    // About 60 bookings are made (3 desks x 2 shifts x ~26 open days is over 150); one insert each used to cost a round trip each.
    console.log('add member statements', used());
    expect(used()).toBeLessThan(80);
  });

  it('does not make more statements for a longer period', async () => {
    const ctx = await setup();
    const p = await planWithShifts(ctx);
    const body = (email: string) => ({ locationId: ctx.loc.id, name: email, email, planId: p.plan.id, status: 'active', startDate: inDays(1), shiftIds: [p.morning.id], deskIds: [p.desks[2]!.id] });
    const used = countStatements(ctx.db);
    await p.owner.post('/api/members').send(body('a@x.dev')).expect(201);
    const one = used();
    // The same again with two more shifts and desks: more rows, but not many more statements.
    const before = used();
    await p.owner.post('/api/members').send({ ...body('b@x.dev'), shiftIds: [p.morning.id, p.evening.id], deskIds: [p.desks[0]!.id, p.desks[1]!.id] }).expect(201);
    console.log('second member', used() - before, 'first', one);
    expect(used() - before).toBeLessThan(one + 20);
  });

  it('signs a request in with a couple of statements', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const used = countStatements(ctx.db);
    await owner.get('/api/auth/me').expect(200);
    console.log('me statements', used());
    expect(used()).toBeLessThanOrEqual(6);
  });
});
