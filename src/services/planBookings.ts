import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { bookings, invoices, locationHolidays, memberDesks, memberShifts, members, plans, resourceAssignments, resources, shiftSpaces, shiftTemplates } from '../db/schema.js';
import { loadLocation } from '../lib/access.js';
import { assertLocation, type AuthUser } from '../lib/auth.js';
import { advanceCredit } from './memberMoney.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { addDays, addMonthsToDate, businessDateOf, daysBetween, localDate, localTime, shiftWindow, spanMinutes, toMinutes, todayIn, zonedToUtc } from '../lib/time.js';
import { createInvoice, voidInvoice, type LineItem } from './billing.js';
import { closedReason, weekdayOf } from './bookings.js';

/**
 * Spaces a plan hands to a member: desks and offices. Meeting-type rooms (meeting, board, training rooms) are not on plans:
 * members ask the owner for those, one booking at a time.
 */
export const PLAN_KINDS = ['hot_desk', 'dedicated_desk', 'office'];

/** How many days before a plan period ends the owner is reminded, and may renew it. */
export const RENEW_DAYS_BEFORE = 2;

type Plan = typeof plans.$inferSelect;
type Shift = typeof shiftTemplates.$inferSelect;
type Space = typeof resources.$inferSelect;

/** The last day of a plan period that starts on `start`: a month later for a monthly plan, the same day for a day pass. */
export const periodEnd = (interval: 'month' | 'day', start: string) => (interval === 'month' ? addDays(addMonthsToDate(start, 1), -1) : start);

async function loadShifts(db: Db, plan: Plan, shiftIds: string[]) {
  const ids = [...new Set(shiftIds)];
  if (!ids.length) throw badRequest('Choose at least one shift');
  const rows = await db.select().from(shiftTemplates).where(inArray(shiftTemplates.id, ids)).all();
  if (rows.length !== ids.length || rows.some((s) => s.planId !== plan.id)) throw badRequest('Those shifts are not part of this plan');
  const off = rows.find((s) => !s.active);
  if (off) throw badRequest(`${off.name} is not being offered`);
  const sorted = [...rows].sort((a, b) => a.startTime.localeCompare(b.startTime));
  // Shifts that run past midnight are measured on the clock face, so a night shift also clashes with an early morning one.
  const span = (s: Shift) => [toMinutes(s.startTime), toMinutes(s.startTime) + spanMinutes(s.startTime, s.endTime)] as const;
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const [a1, a2] = span(sorted[i]!);
      const [b1, b2] = span(sorted[j]!);
      if ([-1440, 0, 1440].some((k) => a1 < b2 + k && b1 + k < a2)) throw badRequest(`${sorted[i]!.name} and ${sorted[j]!.name} overlap. Choose shifts that do not run at the same time`);
    }
  }
  return sorted;
}

/** The spaces each shift is limited to; a shift with none covers every plan space. */
async function spacesByShift(db: Db, shifts: Shift[]) {
  const rows = await db.select().from(shiftSpaces).where(inArray(shiftSpaces.shiftId, shifts.map((s) => s.id))).all();
  return new Map(shifts.map((s) => [s.id, rows.filter((r) => r.shiftId === s.id).map((r) => r.resourceId)]));
}

const covers = (s: Shift, listed: string[], space: Space) => (listed.length ? listed.includes(space.id) : s.resourceId ? s.resourceId === space.id : !s.kind || s.kind === space.kind);

/** Days of the period a location is open, as 'YYYY-MM-DD'. One query for the holidays, not one per day. */
async function openDays(db: Db, loc: Parameters<typeof closedReason>[1], start: string, end: string) {
  const holidays = new Set((await db.select({ date: locationHolidays.date }).from(locationHolidays).where(and(eq(locationHolidays.locationId, loc.id), gte(locationHolidays.date, start), lte(locationHolidays.date, end))).all()).map((h) => h.date));
  const weekly = loc.closedWeekdays.split(',');
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) if (!holidays.has(d) && !weekly.includes(String(weekdayOf(d)))) out.push(d);
  return out;
}

const daysFor = (space: Space, open: string[]) => open.filter((d) => !space.closedWeekdays?.split(',').includes(String(weekdayOf(d))));

/**
 * The desks and offices that can be given for a period: they belong to every shift chosen, and nobody else holds them in any
 * of the shift times on any open day. `only` narrows the answer to those spaces.
 */
