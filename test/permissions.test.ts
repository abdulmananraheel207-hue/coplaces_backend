import { describe, expect, it } from 'vitest';
import { PERMISSION_KEYS } from '../src/lib/permissions.js';
import { login, setupOpen as setup, tomorrow } from './helpers.js';

/** An owner makes a team member with exactly these permissions and signs in as them. */
async function teamMember(ctx: Awaited<ReturnType<typeof setup>>, permissions: string[], email = 'tm@test.dev') {
  const owner = await login(ctx.app, 'owner@test.dev');
  const made = await owner.post('/api/staff').send({ name: 'Team Mate', email, permissions, locationIds: [ctx.loc.id], password: 'password123' }).expect(201);
  return { owner, id: made.body.id as string, agent: await login(ctx.app, email) };
}

describe('team permissions', () => {
  it('lists everything that can be granted, to the owner only', async () => {
    const ctx = await setup();
    const owner = await login(ctx.app, 'owner@test.dev');
    const list = (await owner.get('/api/staff/permissions').expect(200)).body as { key: string; label: string; group: string }[];
    expect(list.map((p) => p.key)).toEqual(PERMISSION_KEYS);
    expect(list.every((p) => p.label && p.group)).toBe(true);
    await (await login(ctx.app, 'manager@test.dev')).get('/api/staff/permissions').expect(403);
  });

  it('gives a team member only what the owner ticked', async () => {
    const ctx = await setup();
    const { agent } = await teamMember(ctx, ['bookings', 'members']);
    const me = (await agent.get('/api/auth/me').expect(200)).body;
    expect(me.user.permissions).toEqual(['bookings', 'members']);

    // allowed
    await agent.get(`/api/members?locationId=${ctx.loc.id}`).expect(200);
    await agent.post('/api/bookings').send({ resourceId: ctx.room.id, memberId: ctx.pro.member.id, date: tomorrow(), startTime: '10:00', endTime: '11:00' }).expect(201);
    // not allowed: they were not given these
    await agent.post('/api/attendance/check-in').send({ memberId: ctx.pro.member.id }).expect(403);
    await agent.post('/api/visitors').send({ hostMemberId: ctx.pro.member.id, name: 'Guest' }).expect(403);
    await agent.get(`/api/invoices?locationId=${ctx.loc.id}`).expect(403);
    await agent.post('/api/plans').send({ locationId: ctx.loc.id, name: 'X', priceCents: 100 }).expect(403);
    await agent.post('/api/contracts').send({ locationId: ctx.loc.id, memberId: ctx.pro.member.id, startDate: tomorrow() }).expect(403);
    await agent.post('/api/announcements').send({ locationId: ctx.loc.id, title: 'Hi' }).expect(403);
    await agent.post(`/api/locations/${ctx.loc.id}/holidays`).send({ date: tomorrow() }).expect(403);
    await agent.post('/api/expenses').send({ locationId: ctx.loc.id, category: 'rent', amountCents: 100 }).expect(403);
    await agent.get(`/api/reports/finance?locationId=${ctx.loc.id}`).expect(403);
    await agent.post('/api/resources').send({ locationId: ctx.loc.id, kind: 'room', name: 'New', capacity: 2 }).expect(403);
  });

  it('lets someone with only the front desk permission check people in, but not edit members', async () => {
    const ctx = await setup();
    const { agent } = await teamMember(ctx, ['front_desk']);
    await agent.get(`/api/members?locationId=${ctx.loc.id}`).expect(200); // needed to pick who is arriving
    await agent.post('/api/attendance/check-in').send({ memberId: ctx.pro.member.id }).expect(201);
    await agent.post('/api/members').send({ locationId: ctx.loc.id, name: 'N', email: 'n@test.dev' }).expect(403);
    await agent.patch(`/api/members/${ctx.pro.member.id}`).send({ notes: 'x' }).expect(403);
    await agent.post('/api/bookings').send({ resourceId: ctx.room.id, memberId: ctx.pro.member.id, date: tomorrow(), startTime: '10:00', endTime: '11:00' }).expect(403);
  });

  it('separates seeing invoices from controlling billing', async () => {
    const ctx = await setup();
    const { agent: viewer } = await teamMember(ctx, ['invoices'], 'viewer@test.dev');
    await viewer.get(`/api/invoices?locationId=${ctx.loc.id}`).expect(200);
    await viewer.post('/api/invoices/generate').send({ locationId: ctx.loc.id, month: tomorrow().slice(0, 7) }).expect(403);

    const { agent: admin } = await teamMember(ctx, ['billing_admin'], 'billing@test.dev');
    await admin.get(`/api/invoices?locationId=${ctx.loc.id}`).expect(403);
    const gen = await admin.post('/api/invoices/generate').send({ locationId: ctx.loc.id, month: tomorrow().slice(0, 7) });
    expect(gen.status).not.toBe(403);
  });

  it('full access means every permission', async () => {
    const ctx = await setup();
    const { agent } = await teamMember(ctx, [...PERMISSION_KEYS]);
    await agent.post('/api/expenses').send({ locationId: ctx.loc.id, category: 'rent', amountCents: 100 }).expect(201);
    await agent.get(`/api/reports/finance?locationId=${ctx.loc.id}`).expect(200);
    await agent.post('/api/plans').send({ locationId: ctx.loc.id, name: 'Gold', priceCents: 100 }).expect(201);
    await agent.post('/api/announcements').send({ locationId: ctx.loc.id, title: 'Hello' }).expect(201);
    // but never the owner's own controls
    await agent.get('/api/staff').expect(403);
    await agent.patch(`/api/locations/${ctx.loc.id}`).send({ name: 'Renamed' }).expect(403);
  });

  it('changes take effect on the next request, and unknown permissions are refused', async () => {
    const ctx = await setup();
    const { owner, id, agent } = await teamMember(ctx, ['members']);
    await agent.post('/api/plans').send({ locationId: ctx.loc.id, name: 'Gold', priceCents: 100 }).expect(403);
    await owner.patch(`/api/staff/${id}`).send({ permissions: ['members', 'plans'] }).expect(200);
    await agent.post('/api/plans').send({ locationId: ctx.loc.id, name: 'Gold', priceCents: 100 }).expect(201);
    await owner.patch(`/api/staff/${id}`).send({ permissions: [] }).expect(200);
    await agent.get(`/api/members?locationId=${ctx.loc.id}`).expect(403);
    await owner.patch(`/api/staff/${id}`).send({ permissions: ['everything'] }).expect(400);
    await owner.post('/api/staff').send({ name: 'Z', email: 'z@test.dev', permissions: ['root'], locationIds: [ctx.loc.id] }).expect(400);
  });

  it('keeps the old roles working, and the owner always has everything', async () => {
    const ctx = await setup();
    const manager = (await (await login(ctx.app, 'manager@test.dev')).get('/api/auth/me')).body.user;
    expect(manager.permissions).toEqual(PERMISSION_KEYS);
    const desk = (await (await login(ctx.app, 'desk@test.dev')).get('/api/auth/me')).body.user;
    expect(desk.permissions).toEqual(['front_desk', 'bookings', 'members', 'invoices']);
    const owner = (await (await login(ctx.app, 'owner@test.dev')).get('/api/auth/me')).body.user;
    expect(owner.permissions).toEqual(PERMISSION_KEYS);

    // the old API shape still makes a team member with the matching permissions
    const o = await login(ctx.app, 'owner@test.dev');
    const made = await o.post('/api/staff').send({ name: 'Old Style', email: 'old@test.dev', role: 'manager', locationIds: [ctx.loc.id] }).expect(201);
    expect(made.body.permissions).toEqual(PERMISSION_KEYS);

    // the owner's own permissions cannot be edited
    const staff = (await o.get('/api/staff')).body as { id: string; role: string }[];
    const ownerRow = staff.find((s) => s.role === 'owner')!;
    await o.patch(`/api/staff/${ownerRow.id}`).send({ permissions: [] }).expect(400);
  });

  it('turning a legacy manager into a custom list replaces what the role gave them', async () => {
    const ctx = await setup();
    const o = await login(ctx.app, 'owner@test.dev');
    const staff = (await o.get('/api/staff')).body as { id: string; email: string }[];
    const mgr = staff.find((s) => s.email === 'manager@test.dev')!;
    const agent = await login(ctx.app, 'manager@test.dev');
    await agent.post('/api/plans').send({ locationId: ctx.loc.id, name: 'Gold', priceCents: 100 }).expect(201);
    const changed = await o.patch(`/api/staff/${mgr.id}`).send({ permissions: ['bookings'] }).expect(200);
    expect(changed.body).toMatchObject({ role: 'staff', permissions: ['bookings'] });
    await agent.post('/api/plans').send({ locationId: ctx.loc.id, name: 'Silver', priceCents: 100 }).expect(403);
  });

  it('never gives a member or another tenant any team permission', async () => {
    const ctx = await setup();
    const member = await login(ctx.app, 'pro@test.dev');
    expect((await member.get('/api/auth/me')).body.user.permissions).toEqual([]);
    await member.get(`/api/members?locationId=${ctx.loc.id}`).expect(403);
    await member.get(`/api/invoices?locationId=${ctx.loc.id}`).expect(200); // their own invoices
    const hive = await login(ctx.app, 'owner@hive.dev');
    await hive.patch('/api/staff/' + ctx.pro.user.id).send({ permissions: ['members'] }).expect(403); // their package has no team accounts, and the account is not theirs anyway
  });
});
