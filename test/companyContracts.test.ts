import { eq } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { resources } from '../src/db/schema.js';
import { addDays, todayIn } from '../src/lib/time.js';
import { PASSWORD, inDays, login, setup, TZ } from './helpers.js';

const today = () => todayIn(TZ);
const emp = (n: string, extra: Record<string, unknown> = {}) => ({ name: `Emp ${n}`, email: `${n.toLowerCase()}@acme.dev`, phone: '0300', password: 'password123', deskResourceId: null, ...extra });

/** Acme: six people, a room for five. Prices are 10k each and 5k for a squeezed-in extra person, in cents. */
async function acme(ctx: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown> = {}) {
  await ctx.db.update(resources).set({ capacity: 5 }).where(eq(resources.id, ctx.room.id)).run();
  const owner = await login(ctx.app, 'owner@test.dev');
  const res = await owner
    .post('/api/contracts/company')
    .send({
      locationId: ctx.loc.id,
      companyName: 'Acme Ltd',
      companyEmail: 'hello@acme.dev',
      companyPhone: '021',
      startDate: today(),
      endDate: inDays(90),
      pricingMode: 'per_member',
      pricePerMemberCents: 1_000_000,
      extraMemberCents: 500_000,
      fixedPriceCents: 0,
      spaceIds: [ctx.room.id],
      people: ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => emp(n)),
      ...over,
    });
  return { owner, res };
}