export async function freeSpaces(db: Db, locationId: string, shifts: Shift[], start: string, end: string, only?: string[], exceptMemberId?: string) {
  const loc = await loadLocation(db, locationId);
  const open = await openDays(db, loc, start, end);
  const all = (await db.select().from(resources).where(eq(resources.locationId, locationId)).all()).filter((r) => PLAN_KINDS.includes(r.kind) && r.status === 'available' && (!only || only.includes(r.id)));
  if (!all.length) return [];
  const listed = await spacesByShift(db, shifts);
  const candidates = all.filter((r) => shifts.every((s) => covers(s, listed.get(s.id) ?? [], r)));
  if (!candidates.length) return [];
  const ids = candidates.map((r) => r.id);
  const from = zonedToUtc(start, '00:00', loc.timezone).toISOString();
  // A night shift on the last day runs into the day after it.
  const to = zonedToUtc(addDays(end, 2), '00:00', loc.timezone).toISOString();
  const held = await db
    .select({ resourceId: bookings.resourceId, startsAt: bookings.startsAt, endsAt: bookings.endsAt })
    .from(bookings)
    .where(and(inArray(bookings.resourceId, ids), inArray(bookings.status, ['confirmed', 'completed']), gt(bookings.endsAt, from), lt(bookings.startsAt, to), exceptMemberId ? ne(bookings.memberId, exceptMemberId) : undefined))
    .all();
  const rented = new Set(
    (await db
      .select({ resourceId: resourceAssignments.resourceId })
      .from(resourceAssignments)
      .where(and(inArray(resourceAssignments.resourceId, ids), lt(resourceAssignments.startDate, addDays(end, 1)), or(isNull(resourceAssignments.endDate), gt(resourceAssignments.endDate, addDays(start, -1)))))
      .all()).map((r) => r.resourceId),
  );
  return candidates.filter((r) => {
    if (rented.has(r.id)) return false;
    const mine = held.filter((b) => b.resourceId === r.id);
    return daysFor(r, open).every((day) =>
      shifts.every((s) => {
        const w = shiftWindow(day, s.startTime, s.endTime, loc.timezone, loc.openTime, loc.closeTime);
        const a = w.startsAt.toISOString();
        const b = w.endsAt.toISOString();
        return mine.filter((x) => x.startsAt < b && x.endsAt > a).length < r.capacity;
      }),
    );
  });
}

/** For the form: which spaces are free for these shifts from this date, for the plan's period length. */
export async function freeSpacesForPlan(db: Db, actor: AuthUser, planId: string, shiftIds: string[], start: string, exceptMemberId?: string) {
  const plan = await db.select().from(plans).where(eq(plans.id, planId)).get();
  if (!plan) throw notFound('Plan');
  assertLocation(actor, plan.locationId);
  const shifts = await loadShifts(db, plan, shiftIds);
  return { end: periodEnd(plan.interval, start), spaces: await freeSpaces(db, plan.locationId, shifts, start, periodEnd(plan.interval, start), undefined, exceptMemberId) };
}

