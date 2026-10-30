import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createDb, type Db } from '../src/db/client.js';
import { bookings, locations, members, organizations, packages, plans, resources, userLocations, users } from '../src/db/schema.js';
import { FEATURE_KEYS } from '../src/features.js';
import { addDays, todayIn, zonedToUtc } from '../src/lib/time.js';

export const PASSWORD = 'password123';
const hash = bcrypt.hashSync(PASSWORD, 4);

export const TZ = 'America/New_York';

/**
 * Two tenants. "Nest" (org A) has every feature and two locations; "Hive" (org B) is on a small
 * package with no optional features and tight limits. Emails ending in @test.dev belong to A,
 * @hive.dev to B.
 */
export async function setup() {
  const db = await createDb(':memory:');
  const app = createApp(db, { webDist: '/nonexistent' });

  const fullPackage = await db
    .insert(packages)
    .values({ name: 'Full', priceCents: 4_500_000, features: JSON.stringify(FEATURE_KEYS) })
    .returning()
    .get();
  const starterPackage = await db
    .insert(packages)
    .values({ name: 'Starter', priceCents: 750_000, features: '[]', maxLocations: 1, maxMembers: 2 })
    .returning()
    .get();

  const farFuture = addDays(todayIn(TZ), 90);
  const org = await db
    .insert(organizations)
    .values({ name: 'Nest', packageId: fullPackage.id, status: 'active', periodEnd: farFuture })
    .returning()
    .get();
  const orgB = await db
    .insert(organizations)
    .values({ name: 'Hive', packageId: starterPackage.id, status: 'active', periodEnd: farFuture })
    .returning()
    .get();

  const loc = await db
    .insert(locations)
    .values({ organizationId: org.id, name: 'Downtown', code: 'DTN', timezone: TZ, openTime: '08:00', closeTime: '20:00', taxRateBps: 1000 })
    .returning()
    .get();
  const other = await db
    .insert(locations)
    .values({ organizationId: org.id, name: 'Uptown', code: 'UPT', timezone: TZ, openTime: '08:00', closeTime: '20:00' })
    .returning()
    .get();
  const locB = await db
    .insert(locations)
    .values({ organizationId: orgB.id, name: 'Hive Central', code: 'DTN', timezone: TZ, openTime: '08:00', closeTime: '20:00' })
    .returning()
    .get();

  const user = (email: string, role: 'superadmin' | 'owner' | 'manager' | 'staff' | 'member', name = email, organizationId: string | null = org.id) =>
    db.insert(users).values({ email, name, role, passwordHash: hash, organizationId }).returning().get();

  await user('root@platform.dev', 'superadmin', 'root', null);
  await user('owner@test.dev', 'owner');
  const manager = await user('manager@test.dev', 'manager');
  const frontdesk = await user('desk@test.dev', 'staff');
  const otherStaff = await user('uptown@test.dev', 'staff');
  for (const [u, l] of [
    [manager, loc],
    [frontdesk, loc],
    [otherStaff, other],
  ] as const) {
    await db.insert(userLocations).values({ userId: u.id, locationId: l.id }).run();
  }
  await user('owner@hive.dev', 'owner', 'owner@hive.dev', orgB.id);

  const proPlan = await db
    .insert(plans)
    .values({ locationId: loc.id, name: 'Pro', priceCents: 20_000, includedMeetingMinutes: 60, includesHotDesk: true })
    .returning()
    .get();
  const basicPlan = await db
    .insert(plans)
    .values({ locationId: loc.id, name: 'Basic', priceCents: 5_000 })
    .returning()
    .get();

  const room = await db
    .insert(resources)
    .values({ locationId: loc.id, kind: 'room', name: 'Boardroom', capacity: 8, hourlyRateCents: 6_000 })
    .returning()
    .get();
  const desk = await db
    .insert(resources)
    .values({ locationId: loc.id, kind: 'hot_desk', name: 'Desk 1', dailyRateCents: 2_500 })
    .returning()
    .get();
  const desk2 = await db
    .insert(resources)
    .values({ locationId: loc.id, kind: 'hot_desk', name: 'Desk 2', dailyRateCents: 2_500 })
    .returning()
    .get();
  const dedicated = await db
    .insert(resources)
    .values({ locationId: loc.id, kind: 'dedicated_desk', name: 'Desk D1' })
    .returning()
    .get();

  const member = async (email: string, planId: string | null, location = loc, organizationId = org.id) => {
    const u = await user(email, 'member', email.split('@')[0], organizationId);
    const m = await db
      .insert(members)
      .values({ userId: u.id, locationId: location.id, planId, startDate: todayIn(TZ) })
      .returning()
      .get();
    return { user: u, member: m };
  };
  const pro = await member('pro@test.dev', proPlan.id);
  const basic = await member('basic@test.dev', basicPlan.id);
  const hiveMember = await member('member@hive.dev', null, locB, orgB.id);

  return { db, app, org, orgB, loc, other, locB, fullPackage, starterPackage, proPlan, basicPlan, room, desk, desk2, dedicated, pro, basic, hiveMember, member };
}

export type Ctx = Awaited<ReturnType<typeof setup>>;

export async function login(app: ReturnType<typeof createApp>, email: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
  return agent;
}

export const tomorrow = () => addDays(todayIn(TZ), 1);
export const inDays = (n: number) => addDays(todayIn(TZ), n);
export type { Db };

/** The same two tenants, with the building open all day, for tests that check people in at whatever time the tests run. */
export async function setupOpen() {
  const ctx = await setup();
  await ctx.db.update(locations).set({ openTime: '00:00', closeTime: '23:59' }).where(eq(locations.id, ctx.loc.id)).run();
  return ctx;
}

let spare = 0;
/**
 * Gives a member a reason to be checked in today: a whole-day booking on an office of their own, the way a plan's shift would.
 * Nobody can check in without one, so tests about other rules use this first. The office is not any of the shared test spaces.
 */
export async function entitle(ctx: Ctx, memberId: string, day = todayIn(TZ)) {
  const office = await ctx.db.insert(resources).values({ locationId: ctx.loc.id, kind: 'office', name: `Spare office ${++spare}` }).returning().get();
  const by = (await ctx.db.select().from(users).where(eq(users.email, 'owner@test.dev')).get())!;
  await ctx.db
    .insert(bookings)
    .values({ locationId: ctx.loc.id, resourceId: office.id, memberId, startsAt: zonedToUtc(day, '00:00', TZ).toISOString(), endsAt: zonedToUtc(addDays(day, 1), '00:00', TZ).toISOString(), createdById: by.id, source: 'plan' })
    .run();
}
