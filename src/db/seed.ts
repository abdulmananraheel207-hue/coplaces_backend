import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { loadAuthUser } from '../lib/auth.js';
import { FEATURE_KEYS } from '../features.js';
import { addDays, addMonths, addMonthsToDate, todayIn, zonedToUtc } from '../lib/time.js';
import { createBooking } from '../services/bookings.js';
import { createInvoice, generateSubscriptionInvoices, recordPayment } from '../services/billing.js';
import { createDb, dropAllTables, type Db } from './client.js';
import {
  announcements,
  attendance,
  bookings,
  contracts,
  depositEntries,
  expenses,
  floorObjects,
  invoices,
  issues,
  locationHolidays,
  locations,
  members,
  organizations,
  packages,
  plans,
  platformPayments,
  resourceAssignments,
  resources,
  shiftTemplates,
  spaceAssets,
  spaceTasks,
  userLocations,
  users,
  visitors,
} from './schema.js';

export const DEMO_PASSWORD = 'coplaces123';

// Small deterministic PRNG so the demo data is the same every run.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rupees to the stored minor unit (paisa). */
const pkr = (rupees: number) => Math.round(rupees * 100);

const PEOPLE: [string, string][] = [
  ['Hamza Sheikh', 'Sheikh Analytics'],
  ['Fatima Zahra', 'Zahra Design Studio'],
  ['Ali Raza', 'Raza Software House'],
  ['Maryam Siddiqui', 'Siddiqui & Associates'],
  ['Bilal Chaudhry', 'Chaudhry Digital'],
  ['Hira Aslam', 'Aslam Legal Consultants'],
  ['Usama Farooq', 'Farooq Logistics Tech'],
  ['Sana Javed', 'Javed Translations'],
  ['Ahmed Qureshi', 'Qureshi Fitness Online'],
  ['Noor Fatima', 'Noor Learning Hub'],
  ['Imran Baig', 'Baig Photography'],
  ['Zainab Hussain', 'Hussain Coffee Traders'],
  ['Saad Mirza', 'Mirza Architects'],
  ['Rabia Anwar', 'Anwar Textiles'],
];

/** Like `items.map(fn)`, but one at a time, so rows go in (and the PRNG advances) in the same order every run. */
async function mapSeq<T, R>(items: readonly T[], fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const [i, item] of items.entries()) out.push(await fn(item, i));
  return out;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const emailOf = (name: string) => `${name.toLowerCase().replace(/[^a-z ]/g, '').replace(/ /g, '.')}@example.pk`;