/** Books each chosen space for each shift on every open day from `from` to `end`, and remembers what the member took. */
async function bookPeriod(t: Db, actor: AuthUser, memberId: string, plan: Plan, shiftIds: string[], spaceIds: string[], period: { start: string; end: string; from: string }) {
  const member = await t.select().from(members).where(eq(members.id, memberId)).get();
  if (!member) throw notFound('Member');
  const loc = await loadLocation(t, plan.locationId);
  const shifts = await loadShifts(t, plan, shiftIds);
  const wanted = [...new Set(spaceIds)];
  const free = await freeSpaces(t, plan.locationId, shifts, period.from, period.end, wanted, member.id);
  for (const id of wanted) {
    if (!free.some((f) => f.id === id)) {
      const name = (await t.select({ n: resources.name }).from(resources).where(eq(resources.id, id)).get())?.n ?? 'A space';
      throw conflict(`${name} is not free for those shifts from ${period.from}. Choose another.`);
    }
  }
  const open = await openDays(t, loc, period.from, period.end);
  if (!open.length) throw badRequest('The location is closed on every day of that period');
  const note = `${plan.name}: ${shifts.map((s) => s.name).join(', ')}`;
  // A month of shifts is hundreds of rows. They go in a few statements, not one round trip each: the database is across the internet.
  const rows: (typeof bookings.$inferInsert)[] = [];
  for (const space of free) {
    for (const day of daysFor(space, open)) {
      for (const s of shifts) {
        const w = shiftWindow(day, s.startTime, s.endTime, loc.timezone, loc.openTime, loc.closeTime);
        rows.push({ locationId: loc.id, resourceId: space.id, memberId: member.id, startsAt: w.startsAt.toISOString(), endsAt: w.endsAt.toISOString(), billableMinutes: 0, priceCents: 0, notes: note, createdById: actor.id, source: 'plan' });
      }
    }
  }
  for (let i = 0; i < rows.length; i += 50) await t.insert(bookings).values(rows.slice(i, i + 50)).run();
  await t.delete(memberShifts).where(eq(memberShifts.memberId, member.id)).run();
  await t.delete(memberDesks).where(eq(memberDesks.memberId, member.id)).run();
  if (shifts.length) await t.insert(memberShifts).values(shifts.map((s) => ({ memberId: member.id, shiftId: s.id }))).run();
  if (wanted.length) await t.insert(memberDesks).values(wanted.map((id) => ({ memberId: member.id, resourceId: id }))).run();
  await t.update(members).set({ planId: plan.id, planStart: period.start, planEnd: period.end }).where(eq(members.id, member.id)).run();
  return { loc, shifts };
}

const itemsFor = (plan: Plan, shifts: Shift[], start: string, end: string): LineItem[] =>
  shifts.filter((s) => (s.priceCents ?? 0) > 0).map((s) => ({ description: `${plan.name}: ${s.name} ${s.startTime}–${s.endTime}, ${start} to ${end}`, quantity: 1, unitPriceCents: s.priceCents! }));

async function invoiceItems(t: Db, locationId: string, memberId: string, items: LineItem[], start: string, tz: string) {
  if (!items.length) return null;
  const today = todayIn(tz);
  // What the member paid in advance comes off the shift prices, until it is used up.
  const credit = await advanceCredit(t, memberId, items.reduce((s, i) => s + i.quantity * i.unitPriceCents, 0));
  if (credit) items = [...items, credit];
  return createInvoice(t, { locationId, memberId, kind: 'subscription', issueDate: today, dueDate: addDays(today, 7), periodStart: start, items });
}

/**
 * Starts a period of a member's plan: books each chosen desk or office for each chosen shift on every open day, remembers what they
 * took, and bills the shifts' prices added together. The bookings carry no price of their own, because the plan pays for them.
 */
export async function startPlanPeriod(t: Db, actor: AuthUser, memberId: string, plan: Plan, shiftIds: string[], spaceIds: string[], start: string) {
  const end = periodEnd(plan.interval, start);
  const { loc, shifts } = await bookPeriod(t, actor, memberId, plan, shiftIds, spaceIds, { start, end, from: start });
  const items = itemsFor(plan, shifts, start, end);
  const invoice = await invoiceItems(t, loc.id, memberId, items, start, loc.timezone);
  return { start, end, totalCents: items.reduce((s, i) => s + i.unitPriceCents, 0), invoiceId: invoice?.id ?? null };
}

/**
 * Changes a member's plan, shifts or desks, for example when one was forgotten. What has not happened yet is re-booked from today:
 * the old plan bookings that have not started are cancelled and new ones made. Days already gone are left as they were.
 * The bill follows: an unpaid invoice for the period is replaced, and if it was already paid only the extra is billed.
 */