describe('company contracts', () => {
  it('prices six people in a room for five at the normal price for five and the extra price for the sixth', async () => {
    const ctx = await setup();
    const { res } = await acme(ctx);
    expect(res.status).toBe(201);
    expect(res.body.rentCents).toBe(5_500_000);
    expect(res.body.status).toBe('draft');
  });

  it('keeps employees switched off until the contract starts, then lets them in', async () => {
    const ctx = await setup();
    const { owner, res } = await acme(ctx);
    await request(ctx.app).post('/api/auth/login').send({ email: 'a@acme.dev', password: PASSWORD }).expect(401);
    await owner.post(`/api/contracts/${res.body.id}/activate`).expect(200);
    const emp = await login(ctx.app, 'f@acme.dev');
    expect((await emp.get('/api/auth/me').expect(200)).body.user.role).toBe('member');

    const list = (await owner.get(`/api/contracts?locationId=${ctx.loc.id}`).expect(200)).body.find((c: { id: string }) => c.id === res.body.id);
    expect(list).toMatchObject({ companyName: 'Acme Ltd', seats: 5, extraPeople: 1, status: 'active' });
    expect(list.people).toHaveLength(6);
    expect(list.people.every((p: { leaveDate: string | null }) => !p.leaveDate)).toBe(true);
  });

  it('marks members that came in through a contract, in the list and on their page', async () => {
    const ctx = await setup();
    const { owner, res } = await acme(ctx);
    await owner.post(`/api/contracts/${res.body.id}/activate`).expect(200);
    const list = (await owner.get(`/api/members?locationId=${ctx.loc.id}`).expect(200)).body;
    expect(list.find((m: { email: string }) => m.email === 'a@acme.dev').contractCompany).toBe('Acme Ltd');
    expect(list.find((m: { email: string }) => m.email === 'pro@test.dev').contractCompany).toBeNull();
    const a = list.find((m: { email: string }) => m.email === 'a@acme.dev');
    expect((await owner.get(`/api/members/${a.id}`).expect(200)).body.contractCompany).toBe('Acme Ltd');
  });

  it('lets anyone on the contract book the company room, and nobody else', async () => {
    const ctx = await setup();
    const { owner, res } = await acme(ctx);
    await owner.post(`/api/contracts/${res.body.id}/activate`).expect(200);
    const book = (who: Awaited<ReturnType<typeof login>>, memberId: string) =>
      who.post('/api/bookings').send({ resourceId: ctx.room.id, memberId, date: inDays(2), startTime: '10:00', endTime: '11:00' });
    const list = (await owner.get(`/api/contracts?locationId=${ctx.loc.id}`)).body[0];
    const f = list.people.find((p: { email: string }) => p.email === 'f@acme.dev');
    await book(await login(ctx.app, 'f@acme.dev'), f.memberId).expect(201);
    await book(await login(ctx.app, 'pro@test.dev'), ctx.pro.member.id).expect(409);
  });

  it('gives a person their own free desk, and refuses a desk someone else already holds', async () => {
    const ctx = await setup();
    const { owner, res } = await acme(ctx, { people: [emp('A'), emp('B', { deskResourceId: ctx.desk.id })] });
    expect(res.status).toBe(201);
    expect(res.body.rentCents).toBe(2_000_000); // one shares, one has a desk: both pay the normal price
    await owner.post(`/api/contracts/${res.body.id}/activate`).expect(200);
    // that desk is now spoken for
    const second = await acme(ctx, { companyName: 'Other', people: [emp('X', { deskResourceId: ctx.desk.id }), emp('Y')] });
    expect(second.res.status).toBe(201);
    await second.owner.post(`/api/contracts/${second.res.body.id}/activate`).expect(409);
    // and shows as taken when the wizard asks what is free
    const free = (await owner.get(`/api/contracts/available-spaces?locationId=${ctx.loc.id}&startDate=${today()}&endDate=${inDays(30)}`).expect(200)).body;
    expect(free.find((s: { id: string }) => s.id === ctx.desk.id)).toMatchObject({ free: false });
    expect(free.find((s: { id: string }) => s.id === ctx.desk2.id)).toMatchObject({ free: true });
  });

  it('refuses people with no seat, duplicate emails, anyone already a user, and non-desks as desks', async () => {
    const ctx = await setup();
    expect((await acme(ctx, { spaceIds: [] })).res.status).toBe(400); // sharers but nowhere to share
    expect((await acme(ctx, { people: [emp('A'), emp('A')] })).res.status).toBe(400);
    expect((await acme(ctx, { people: [emp('A', { email: 'pro@test.dev' })] })).res.status).toBe(409);
    expect((await acme(ctx, { people: [emp('A', { deskResourceId: ctx.room.id })] })).res.status).toBe(400);
    expect((await acme(ctx, { people: [{ ...emp('A'), password: 'short' }] })).res.status).toBe(400);
    expect((await acme(ctx, { endDate: inDays(-3) })).res.status).toBe(400);
  });

  it('adds and removes people while running, and the price follows', async () => {
    const ctx = await setup();
    const { owner, res } = await acme(ctx);
    await owner.post(`/api/contracts/${res.body.id}/activate`).expect(200);
    const g = await owner.post(`/api/contracts/${res.body.id}/people`).send(emp('G')).expect(201);
    expect((await owner.get(`/api/contracts?locationId=${ctx.loc.id}`)).body[0].rentCents).toBe(6_000_000); // two extras now
    await login(ctx.app, 'g@acme.dev');

    const before = (await owner.get(`/api/contracts?locationId=${ctx.loc.id}`)).body[0];
    await owner.post(`/api/contracts/${res.body.id}/people/${g.body.id}/leave`).send({}).expect(204);
    await request(ctx.app).post('/api/auth/login').send({ email: 'g@acme.dev', password: PASSWORD }).expect(401);
    const after = (await owner.get(`/api/contracts?locationId=${ctx.loc.id}`)).body[0];
    expect(before.rentCents).toBe(6_000_000);
    expect(after.rentCents).toBe(5_500_000);

    // the contact can leave too: invoices move to someone else
    const a = after.people.find((p: { email: string }) => p.email === 'a@acme.dev');
    await owner.post(`/api/contracts/${res.body.id}/people/${a.id}/leave`).send({}).expect(204);
    expect((await owner.get(`/api/contracts?locationId=${ctx.loc.id}`)).body[0].memberId).not.toBe(a.memberId);
  });

  it('bills the company once for the month: rent by person, extra person marked, plus every employee booking', async () => {
    const ctx = await setup();
    const { owner, res } = await acme(ctx, { startDate: inDays(-40), endDate: inDays(200) });
    await owner.post(`/api/contracts/${res.body.id}/activate`).expect(200);
    const month = addDays(today(), -35).slice(0, 7); // a past full month
    const gen = await owner.post('/api/invoices/generate').send({ locationId: ctx.loc.id, month }).expect(201);
    const company = gen.body.invoices.filter((i: { memberId: string }) => i.memberId === res.body.memberId);
    expect(company).toHaveLength(1);
    const detail = (await owner.get(`/api/invoices/${company[0].id}`).expect(200)).body;
    const items: { description: string; amountCents: number }[] = detail.items;
    expect(items.some((i) => i.description.includes('extra person'))).toBe(true);
    // none of the other employees is billed on their own
    const list = (await owner.get(`/api/contracts?locationId=${ctx.loc.id}`)).body[0];
    const others = list.people.map((p: { memberId: string }) => p.memberId).filter((m: string) => m !== res.body.memberId);
    expect(gen.body.invoices.filter((i: { memberId: string }) => others.includes(i.memberId))).toHaveLength(0);
    // running it again does not bill the company twice
    const again = await owner.post('/api/invoices/generate').send({ locationId: ctx.loc.id, month }).expect(201);
    expect(again.body.invoices.filter((i: { memberId: string }) => i.memberId === res.body.memberId)).toHaveLength(0);
  });

  it('ends the contract: logins off, spaces free again', async () => {
    const ctx = await setup();
    const { owner, res } = await acme(ctx);
    await owner.post(`/api/contracts/${res.body.id}/activate`).expect(200);
    await owner.post(`/api/contracts/${res.body.id}/end`).send({}).expect(200);
    await request(ctx.app).post('/api/auth/login').send({ email: 'a@acme.dev', password: PASSWORD }).expect(401);
    const free = (await owner.get(`/api/contracts/available-spaces?locationId=${ctx.loc.id}&startDate=${today()}&endDate=${inDays(30)}`)).body;
    expect(free.find((s: { id: string }) => s.id === ctx.room.id).free).toBe(true);
  });

  it('extends the end date unless someone else has the space by then', async () => {
    const ctx = await setup();
    const { owner, res } = await acme(ctx);
    await owner.post(`/api/contracts/${res.body.id}/activate`).expect(200);
    await owner.post(`/api/contracts/${res.body.id}/extend`).send({ endDate: inDays(60) }).expect(400); // earlier than now
    const ok = await owner.post(`/api/contracts/${res.body.id}/extend`).send({ endDate: inDays(120) }).expect(200);
    expect(ok.body.endDate).toBe(inDays(120));
    // another contract takes the room from day 130, so the company cannot stretch past it
    const next = await owner.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.pro.member.id, resourceId: ctx.room.id, startDate: inDays(130) }).expect(201);
    await owner.post(`/api/contracts/${next.body.id}/activate`).expect(200);
    await owner.post(`/api/contracts/${res.body.id}/extend`).send({ endDate: inDays(140) }).expect(409);
  });

  it('discarding a draft frees the emails, and a draft can be edited', async () => {
    const ctx = await setup();
    const { owner, res } = await acme(ctx);
    const edited = await owner.patch(`/api/contracts/${res.body.id}/company`).send({ pricePerMemberCents: 2_000_000 }).expect(200);
    expect(edited.body.pricePerMemberCents).toBe(2_000_000);
    expect((await owner.get(`/api/contracts?locationId=${ctx.loc.id}`)).body[0].rentCents).toBe(2_000_000 * 5 + 500_000);
    await owner.post(`/api/contracts/${res.body.id}/cancel`).expect(200);
    expect((await owner.get(`/api/contracts?locationId=${ctx.loc.id}`)).body).toHaveLength(0);
    expect((await acme(ctx)).res.status).toBe(201); // same emails again
  });

  it('quotes the monthly price for the wizard', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const q = await owner
      .post('/api/contracts/quote')
      .send({ locationId: ctx.loc.id, pricingMode: 'per_member', pricePerMemberCents: 1_000_000, extraMemberCents: 500_000, fixedPriceCents: 0, spaceIds: [ctx.room.id], people: [{ hasDesk: false }, { hasDesk: false }] })
      .expect(200);
    expect(q.body).toMatchObject({ seats: 8, totalCents: 2_000_000, extraPeople: 0 });
  });

  it('keeps one location from touching another', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    await owner.post('/api/contracts/company').send({ locationId: ctx.locB.id, companyName: 'X', startDate: today(), pricingMode: 'per_member', pricePerMemberCents: 1, extraMemberCents: 1, fixedPriceCents: 0, people: [emp('Z')], spaceIds: [] }).expect(403);
  });
});