export async function seedDemo(db: Db, now = new Date()) {
  const rand = rng(42);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
  const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  const platformToday = todayIn(config.platformTimezone, now);

  const mkUser = (organizationId: string | null, email: string, name: string, role: 'superadmin' | 'owner' | 'manager' | 'staff' | 'member') =>
    db.insert(users).values({ organizationId, email, name, role, passwordHash: hash }).returning().get();

  // ---- Platform: packages and the super admin -------------------------------
  const pack = (
    name: string,
    description: string,
    interval: 'month' | 'year',
    rupees: number,
    features: readonly string[],
    maxLocations: number | null,
    maxMembers: number | null,
  ) =>
    db
      .insert(packages)
      .values({ name, description, interval, priceCents: pkr(rupees), features: JSON.stringify(features), maxLocations, maxMembers })
      .returning()
      .get();
  const starter = await pack('Starter', 'One location and the essentials: members, spaces, bookings, check-in and visitors.', 'month', 7_500, ['visitors'], 1, 40);
  const growth = await pack(
    'Growth',
    'Adds invoicing, expenses, a member portal and team accounts.',
    'month',
    19_000,
    ['visitors', 'member_portal', 'invoicing', 'expenses', 'team'],
    2,
    200,
  );
  const proMonthly = await pack('Pro', 'Everything, including the 3D floor view, floor plan import and finance reports.', 'month', 45_000, FEATURE_KEYS, 10, null);
  await pack('Pro Yearly', 'Pro, billed once a year with two months free.', 'year', 450_000, FEATURE_KEYS, 10, null);
  await mkUser(null, 'admin@coplaces.test', 'Platform Admin', 'superadmin');

  const mkOrg = (name: string, city: string, pkg: typeof starter, status: 'trial' | 'active' | 'suspended', periodEnd: string, contactEmail: string, notes = '') =>
    db.insert(organizations).values({ name, city, packageId: pkg.id, status, periodEnd, contactEmail, notes }).returning().get();

  /** Past subscription payments, newest ending exactly at the organization's periodEnd. */
  const subscriptionHistory = async (org: typeof organizations.$inferSelect, pkg: typeof starter, recordedById: string, count: number) => {
    for (let k = 0; k < count; k++) {
      const months = pkg.interval === 'year' ? 12 : 1;
      const periodEnd = addMonthsToDate(org.periodEnd, -k * months);
      const periodStart = addMonthsToDate(org.periodEnd, -(k + 1) * months);
      await db.insert(platformPayments)
        .values({
          organizationId: org.id,
          packageId: pkg.id,
          amountCents: pkg.priceCents,
          method: pick(['bank_transfer', 'jazzcash', 'easypaisa', 'bank_transfer']),
          reference: `TXN-${between(100000, 999999)}`,
          periodStart,
          periodEnd,
          paidAt: zonedToUtc(periodStart, '10:30', config.platformTimezone).toISOString(),
          recordedById,
        })
        .run();
    }
  };

  // ---- Tenant 1: Nest Cowork, everything switched on, two locations ----------
  const nest = await mkOrg('Nest Cowork', 'Karachi', proMonthly, 'active', addDays(platformToday, 21), 'hello@nestcowork.pk', 'Founding customer. Prefers WhatsApp for support.');
  const downtown = await db
    .insert(locations)
    .values({
      organizationId: nest.id,
      name: 'Nest Clifton',
      code: 'CLF',
      address: 'Plot 12, Block 5, Clifton, Karachi',
      timezone: 'Asia/Karachi',
      currency: 'PKR',
      openTime: '09:00',
      closeTime: '21:00',
      taxRateBps: 1300,
    })
    .returning()
    .get();
  const riverside = await db
    .insert(locations)
    .values({
      organizationId: nest.id,
      name: 'Nest Gulberg',
      code: 'GLB',
      address: 'Main Boulevard, Gulberg III, Lahore',
      timezone: 'Asia/Karachi',
      currency: 'PKR',
      openTime: '08:00',
      closeTime: '22:00',
      taxRateBps: 1600,
    })
    .returning()
    .get();

  // ---- Staff -------------------------------------------------------------
  const nestOwner = await mkUser(nest.id, 'owner@nest.test', 'Ayesha Khan', 'owner');
  const manager = await mkUser(nest.id, 'manager@nest.test', 'Bilal Ahmed', 'manager');
  const desk = await mkUser(nest.id, 'frontdesk@nest.test', 'Sana Malik', 'staff');
  const rvManager = await mkUser(nest.id, 'gulberg@nest.test', 'Hassan Raza', 'manager');
  for (const [u, l] of [
    [manager, downtown],
    [desk, downtown],
    [rvManager, riverside],
  ] as const) {
    await db.insert(userLocations).values({ userId: u.id, locationId: l.id }).run();
  }
  await subscriptionHistory(nest, proMonthly, (await db.select().from(users).where(eq(users.role, 'superadmin')).get())!.id, 5);

  // ---- Plans -------------------------------------------------------------
  const plan = (locationId: string, name: string, rupees: number, extra: Partial<typeof plans.$inferInsert> = {}) =>
    db.insert(plans).values({ locationId, name, priceCents: pkr(rupees), ...extra }).returning().get();
  await plan(downtown.id, 'Day Pass', 1_500, { interval: 'day', description: 'Pay per day, hot desk access.' });
  const hotPlan = await plan(downtown.id, 'Hot Desk', 18_000, {
    includesHotDesk: true,
    includedMeetingMinutes: 120,
    description: 'Any open desk, any day.',
  });
  const dedPlan = await plan(downtown.id, 'Dedicated Desk', 32_000, {
    includesHotDesk: true,
    includedMeetingMinutes: 600,
    description: 'Your own desk, 24/7 access.',
  });
  const officePlan = await plan(downtown.id, 'Private Office', 120_000, {
    includesHotDesk: true,
    includedMeetingMinutes: 1_200,
    description: 'Lockable office for small teams.',
  });
  const virtualPlan = await plan(downtown.id, 'Virtual Office', 5_000, { description: 'Business address and mail handling.' });
  const rvHot = await plan(riverside.id, 'Hot Desk', 15_000, { includesHotDesk: true, includedMeetingMinutes: 120 });
  const rvDed = await plan(riverside.id, 'Dedicated Desk', 26_000, { includesHotDesk: true, includedMeetingMinutes: 480 });

  // ---- Spaces ------------------------------------------------------------
  const res = (locationId: string, kind: (typeof resources.$inferInsert)['kind'], name: string, extra: Partial<typeof resources.$inferInsert> = {}) =>
    db.insert(resources).values({ locationId, kind, name, ...extra }).returning().get();

  // Nest Clifton has a drawn floor plan. Positions are metres on each floor, sizes are written out so the
  // plan does not depend on how the app sizes things by default. Desks come in pods of four: two facing
  // each way (rot 2 faces away from the viewer), backs together.
  const at = (x: number, z: number, w: number, d: number, rot = 0) => ({ planX: x, planZ: z, planW: w, planD: d, planRot: rot });
  const pod = (k: number, ox: number, oz: number) => at(ox + 0.85 + (k % 2) * 1.8, oz + (k < 2 ? 0.775 : 2.425), 1.58, 1.49, k < 2 ? 2 : 0);
  const object = (floor: string, type: (typeof floorObjects.$inferInsert)['type'], x: number, z: number, w: number, d: number, rot = 0, label = '') =>
    db.insert(floorObjects).values({ locationId: downtown.id, floor, type, x, z, w, d, rot, label }).run();

  const boardroom = await res(downtown.id, 'room', 'Boardroom', { floor: '3', capacity: 12, hourlyRateCents: pkr(4_500), amenities: 'TV screen, Whiteboard, Video-call kit, Air conditioning, Natural light', description: 'Our largest meeting room. A long table for twelve, a wall screen and a camera for calls, and a view over the street.', ...at(8, 2.8, 8.4, 5.6) });
  const focusA = await res(downtown.id, 'room', 'Focus Room A', { floor: '2', capacity: 4, hourlyRateCents: pkr(2_000), offPeakRateCents: pkr(1_200), peakStart: '09:00', peakEnd: '17:00', halfDayRateCents: pkr(6_500), fullDayRateCents: pkr(11_000), amenities: 'TV screen, Whiteboard, Air conditioning', description: 'A quiet room for four. Cheaper in the evening, with a half-day and a day price.', ...at(6, 1.75, 4.4, 3.5) });
  const focusB = await res(downtown.id, 'room', 'Focus Room B', { floor: '2', style: 'huddle', capacity: 4, hourlyRateCents: pkr(1_500), amenities: 'Screen, Soft seating', ...at(10.5, 1.75, 4.4, 3.5) });
  const booth1 = await res(downtown.id, 'room', 'Phone Booth 1', { floor: '1', style: 'phone_booth', capacity: 1, hourlyRateCents: pkr(800), amenities: 'Soundproof', ...at(5, 1.45, 2.9, 2.9) });
  await res(downtown.id, 'room', 'Phone Booth 2', { floor: '1', style: 'phone_booth', capacity: 1, hourlyRateCents: pkr(800), amenities: 'Soundproof', status: 'maintenance', notes: 'Door hinge being repaired', ...at(8.1, 1.45, 2.9, 2.9) });
  const rooms = [boardroom, focusA, focusB, booth1];
  // Corporate rooms: premium rooms for company meetings, training and events, always billed at their own rate.
  await res(downtown.id, 'corporate_room', 'Executive Suite', { floor: '3', style: 'boardroom', capacity: 16, hourlyRateCents: pkr(9_000), amenities: 'Video wall, Catering, Concierge', ...at(17, 3, 9, 6) });
  await res(downtown.id, 'corporate_room', 'Training Hall', { floor: '3', style: 'training_hall', capacity: 30, hourlyRateCents: pkr(12_000), amenities: 'Projector, Stage, PA system', ...at(27, 3.5, 10, 7) });

  // Newer kinds of space: a studio, an interview room, a quiet room, a day office, a team pod, lockers, mailboxes, parking.
  await res(downtown.id, 'room', 'Podcast Studio', { floor: '2', style: 'studio', capacity: 4, hourlyRateCents: pkr(2_500), noPlanRateCents: pkr(3_500), amenities: 'Soundproof, Video-call kit, Power sockets', description: 'Soundproofed, with four microphones and a mixing desk. Bring a laptop and record.', ...at(24, 2.2, 4.4, 3.6) });
  await res(downtown.id, 'room', 'Interview Room', { floor: '2', style: 'interview', capacity: 3, hourlyRateCents: pkr(1_000), amenities: 'Air conditioning, Natural light', ...at(29, 2, 3.4, 2.9) });
  await res(downtown.id, 'room', 'Quiet Room', { floor: '2', style: 'focus', capacity: 1, hourlyRateCents: pkr(900), openTime: '10:00', closeTime: '18:00', amenities: 'Soundproof, Power sockets', description: 'One desk, a door and silence. Open 10:00 to 18:00.', ...at(32.5, 2, 2.9, 2.9) });
  await res(downtown.id, 'hot_desk', 'Day Office 1', { floor: '1', style: 'day_office', capacity: 3, dailyRateCents: pkr(4_500), amenities: 'Power sockets, Air conditioning, Wi-Fi', description: 'A private room for up to three, booked for the day.', ...at(23, 4, 4, 3.2) });
  await res(downtown.id, 'dedicated_desk', 'Team Pod A', { floor: '2', style: 'team_pod', capacity: 4, amenities: 'Power sockets, Monitor', ...at(24, 8, 3.4, 3.2) });
  const lockers = await mapSeq(range(6), (i) => res(downtown.id, 'storage', `Locker ${i + 1}`, { floor: '1', style: 'locker', ...at(14 + i * 1, 12.9, 0.9, 0.9) }));
  const bays = await mapSeq(range(3), (i) => res(downtown.id, 'storage', `Parking Bay ${i + 1}`, { floor: '', style: 'parking', ...at(4 + i * 3, 3, 2.6, 5) }));
  for (let i = 0; i < 4; i++) await res(downtown.id, 'storage', `Mailbox ${i + 1}`, { floor: '1', style: 'mailbox', ...at(21.5 + i * 1, 12.6, 0.9, 0.9) });

  const hotDesks = await mapSeq(range(12), (i) =>
    res(downtown.id, 'hot_desk', `Hot Desk ${i + 1}`, {
      floor: '1',
      style: i >= 10 ? 'standing' : i >= 8 ? 'corner' : 'standard',
      dailyRateCents: pkr(1_500),
      amenities: i >= 10 ? 'Height adjustable, Power' : 'Monitor arm, Power',
      ...pod(i % 4, 1 + Math.floor(i / 4) * 5, 5.5),
    }),
  );
  const dedDesks = await mapSeq(range(8), (i) =>
    res(downtown.id, 'dedicated_desk', `Desk D${i + 1}`, { floor: '2', style: i >= 6 ? 'standing' : 'standard', amenities: 'Locker, Monitor', ...pod(i % 4, 1 + Math.floor(i / 4) * 5.5, 6) }),
  );
  const offices = await mapSeq([
    [3.1, 11.2, 5.4, 4.4],
    [8.9, 11.2, 5.4, 4.4],
    [15.5, 11.2, 7.4, 5],
    [23, 11.2, 7.4, 5],
  ], ([x, z, w, d], i) =>
    res(downtown.id, 'office', `Office ${i + 1}`, { floor: '3', style: i === 2 ? 'executive' : 'standard', capacity: i < 2 ? 4 : 8, amenities: 'Lockable, Window', ...at(x!, z!, w!, d!) }),
  );

  for (const floor of ['1', '2', '3']) await object(floor, 'core', 1.7, 1.5, 3.4, 3);
  await object('1', 'kitchen', 12.4, 1.2, 4, 2.4);
  await object('1', 'coffee_machine', 16, 0.7, 1.2, 0.8, 0, 'Barista bar');
  await object('1', 'plant', 17.8, 0.6, 0.8, 0.8);
  await object('1', 'lounge', 17.8, 7.4, 3.2, 2.4);
  await object('1', 'reception', 8.5, 11.5, 3, 1, 0, 'Front desk');
  await object('1', 'plant', 11.5, 11.5, 0.8, 0.8);
  await object('2', 'kitchen', 16, 1.2, 4, 2.4);
  await object('2', 'coffee_machine', 19.5, 0.7, 1.2, 0.8);
  await object('2', 'lounge', 15.5, 8, 3.2, 2.4);
  await object('2', 'print_station', 12.5, 6.6, 1.2, 0.8, 1);
  await object('3', 'kitchen', 29.5, 11.5, 4, 2.4);
  await object('3', 'coffee_machine', 29.5, 14, 1.2, 0.8);
  await object('3', 'reception', 3, 6.6, 3, 1);
  await object('1', 'washroom_men', 26, 12.4, 2.8, 2.4);
  await object('1', 'washroom_women', 29, 12.4, 2.8, 2.4);
  await object('1', 'washroom_accessible', 31.7, 12.5, 2.2, 2.2);
  await object('1', 'prayer_room', 28.5, 5, 3.2, 2.8);
  await object('1', 'water_dispenser', 20.2, 0.6, 0.5, 0.5);
  await object('1', 'vending_machine', 21.4, 0.7, 1, 0.8);
  await object('1', 'security_desk', 3.5, 11.8, 1.8, 0.8);
  await object('1', 'fire_exit', 35, 7, 1.1, 0.3, 1);
  await object('1', 'extinguisher', 19.6, 3.2, 0.4, 0.4);
  await object('1', 'first_aid', 13.4, 11.9, 0.6, 0.3);
  await object('2', 'pantry', 22, 8.6, 3, 1.8);
  await object('2', 'recreation', 28, 8.4, 3, 1.8);
  await object('2', 'phone_corner', 20.2, 3.2, 1.2, 1.2);
  await object('2', 'library', 33, 7, 2.6, 1);
  await object('2', 'zone', 5.5, 7.7, 11.5, 4.6, 0, 'Quiet zone');
  await db.update(floorObjects).set({ tint: 'blue' }).where(eq(floorObjects.label, 'Quiet zone')).run();
  await object('3', 'server_room', 36, 3, 2.4, 2);
  await object('3', 'storage_room', 36, 6.2, 2.4, 2);
  await object('3', 'mail_room', 33.5, 11.2, 2.4, 1.8);
  await object('', 'terrace', 12, 10.5, 5, 3);
  await res(riverside.id, 'room', 'Minar Room', { floor: '1', capacity: 8, hourlyRateCents: pkr(3_500), amenities: 'Screen, Whiteboard' });
  for (let i = 1; i <= 6; i++) await res(riverside.id, 'hot_desk', `Hot Desk ${i}`, { floor: '1', dailyRateCents: pkr(1_200) });
  for (let i = 1; i <= 4; i++) await res(riverside.id, 'dedicated_desk', `Desk D${i}`, { floor: '1' });

  // ---- Members -----------------------------------------------------------
  const today = todayIn(downtown.timezone, now);
  const thisMonth = today.slice(0, 7);
  const plansForDemo = [hotPlan, dedPlan, officePlan, virtualPlan, hotPlan, dedPlan, hotPlan, hotPlan, dedPlan, dedPlan, virtualPlan, hotPlan, officePlan, dedPlan];
  const memberRows = await mapSeq(PEOPLE, async ([name, company], i) => {
    const u = await mkUser(nest.id, emailOf(name), name, 'member');
    const monthsAgo = i % 4 === 3 ? between(1, 3) : between(6, 16);
    const status = i === 11 ? 'paused' : i === 13 ? 'lead' : 'active';
    const m = await db
      .insert(members)
      .values({
        userId: u.id,
        locationId: downtown.id,
        company,
        planId: status === 'lead' ? null : plansForDemo[i]!.id,
        status,
        startDate: `${addMonths(thisMonth, -monthsAgo)}-${String(between(1, 25)).padStart(2, '0')}`,
        notes: i === 0 ? 'Prefers invoices sent to accounts@sheikhanalytics.pk' : '',
      })
      .returning()
      .get();
    await db.update(users).set({ phone: `+92 300 55501${String(10 + i).padStart(2, '0')}` }).where(eq(users.id, u.id)).run();
    return { user: u, member: m, plan: plansForDemo[i]! };
  });
  const active = memberRows.filter((m) => m.member.status === 'active');

  // Two Gulberg members so the second location is not empty.
  for (const [name, company, p] of [['Mehreen Tahir', 'Tahir Consulting', rvHot], ['Faisal Ghani', 'Ghani Robotics', rvDed]] as const) {
    const u = await mkUser(nest.id, emailOf(name), name, 'member');
    await db.insert(members).values({ userId: u.id, locationId: riverside.id, company, planId: p.id, startDate: `${addMonths(thisMonth, -3)}-05` }).run();
  }

  // Dedicated desks and offices
  const assign = (resourceId: string, memberIndex: number) =>
    db.insert(resourceAssignments).values({ resourceId, memberId: memberRows[memberIndex]!.member.id, startDate: memberRows[memberIndex]!.member.startDate }).returning().get();
  await assign(dedDesks[0]!.id, 1);
  await assign(dedDesks[1]!.id, 5);
  await assign(dedDesks[2]!.id, 8);
  await assign(dedDesks[3]!.id, 9);
  await assign(lockers[0]!.id, 1);
  await assign(lockers[1]!.id, 2);
  await assign(bays[0]!.id, 2);
  const officeLease = await assign(offices[0]!.id, 2);
  await assign(offices[1]!.id, 12);

  // A running contract with its deposit held, a draft waiting to start, a holiday and two announcements.
  const contractBase = { locationId: downtown.id, createdById: nestOwner.id };
  const contractRows = await db
    .insert(contracts)
    .values([
      { ...contractBase, memberId: memberRows[2]!.member.id, resourceId: offices[0]!.id, assignmentId: officeLease.id, startDate: memberRows[2]!.member.startDate, rentCents: 120_000, depositCents: 240_000, depositStatus: 'held', advanceCents: 120_000, advanceReceivedAt: new Date().toISOString(), status: 'active' },
      { ...contractBase, memberId: memberRows[3]!.member.id, resourceId: dedDesks[5]!.id, startDate: addDays(today, 7), rentCents: 35_000, depositCents: 35_000, status: 'draft' },
    ])
    .returning()
    .all();
  await db.insert(depositEntries)
    .values([
      { locationId: downtown.id, contractId: contractRows[0]!.id, kind: 'received', amountCents: 240_000, method: 'bank_transfer', reference: 'Transfer on signing', occurredAt: new Date().toISOString(), recordedById: nestOwner.id },
      { locationId: downtown.id, contractId: contractRows[0]!.id, kind: 'advance', amountCents: 120_000, method: 'bank_transfer', reference: 'First month in advance', occurredAt: new Date().toISOString(), recordedById: nestOwner.id },
    ])
    .run();
  // Time slots people can pick when booking.
  await db.insert(shiftTemplates)
    .values([
      { locationId: downtown.id, name: 'Morning', kind: 'hot_desk', startTime: '09:00', endTime: '13:00', priceCents: pkr(800) },
      { locationId: downtown.id, name: 'Afternoon', kind: 'hot_desk', startTime: '13:00', endTime: '18:00', priceCents: pkr(900) },
      { locationId: downtown.id, name: 'Half day', kind: 'room', startTime: '09:00', endTime: '13:00' },
      { locationId: downtown.id, resourceId: boardroom.id, name: 'Board morning', startTime: '09:00', endTime: '12:00', priceCents: pkr(12_000) },
    ])
    .run();
  // Cleaning and upkeep, a little equipment, and problems reported by members.
  const space = async (name: string) => (await db.select().from(resources).where(eq(resources.name, name)).all()).find((r) => r.locationId === downtown.id)!;
  const due = (n: number) => addDays(today, n);
  await db.insert(spaceTasks)
    .values([
      { locationId: downtown.id, resourceId: (await space('Boardroom')).id, kind: 'cleaning', title: 'Deep clean the boardroom', everyDays: 7, nextDue: due(2) },
      { locationId: downtown.id, resourceId: (await space('Executive Suite')).id, kind: 'maintenance', title: 'Service the air conditioning', everyDays: 30, nextDue: due(-3), notes: 'Replace filters, check the drain.' },
      { locationId: downtown.id, resourceId: null, kind: 'cleaning', title: 'Wipe down all desks and kitchens', everyDays: 1, nextDue: today },
      { locationId: downtown.id, resourceId: null, kind: 'inspection', title: 'Check the fire extinguishers', everyDays: 90, nextDue: due(21) },
      { locationId: downtown.id, resourceId: (await space('Podcast Studio')).id, kind: 'maintenance', title: 'Test microphones and cables', everyDays: 14, nextDue: due(5) },
    ])
    .run();
  await db.insert(spaceAssets)
    .values([
      { locationId: downtown.id, resourceId: (await space('Boardroom')).id, name: 'Wall screen, 75 inch', category: 'AV', serialNumber: 'SMS-75-20481', purchasedOn: due(-400), warrantyUntil: due(330) },
      { locationId: downtown.id, resourceId: (await space('Boardroom')).id, name: 'Conference camera', category: 'AV', serialNumber: 'LGT-C930-7731', purchasedOn: due(-400), warrantyUntil: due(40) },
      { locationId: downtown.id, resourceId: (await space('Training Hall')).id, name: 'Projector', category: 'AV', serialNumber: 'EPS-X49-1190', purchasedOn: due(-900), warrantyUntil: due(-100), status: 'needs_repair', notes: 'Lamp is dim.' },
      { locationId: downtown.id, resourceId: (await space('Podcast Studio')).id, name: 'Microphone set (4)', category: 'AV', serialNumber: 'SHR-SM7-0042', purchasedOn: due(-120), warrantyUntil: due(600) },
      { locationId: downtown.id, resourceId: null, name: 'Spare monitors (6)', category: 'IT', purchasedOn: due(-200) },
    ])
    .run();
  const reporter = async (email: string) => (await memberRows.find((m) => m.user.email === email))?.user ?? memberRows[0]!.user;
  const aircon = await db
    .insert(issues)
    .values({ locationId: downtown.id, resourceId: (await space('Focus Room A')).id, reportedById: (await reporter('hamza.sheikh@example.pk')).id, title: 'Air conditioning is not cooling', description: 'The room gets very warm after an hour.', priority: 'urgent' })
    .returning()
    .get();
  await db.insert(issues)
    .values([
      { locationId: downtown.id, resourceId: (await space('Hot Desk 4')).id, reportedById: (await reporter('sana.javed@example.pk')).id, title: 'Monitor arm is loose', priority: 'normal', status: 'in_progress' },
      { locationId: downtown.id, resourceId: (await space('Interview Room')).id, reportedById: (await reporter('hamza.sheikh@example.pk')).id, title: 'Light flickers', status: 'resolved', resolution: 'Replaced the tube.', resolvedAt: new Date().toISOString() },
    ])
    .run();
  void aircon;
  await db.insert(locationHolidays).values({ locationId: downtown.id, date: addDays(today, 10), name: 'Public holiday' }).run();
  await db.insert(announcements)
    .values([
      { locationId: downtown.id, title: 'Power maintenance on Saturday', body: 'The building power will be off from 2pm to 4pm. Generator backup covers the meeting rooms.', draft: false, createdById: nestOwner.id },
      { locationId: downtown.id, title: 'Members mixer (draft)', body: 'Friday evening, snacks provided.', draft: true, createdById: nestOwner.id },
    ])
    .run();

  // ---- History: bookings (inserted directly, they are in the past) --------
  const tz = downtown.timezone;
  const taken = new Set<string>();
  const freeUsed = new Map<string, number>(); // `${memberId}|${month}` -> included minutes consumed
  const insertPast = async (m: (typeof memberRows)[number], room: typeof boardroom, date: string, startH: number, durMin: number) => {
    const start = zonedToUtc(date, `${String(startH).padStart(2, '0')}:00`, tz);
    const end = new Date(start.getTime() + durMin * 60_000);
    if (end.getTime() > now.getTime()) return;
    for (let t = start.getTime(); t < end.getTime(); t += 15 * 60_000) if (taken.has(`${room.id}|${t}`)) return;
    for (let t = start.getTime(); t < end.getTime(); t += 15 * 60_000) taken.add(`${room.id}|${t}`);
    const key = `${m.member.id}|${date.slice(0, 7)}`;
    const left = Math.max(0, m.plan.includedMeetingMinutes - (freeUsed.get(key) ?? 0));
    const free = Math.min(durMin, left);
    freeUsed.set(key, (freeUsed.get(key) ?? 0) + free);
    const billable = durMin - free;
    await db.insert(bookings)
      .values({
        locationId: downtown.id,
        resourceId: room.id,
        memberId: m.member.id,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        status: 'completed',
        billableMinutes: billable,
        priceCents: Math.round((room.hourlyRateCents * billable) / 60),
        createdById: desk.id,
        createdAt: start.toISOString(),
      })
      .run();
  };
  for (let d = 150; d >= 1; d--) {
    const date = addDays(today, -d);
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (let k = 0; k < between(0, 2); k++) {
      await insertPast(await pick(active), await pick(rooms), date, between(9, 16), pick([30, 60, 60, 90, 120]));
    }
  }

  // ---- History: invoices and payments, month by month ----------------------
  const outcome = (monthsBack: number): 'paid' | 'late' | 'partial' | 'unpaid' => {
    const x = rand();
    if (monthsBack >= 2) return x < 0.88 ? 'paid' : x < 0.96 ? 'late' : 'unpaid';
    return x < 0.55 ? 'paid' : x < 0.7 ? 'partial' : 'unpaid';
  };
  const stamp = (date: string, hour: number) => zonedToUtc(date, `${String(hour).padStart(2, '0')}:00`, tz);
  const pay = async (inv: typeof invoices.$inferSelect, amount: number, paidOn: string) => {
    const at = stamp(paidOn, 10);
    await recordPayment(db, {
      invoiceId: inv.id,
      amountCents: amount,
      method: pick(['card', 'card', 'card', 'bank_transfer', 'bank_transfer', 'cash']),
      paidAt: (at > now ? now : at).toISOString(),
      reference: '',
      notes: '',
      recordedById: desk.id,
    });
  };

  for (let back = 5; back >= 1; back--) {
    const month = addMonths(thisMonth, -back);
    const issueNow = stamp(`${addMonths(month, 1)}-01`, 9);
    const { created } = await generateSubscriptionInvoices(db, { locationId: downtown.id, month, dueInDays: 7 }, issueNow);
    for (const inv of created) {
      const o = outcome(back);
      if (o === 'unpaid') continue;
      const balance = inv.totalCents;
      if (o === 'paid') await pay(inv, balance, addDays(inv.issueDate, between(1, 6)));
      if (o === 'late') await pay(inv, balance, addDays(inv.issueDate, between(12, 40)));
      if (o === 'partial') await pay(inv, Math.round((balance * 0.5) / 100) * 100, addDays(inv.issueDate, between(2, 7)));
    }
  }

  // This month: a few ad-hoc invoices (the monthly subscription run is left for you to try).
  const adhoc = async (i: number, description: string, quantity: number, unitPriceCents: number, daysAgo: number, paid: boolean) => {
    const issueDate = addDays(today, -daysAgo);
    const inv = await createInvoice(db, {
      locationId: downtown.id,
      memberId: memberRows[i]!.member.id,
      kind: 'manual',
      issueDate,
      dueDate: addDays(issueDate, 14),
      items: [{ description, quantity, unitPriceCents }],
    });
    if (paid) await pay(inv, inv.totalCents, issueDate);
  };
  await adhoc(4, 'Printing and scanning', 40, pkr(10), 9, true);
  await adhoc(6, 'Event space hire, product launch', 1, pkr(35_000), 5, false);
  await adhoc(0, 'Locker rental, 3 months', 3, pkr(1_000), 2, false);

  // ---- Expenses -----------------------------------------------------------
  const monthlyCosts: [typeof expenses.$inferInsert['category'], string, number, number][] = [
    ['rent', 'Clifton Properties (Pvt) Ltd', pkr(150_000), 1],
    ['utilities', 'K-Electric and SSGC', pkr(40_000), 5],
    ['internet', 'StormFiber Business', pkr(20_000), 3],
    ['cleaning', 'Sparkle Cleaning Services', pkr(25_000), 10],
    ['salaries', 'Payroll: front desk and community', pkr(120_000), 28],
    ['software', 'Coplaces and other subscriptions', pkr(8_000), 12],
    ['supplies', 'Tea, coffee and kitchen', pkr(12_000), 15],
  ];
  for (let back = 5; back >= 0; back--) {
    const month = addMonths(thisMonth, -back);
    for (const [category, vendor, base, day] of monthlyCosts) {
      const date = `${month}-${String(day).padStart(2, '0')}`;
      if (date > today) continue;
      const jitter = category === 'rent' || category === 'salaries' ? 0 : between(-8, 12) / 100;
      await db.insert(expenses)
        .values({ locationId: downtown.id, category, vendor, description: '', amountCents: Math.round(base * (1 + jitter)), incurredOn: date, createdById: manager.id })
        .run();
    }
    if (back % 2 === 1) {
      await db.insert(expenses)
        .values({ locationId: downtown.id, category: 'maintenance', vendor: 'CoolAir Services', description: 'AC servicing', amountCents: pkr(between(5, 15) * 1_000), incurredOn: `${month}-18`, createdById: manager.id })
        .run();
    }
  }
  await db.insert(expenses)
    .values({ locationId: downtown.id, category: 'marketing', vendor: 'Instagram and Meta ads', description: 'Open-house promotion', amountCents: pkr(25_000), incurredOn: addDays(today, -6), createdById: manager.id })
    .run();

  // ---- Today: attendance, visitors, upcoming bookings ---------------------
  const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000).toISOString();
  for (let d = 14; d >= 1; d--) {
    const date = addDays(today, -d);
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (const m of active) {
      if (rand() > 0.6) continue;
      const inAt = stamp(date, 8).getTime() + between(20, 150) * 60_000;
      const outAt = stamp(date, 16).getTime() + between(10, 170) * 60_000;
      await db.insert(attendance)
        .values({ locationId: downtown.id, memberId: m.member.id, checkInAt: new Date(inAt).toISOString(), checkOutAt: new Date(outAt).toISOString() })
        .run();
    }
  }
  for (const [i, m] of active.slice(0, 5).entries()) {
    await db.insert(attendance)
      .values({ locationId: downtown.id, memberId: m.member.id, resourceId: i < 3 ? hotDesks[i]!.id : null, checkInAt: minutesAgo(between(20, 240)) })
      .run();
  }

  const visitorAt = (date: string, time: string) => zonedToUtc(date, time, tz).toISOString();
  const tomorrowDate = addDays(today, 1);
  const visitorRows: (typeof visitors.$inferInsert)[] = [
    { name: 'Mehwish Tariq', company: 'Indus Ventures', purpose: 'Investor meeting', host: 0, at: visitorAt(today, '10:00'), status: 'checked_out', in: minutesAgo(300), out: minutesAgo(200) },
    { name: 'Kamran Butt', company: 'Butt Supplies', purpose: 'Delivery and demo', host: 3, at: visitorAt(today, '11:30'), status: 'checked_in', in: minutesAgo(35) },
    { name: 'Sadia Noman', company: 'Noman PR', purpose: 'Client lunch', host: 6, at: visitorAt(today, '13:00'), status: 'expected' },
    { name: 'Danish Rauf', company: 'Interview candidate', purpose: 'Interview', host: 6, at: visitorAt(today, '15:30'), status: 'expected' },
    { name: 'Rukhsar Ali', company: 'Ali and Sons', purpose: 'Contract signing', host: 5, at: visitorAt(tomorrowDate, '09:30'), status: 'expected' },
    { name: 'Taimoor Jamil', company: '', purpose: 'Photo shoot', host: 11, at: visitorAt(tomorrowDate, '14:00'), status: 'expected' },
  ].map((v) => ({
    locationId: downtown.id,
    hostMemberId: memberRows[v.host]!.member.id,
    name: v.name,
    company: v.company,
    purpose: v.purpose,
    expectedAt: v.at,
    status: v.status as 'expected',
    checkInAt: v.in ?? null,
    checkOutAt: v.out ?? null,
  }));
  await db.insert(visitors).values(visitorRows).run();

  // Upcoming bookings go through the real booking rules.
  const actor = (await loadAuthUser(db, desk.id))!;
  for (let d = 0; d <= 7; d++) {
    const date = addDays(today, d);
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (let k = 0; k < between(2, 4); k++) {
      const m = await pick(active);
      const startH = between(9, 16);
      const length = pick([1, 1, 2]);
      try {
        await createBooking(
          db,
          { resourceId: (await pick(rooms)).id, memberId: m.member.id, date, startTime: `${String(startH).padStart(2, '0')}:00`, endTime: `${String(startH + length).padStart(2, '0')}:00`, notes: '' },
          actor,
          now,
        );
      } catch {
        // slot clash or time already passed: skip
      }
    }
    for (const m of active.slice(0, between(3, 7))) {
      try {
        await createBooking(db, { resourceId: (await pick(hotDesks)).id, memberId: m.member.id, date, notes: '' }, actor, now);
      } catch {
        // desk or member already booked that day
      }
    }
  }

  // ---- Smaller tenants on other packages ------------------------------------
  const platformAdmin = (await db.select().from(users).where(eq(users.role, 'superadmin')).get())!;
  const miniTenant = async (o: {
    name: string;
    city: string;
    pkg: typeof starter;
    status: 'trial' | 'active' | 'suspended';
    periodEnd: string;
    contactEmail: string;
    ownerName: string;
    ownerEmail: string;
    location: { name: string; code: string; address: string; taxRateBps: number };
    people: [string, string][];
    billMonths: number;
    payments: number;
    notes?: string;
  }) => {
    const org = await mkOrg(o.name, o.city, o.pkg, o.status, o.periodEnd, o.contactEmail, o.notes);
    const owner = await mkUser(org.id, o.ownerEmail, o.ownerName, 'owner');
    const loc = await db
      .insert(locations)
      .values({ organizationId: org.id, ...o.location, timezone: 'Asia/Karachi', currency: 'PKR', openTime: '09:00', closeTime: '20:00' })
      .returning()
      .get();
    const hot = await plan(loc.id, 'Hot Desk', 15_000, { includesHotDesk: true, includedMeetingMinutes: 120 });
    const ded = await plan(loc.id, 'Dedicated Desk', 28_000, { includesHotDesk: true, includedMeetingMinutes: 480 });
    await res(loc.id, 'room', 'Meeting Room', { floor: '1', capacity: 8, hourlyRateCents: pkr(3_000), amenities: 'Screen, Whiteboard' });
    await res(loc.id, 'room', 'Huddle Room', { floor: '1', capacity: 4, hourlyRateCents: pkr(1_500), amenities: 'Whiteboard' });
    for (let i = 1; i <= 6; i++) await res(loc.id, 'hot_desk', `Hot Desk ${i}`, { floor: '1', dailyRateCents: pkr(1_200) });
    for (let i = 1; i <= 2; i++) await res(loc.id, 'dedicated_desk', `Desk D${i}`, { floor: '2' });
    await res(loc.id, 'office', 'Office 1', { floor: '2', capacity: 4 });

    const thisMonth = todayIn('Asia/Karachi', now).slice(0, 7);
    for (const [i, [name, company]] of o.people.entries()) {
      const u = await mkUser(org.id, emailOf(name), name, 'member');
      await db.insert(members)
        .values({
          userId: u.id,
          locationId: loc.id,
          company,
          planId: (i % 3 === 2 ? ded : hot).id,
          startDate: `${addMonths(thisMonth, -between(3, 7))}-${String(between(1, 25)).padStart(2, '0')}`,
        })
        .run();
    }

    for (let back = o.billMonths; back >= 1; back--) {
      const month = addMonths(thisMonth, -back);
      const issueNow = zonedToUtc(`${addMonths(month, 1)}-01`, '09:00', 'Asia/Karachi');
      for (const inv of (await generateSubscriptionInvoices(db, { locationId: loc.id, month, dueInDays: 7 }, issueNow)).created) {
        if (rand() < 0.25 && back === 1) continue;
        await recordPayment(db, {
          invoiceId: inv.id,
          amountCents: inv.totalCents,
          method: pick(['bank_transfer', 'jazzcash', 'easypaisa', 'cash']),
          paidAt: zonedToUtc(addDays(inv.issueDate, between(1, 6)), '11:00', 'Asia/Karachi').toISOString(),
          reference: '',
          notes: '',
          recordedById: owner.id,
        });
      }
    }
    await subscriptionHistory(org, o.pkg, platformAdmin.id, o.payments);
    return org;
  };

  await miniTenant({
    name: 'Hive Workspaces',
    city: 'Islamabad',
    pkg: growth,
    status: 'active',
    periodEnd: addDays(platformToday, 6), // renewal due soon, so the overview flags it
    contactEmail: 'accounts@hiveworkspaces.pk',
    ownerName: 'Usman Tariq',
    ownerEmail: 'owner@hive.test',
    location: { name: 'Hive F-7', code: 'HIV', address: 'Jinnah Super Market, F-7 Markaz, Islamabad', taxRateBps: 1600 },
    people: [
      ['Omar Farooqi', 'Farooqi Ventures'],
      ['Aisha Gul', 'Gul Handicrafts'],
      ['Danyal Khan', 'Khan Drone Services'],
      ['Mahnoor Tariq', 'Mahnoor Makeup Studio'],
      ['Shahid Rehman', 'Rehman Auto Parts'],
      ['Iqra Naveed', 'Naveed Tutoring'],
    ],
    billMonths: 2,
    payments: 3,
  });
  await miniTenant({
    name: 'Workbay',
    city: 'Lahore',
    pkg: starter,
    status: 'trial',
    periodEnd: addDays(platformToday, 9),
    contactEmail: 'zara@workbay.pk',
    ownerName: 'Zara Iqbal',
    ownerEmail: 'owner@workbay.test',
    location: { name: 'Workbay DHA', code: 'WBD', address: 'Phase 5, DHA, Lahore', taxRateBps: 1600 },
    people: [
      ['Talha Mehmood', 'TM Graphics'],
      ['Sidra Bashir', 'Bashir Bakes'],
      ['Waqas Anjum', 'Anjum Realty'],
    ],
    billMonths: 0,
    payments: 0,
    notes: 'Evaluating for a second branch. Follow up before the trial ends.',
  });
  await miniTenant({
    name: 'Quetta Collective',
    city: 'Quetta',
    pkg: starter,
    status: 'suspended',
    periodEnd: addDays(platformToday, -35),
    contactEmail: 'info@quettacollective.pk',
    ownerName: 'Nasir Baloch',
    ownerEmail: 'owner@quetta.test',
    location: { name: 'Quetta Collective', code: 'QTC', address: 'Jinnah Road, Quetta', taxRateBps: 1500 },
    people: [['Jawad Baloch', 'Baloch Carpets']],
    billMonths: 0,
    payments: 2,
    notes: 'Suspended after two missed renewals.',
  });

  return { downtown, riverside };
}