export async function changePlan(db: Db, actor: AuthUser, memberId: string, input: { planId: string | null; shiftIds: string[]; spaceIds: string[]; startDate?: string | undefined }) {
  const out = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const member = await t.select().from(members).where(eq(members.id, memberId)).get();
    if (!member) throw notFound('Member');
    assertLocation(actor, member.locationId);
    if (member.status !== 'active') throw badRequest('Only active members can have their plan changed');
    const loc = await loadLocation(t, member.locationId);
    const today = todayIn(loc.timezone);
    const plan = input.planId ? await t.select().from(plans).where(eq(plans.id, input.planId)).get() : null;
    if (input.planId && (!plan || plan.locationId !== member.locationId)) throw badRequest('Plan does not belong to this location');

    // What they took before, to work out the bill afterwards.
    const before = await t.select({ s: shiftTemplates }).from(memberShifts).innerJoin(shiftTemplates, eq(shiftTemplates.id, memberShifts.shiftId)).where(eq(memberShifts.memberId, member.id)).all();
    const oldStart = member.planStart;
    const dayStart = zonedToUtc(today, '00:00', loc.timezone).toISOString();
    const stopFuture = () =>
      t.update(bookings)
        .set({ status: 'cancelled', cancelledAt: new Date().toISOString() })
        .where(and(eq(bookings.memberId, member.id), eq(bookings.source, 'plan'), eq(bookings.status, 'confirmed'), isNull(bookings.checkedInAt), gte(bookings.startsAt, dayStart)))
        .run();

    // No plan, or a plan that has no shifts: nothing to book.
    const offered = plan ? await t.select({ id: shiftTemplates.id }).from(shiftTemplates).where(and(eq(shiftTemplates.planId, plan.id), eq(shiftTemplates.active, true))).all() : [];
    if (!plan || !offered.length) {
      if (plan && input.shiftIds.length) throw badRequest('Those shifts are not part of this plan');
      await stopFuture();
      await t.delete(memberShifts).where(eq(memberShifts.memberId, member.id)).run();
      await t.delete(memberDesks).where(eq(memberDesks.memberId, member.id)).run();
      await t.update(members).set({ planId: plan?.id ?? null, planStart: null, planEnd: null }).where(eq(members.id, member.id)).run();
      return { shifts: [] as Shift[], plan, start: today, end: today, samePlan: false, before, oldStart, loc };
    }

    const samePlan = member.planId === plan.id && !!member.planStart && !!member.planEnd && !input.startDate;
    const start = samePlan ? member.planStart! : (input.startDate ?? today);
    const end = samePlan ? member.planEnd! : periodEnd(plan.interval, start);
    const from = start > today ? start : today;
    if (end < from) throw badRequest('This plan period has already ended. Renew it instead');
    await stopFuture();
    const { shifts } = await bookPeriod(t, actor, member.id, plan, input.shiftIds, input.spaceIds, { start, end, from });
    return { shifts, plan, start, end, samePlan, before, oldStart, loc };
  });

  // The bill, after the bookings are safe.
  const { shifts, plan, start, end, samePlan, before, oldStart, loc } = out;
  let invoiceId: string | null = null;
  const oldInvoice = oldStart
    ? await db.select().from(invoices).where(and(eq(invoices.memberId, memberId), eq(invoices.kind, 'subscription'), eq(invoices.periodStart, oldStart), ne(invoices.status, 'void'))).orderBy(desc(invoices.createdAt)).get()
    : undefined;
  if (plan && shifts.length) {
    const all = itemsFor(plan, shifts, start, end);
    if (oldInvoice && oldInvoice.status === 'open' && oldInvoice.paidCents === 0) {
      await voidInvoice(db, oldInvoice.id); // gives back the advance it used
      invoiceId = (await invoiceItems(db, loc.id, memberId, all, start, loc.timezone))?.id ?? null;
    } else if (samePlan && oldInvoice) {
      // Already paid, or part paid: keep it, and bill only what they now have that they did not.
      const had = new Set(before.map((b) => b.s.id));
      invoiceId = (await invoiceItems(db, loc.id, memberId, itemsFor(plan, shifts.filter((s) => !had.has(s.id)), start, end), start, loc.timezone))?.id ?? null;
    } else {
      invoiceId = (await invoiceItems(db, loc.id, memberId, all, start, loc.timezone))?.id ?? null;
    }
  } else if (oldInvoice && oldInvoice.status === 'open' && oldInvoice.paidCents === 0) {
    await voidInvoice(db, oldInvoice.id);
  }
  return { start, end, invoiceId };
}