async function main() {
  const reset = process.argv.includes('--reset');
  if (reset) await dropAllTables(config.databaseUrl, config.databaseAuthToken);
  const db = await createDb(config.databaseUrl, config.databaseAuthToken);
  if (await db.select().from(locations).limit(1).get()) {
    console.error('The database already has data. Re-run with --reset to wipe it and reseed:  npm run seed -- --reset');
    process.exit(1);
  }
  await seedDemo(db);
  console.log('Demo data created.\n');
  console.log(`  platform   admin@coplaces.test        / ${DEMO_PASSWORD}  (super admin: all coworking spaces, packages)`);
  console.log(`  owner      owner@nest.test            / ${DEMO_PASSWORD}  (Nest Cowork, Pro package, 2 locations)`);
  console.log(`  manager    manager@nest.test          / ${DEMO_PASSWORD}  (Nest Clifton)`);
  console.log(`  front desk frontdesk@nest.test        / ${DEMO_PASSWORD}  (Nest Clifton)`);
  console.log(`  member     hamza.sheikh@example.pk    / ${DEMO_PASSWORD}`);
  console.log(`  owner      owner@hive.test            / ${DEMO_PASSWORD}  (Hive Workspaces, Growth package)`);
  console.log(`  owner      owner@workbay.test         / ${DEMO_PASSWORD}  (Workbay, Starter package, on trial)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