/** The next period for a member, with the same shifts and desks, starting after the current one ends (or today if it has lapsed). */
export function renewPlan(db: Db, actor: AuthUser, memberId: string, startDate?: string) {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const member = await t.select().from(members).where(eq(members.id, memberId)).get();
    if (!member) throw notFound('Member');
    assertLocation(actor, member.locationId);
    if (member.status !== 'active') throw badRequest('Only active members can renew');
    const plan = member.planId ? await t.select().from(plans).where(eq(plans.id, member.planId)).get() : null;
    const shiftIds = (await t.select({ id: memberShifts.shiftId }).from(memberShifts).where(eq(memberShifts.memberId, member.id)).all()).map((x) => x.id);
    if (!plan || !shiftIds.length) throw badRequest('This member has no plan shifts to renew. Choose a plan and shifts for them first');
    const spaceIds = (await t.select({ id: memberDesks.resourceId }).from(memberDesks).where(eq(memberDesks.memberId, member.id)).all()).map((x) => x.id);
    const today = todayIn((await loadLocation(t, member.locationId)).timezone);
    // Renewing opens two days before the period ends (and stays open after it), so nobody is renewed by accident a month early.
    if (member.planEnd && daysBetween(today, member.planEnd) > RENEW_DAYS_BEFORE) throw badRequest(`Renewal opens ${RENEW_DAYS_BEFORE} days before the plan ends, on ${addDays(member.planEnd, -RENEW_DAYS_BEFORE)}`);
    const earliest = member.planEnd ? addDays(member.planEnd, 1) : today;
    const start = startDate ?? (earliest > today ? earliest : today);
    if (start < earliest) throw badRequest(`The next period cannot start before ${earliest}, the day after this one ends`);
    return startPlanPeriod(t, actor, member.id, plan, shiftIds, spaceIds, start);
  });
}

/**
 * A shift's times were changed: the bookings its members already have, from now on, move to the new times. Without this the
 * members keep the old times, and the front desk cannot check them in for the new ones. Days that are already over stay as they were.
 */
export async function retimeShiftBookings(db: Db, shift: Shift, next: { startTime: string; endTime: string }, now = new Date()) {
  if (next.startTime === shift.startTime && next.endTime === shift.endTime) return 0;
  const loc = await loadLocation(db, shift.locationId);
  const tz = loc.timezone;
  const who = (await db.select({ id: memberShifts.memberId }).from(memberShifts).where(eq(memberShifts.shiftId, shift.id)).all()).map((x) => x.id);
  if (!who.length) return 0;
  const nowIso = now.toISOString();
  const rows = await db
    .select()
    .from(bookings)
    .where(and(inArray(bookings.memberId, who), eq(bookings.source, 'plan'), eq(bookings.status, 'confirmed'), gt(bookings.endsAt, nowIso)))
    .all();
  const mine = rows.filter((b) => localTime(b.startsAt, tz) === shift.startTime && localTime(b.endsAt, tz) === shift.endTime);
  if (!mine.length) return 0;
  const moves = mine.map((b) => {
    const w = shiftWindow(businessDateOf(b.startsAt, tz, loc.openTime, loc.closeTime), next.startTime, next.endTime, tz, loc.openTime, loc.closeTime);
    return { b, startsAt: w.startsAt.toISOString(), endsAt: w.endsAt.toISOString() };
  });
  // Nobody else may be sitting in the new time.
  const ids = new Set(mine.map((b) => b.id));
  const others = await db
    .select()
    .from(bookings)
    .where(and(inArray(bookings.resourceId, [...new Set(mine.map((b) => b.resourceId))]), inArray(bookings.status, ['confirmed', 'completed']), gt(bookings.endsAt, nowIso)))
    .all();
  for (const m of moves) {
    const capacity = (await db.select({ c: resources.capacity, n: resources.name }).from(resources).where(eq(resources.id, m.b.resourceId)).get())!;
    const taking = others.filter((o) => !ids.has(o.id) && o.resourceId === m.b.resourceId && o.startsAt < m.endsAt && o.endsAt > m.startsAt).length;
    if (taking >= capacity.c) throw conflict(`${capacity.n} is already booked on ${localDate(m.startsAt, tz)} in the new time, so the shift cannot move`);
  }
  // Every booking on one day moves to the same new times, so one statement per day.
  const byDay = new Map<string, typeof moves>();
  for (const m of moves) byDay.set(m.startsAt, [...(byDay.get(m.startsAt) ?? []), m]);
  await db.transaction(async (tx) => {
    for (const group of byDay.values()) {
      const first = group[0]!;
      await tx.update(bookings).set({ startsAt: first.startsAt, endsAt: first.endsAt }).where(inArray(bookings.id, group.map((g) => g.b.id))).run();
    }
  });
  return moves.length;
}
