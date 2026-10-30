import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  attendance,
  bookings,
  contracts,
  depositEntries,
  expenses,
  invoices,
  members,
  payments,
  plans,
  resourceAssignments,
  resources,
  users,
  visitors,
} from '../db/schema.js';
import { isHourly } from '../catalogue.js';
import { amenityFinance } from './amenities.js';
import { loadLocation } from '../lib/access.js';
import { addDays, addMonths, daysBetween, dayRange, localDate, monthRange, todayIn, zonedToUtc } from '../lib/time.js';

const count = sql<number>`count(*)`;
const sumOf = (col: Parameters<typeof sql>[1]) => sql<number>`coalesce(sum(${col}), 0)`;

export async function dashboard(db: Db, locationId: string, includeFinance: boolean, now = new Date()) {
  const loc = await loadLocation(db, locationId);
  const tz = loc.timezone;
  const today = todayIn(tz, now);
  const day = dayRange(today, tz);
  const month = monthRange(today.slice(0, 7), tz);
  const nowIso = now.toISOString();

  const activeMembers = (await db
    .select({ n: count })
    .from(members)
    .where(and(eq(members.locationId, locationId), eq(members.status, 'active')))
    .get())!.n;
  const checkedInNow = (await db
    .select({ n: count })
    .from(attendance)
    .where(and(eq(attendance.locationId, locationId), isNull(attendance.checkOutAt)))
    .get())!.n;

  const visitorsToday = await db
    .select({ status: visitors.status, n: count })
    .from(visitors)
    .where(and(eq(visitors.locationId, locationId), gte(visitors.expectedAt, day.start), lt(visitors.expectedAt, day.end)))
    .groupBy(visitors.status)
    .all();
  const vCount = (s: string) => visitorsToday.find((v) => v.status === s)?.n ?? 0;
  const visitorsInside = (await db
    .select({ n: count })
    .from(visitors)
    .where(and(eq(visitors.locationId, locationId), eq(visitors.status, 'checked_in')))
    .get())!.n;

  const totals = await db
    .select({ kind: resources.kind, n: count })
    .from(resources)
    .where(and(eq(resources.locationId, locationId), eq(resources.status, 'available')))
    .groupBy(resources.kind)
    .all();
  const total = (k: string) => totals.find((t) => t.kind === k)?.n ?? 0;

  const liveToday = await db
    .select({ resourceId: bookings.resourceId, kind: resources.kind, startsAt: bookings.startsAt, endsAt: bookings.endsAt })
    .from(bookings)
    .innerJoin(resources, eq(resources.id, bookings.resourceId))
    .where(
      and(
        eq(bookings.locationId, locationId),
        inArray(bookings.status, ['confirmed', 'completed']),
        lt(bookings.startsAt, day.end),
        gt(bookings.endsAt, day.start),
      ),
    )
    .all();
  const roomsInUseNow = new Set(
    liveToday.filter((b) => isHourly(b.kind) && b.startsAt <= nowIso && b.endsAt > nowIso).map((b) => b.resourceId),
  ).size;
  const hotDesksBooked = new Set(liveToday.filter((b) => b.kind === 'hot_desk').map((b) => b.resourceId)).size;

  const assigned = await db
    .select({ resourceId: resourceAssignments.resourceId, kind: resources.kind })
    .from(resourceAssignments)
    .innerJoin(resources, eq(resources.id, resourceAssignments.resourceId))
    .where(
      and(
        eq(resources.locationId, locationId),
        lte(resourceAssignments.startDate, today),
        or(isNull(resourceAssignments.endDate), gte(resourceAssignments.endDate, today)),
      ),
    )
    .all();
  const assignedOf = (k: string) => new Set(assigned.filter((a) => a.kind === k).map((a) => a.resourceId)).size;

  const ops = {
    activeMembers,
    checkedInNow,
    visitorsExpectedToday: vCount('expected'),
    visitorsToday: vCount('expected') + vCount('checked_in') + vCount('checked_out'),
    visitorsInside,
    bookingsToday: liveToday.length,
    // Corporate rooms count with the rooms: both are booked by the hour.
    rooms: { total: total('room') + total('corporate_room'), inUseNow: roomsInUseNow },
    hotDesks: { total: total('hot_desk'), bookedToday: hotDesksBooked },
    dedicatedDesks: { total: total('dedicated_desk'), assigned: assignedOf('dedicated_desk') },
    offices: { total: total('office'), assigned: assignedOf('office') },
    storage: { total: total('storage'), assigned: assignedOf('storage') },
  };

  let finance = null;
  if (includeFinance) {
    const mrr = (await db
      .select({ v: sumOf(plans.priceCents) })
      .from(members)
      .innerJoin(plans, eq(plans.id, members.planId))
      .where(and(eq(members.locationId, locationId), eq(members.status, 'active'), eq(plans.interval, 'month')))
      .get())!.v;
    const collected = (await db
      .select({ v: sumOf(payments.amountCents) })
      .from(payments)
      .where(and(eq(payments.locationId, locationId), gte(payments.paidAt, month.start), lt(payments.paidAt, month.end)))
      .get())!.v;
    const invoiced = (await db
      .select({ v: sumOf(invoices.totalCents) })
      .from(invoices)
      .where(
        and(
          eq(invoices.locationId, locationId),
          ne(invoices.status, 'void'),
          gte(invoices.issueDate, month.firstDay),
          lt(invoices.issueDate, month.nextFirstDay),
        ),
      )
      .get())!.v;
    const open = await db
      .select({ total: invoices.totalCents, paid: invoices.paidCents, dueDate: invoices.dueDate })
      .from(invoices)
      .where(and(eq(invoices.locationId, locationId), eq(invoices.status, 'open')))
      .all();
    const spent = (await db
      .select({ v: sumOf(expenses.amountCents) })
      .from(expenses)
      .where(and(eq(expenses.locationId, locationId), gte(expenses.incurredOn, month.firstDay), lt(expenses.incurredOn, month.nextFirstDay)))
      .get())!.v;
    finance = {
      mrrCents: mrr,
      collectedThisMonthCents: collected,
      invoicedThisMonthCents: invoiced,
      expensesThisMonthCents: spent,
      outstandingCents: open.reduce((s, i) => s + i.total - i.paid, 0),
      overdueCents: open.filter((i) => i.dueDate < today).reduce((s, i) => s + i.total - i.paid, 0),
      overdueCount: open.filter((i) => i.dueDate < today).length,
    };
  }

  return { today, currency: loc.currency, ops, finance };
}

export async function financeReport(db: Db, p: { locationId: string; from: string; to: string }, now = new Date()) {
  const loc = await loadLocation(db, p.locationId);
  const tz = loc.timezone;
  const today = todayIn(tz, now);
  const start = zonedToUtc(p.from, '00:00', tz).toISOString();
  const end = zonedToUtc(addDays(p.to, 1), '00:00', tz).toISOString();

  const pays = await db
    .select({ amountCents: payments.amountCents, method: payments.method, paidAt: payments.paidAt, kind: invoices.kind })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .where(and(eq(payments.locationId, p.locationId), gte(payments.paidAt, start), lt(payments.paidAt, end)))
    .all();
  // Security deposit money moving in and out, the part the space kept and any advance rent taken; the last two are income from the day they happen.
  const depositMoves = await db
    .select({ e: depositEntries, memberName: users.name, resourceName: resources.name })
    .from(depositEntries)
    .leftJoin(contracts, eq(contracts.id, depositEntries.contractId))
    .innerJoin(members, eq(members.id, sql`coalesce(${depositEntries.memberId}, ${contracts.memberId})`))
    .innerJoin(users, eq(users.id, members.userId))
    .leftJoin(resources, eq(resources.id, contracts.resourceId))
    .where(and(eq(depositEntries.locationId, p.locationId), gte(depositEntries.occurredAt, start), lt(depositEntries.occurredAt, end)))
    .orderBy(desc(depositEntries.occurredAt))
    .all();
  const keptDeposits = depositMoves.filter((x) => x.e.kind === 'kept').map((x) => ({ amountCents: x.e.amountCents, paidAt: x.e.occurredAt }));
  const advances = depositMoves.filter((x) => x.e.kind === 'advance').map((x) => ({ amountCents: x.e.amountCents, paidAt: x.e.occurredAt }));
  const depositTotal = async (kind: string) => (await db
    .select({ v: sumOf(depositEntries.amountCents) })
    .from(depositEntries)
    .where(and(eq(depositEntries.locationId, p.locationId), eq(depositEntries.kind, kind as 'kept'), lt(depositEntries.occurredAt, now.toISOString())))
    .get())!.v;
  const heldCents = await depositTotal('received') - await depositTotal('refunded') - await depositTotal('kept');
  // Amenities charged beyond a member's free amount are income when the front desk collects them.
  const amenity = await amenityFinance(db, p.locationId, start, end);
  const spend = await db
    .select({ amountCents: expenses.amountCents, category: expenses.category, incurredOn: expenses.incurredOn })
    .from(expenses)
    .where(and(eq(expenses.locationId, p.locationId), gte(expenses.incurredOn, p.from), lte(expenses.incurredOn, p.to)))
    .all();
  const invs = await db
    .select({ totalCents: invoices.totalCents, issueDate: invoices.issueDate })
    .from(invoices)
    .where(
      and(eq(invoices.locationId, p.locationId), ne(invoices.status, 'void'), gte(invoices.issueDate, p.from), lte(invoices.issueDate, p.to)),
    )
    .all();

  const monthly = new Map<string, { month: string; collectedCents: number; invoicedCents: number; expensesCents: number; netCents: number }>();
  const last = p.to.slice(0, 7);
  for (let m = p.from.slice(0, 7), i = 0; m <= last && i < 60; m = addMonths(m, 1), i++) {
    monthly.set(m, { month: m, collectedCents: 0, invoicedCents: 0, expensesCents: 0, netCents: 0 });
  }
  for (const x of pays) {
    const row = monthly.get(localDate(x.paidAt, tz).slice(0, 7));
    if (row) row.collectedCents += x.amountCents;
  }
  for (const x of [...keptDeposits, ...advances, ...amenity.collected]) {
    const row = monthly.get(localDate(x.paidAt, tz).slice(0, 7));
    if (row) row.collectedCents += x.amountCents;
  }
  for (const x of invs) {
    const row = monthly.get(x.issueDate.slice(0, 7));
    if (row) row.invoicedCents += x.totalCents;
  }
  for (const x of spend) {
    const row = monthly.get(x.incurredOn.slice(0, 7));
    if (row) row.expensesCents += x.amountCents;
  }
  for (const row of monthly.values()) row.netCents = row.collectedCents - row.expensesCents;

  const group = <T extends string>(rows: { amountCents: number }[], key: (r: never) => T) => {
    const out = new Map<T, number>();
    for (const r of rows) out.set(key(r as never), (out.get(key(r as never)) ?? 0) + r.amountCents);
    return [...out.entries()].map(([k, amountCents]) => ({ key: k, amountCents })).sort((a, b) => b.amountCents - a.amountCents);
  };

  const keptCents = keptDeposits.reduce((s, x) => s + x.amountCents, 0);
  const advanceCents = advances.reduce((s, x) => s + x.amountCents, 0);
  const amenityCents = amenity.collected.reduce((s, x) => s + x.amountCents, 0);
  const collectedCents = pays.reduce((s, x) => s + x.amountCents, 0) + keptCents + advanceCents + amenityCents;
  const expensesCents = spend.reduce((s, x) => s + x.amountCents, 0);

  const openInvoices = await db
    .select({ total: invoices.totalCents, paid: invoices.paidCents, dueDate: invoices.dueDate })
    .from(invoices)
    .where(and(eq(invoices.locationId, p.locationId), eq(invoices.status, 'open')))
    .all();
  const aging = { current: { count: 0, amountCents: 0 }, days1to30: { count: 0, amountCents: 0 }, days31to60: { count: 0, amountCents: 0 }, days61plus: { count: 0, amountCents: 0 } };
  for (const i of openInvoices) {
    const late = daysBetween(i.dueDate, today);
    const bucket = late <= 0 ? aging.current : late <= 30 ? aging.days1to30 : late <= 60 ? aging.days31to60 : aging.days61plus;
    bucket.count++;
    bucket.amountCents += i.total - i.paid;
  }

  // The stretch of time just before this one, as long as this one, so the screen can say "up on last period".
  const span = daysBetween(p.from, p.to) + 1;
  const prevTo = addDays(p.from, -1);
  const prevFrom = addDays(p.from, -span);
  const prevStart = zonedToUtc(prevFrom, '00:00', tz).toISOString();
  const prevEnd = zonedToUtc(p.from, '00:00', tz).toISOString();
  const prevCollected = (await db
    .select({ v: sumOf(payments.amountCents) })
    .from(payments)
    .where(and(eq(payments.locationId, p.locationId), gte(payments.paidAt, prevStart), lt(payments.paidAt, prevEnd)))
    .get())!.v;
  const prevKept = (await db
    .select({ v: sumOf(depositEntries.amountCents) })
    .from(depositEntries)
    .where(and(eq(depositEntries.locationId, p.locationId), inArray(depositEntries.kind, ['kept', 'advance']), gte(depositEntries.occurredAt, prevStart), lt(depositEntries.occurredAt, prevEnd)))
    .get())!.v;
  const prevAmenities = (await amenityFinance(db, p.locationId, prevStart, prevEnd)).collected.reduce((t, x) => t + x.amountCents, 0);
  const prevExpenses = (await db
    .select({ v: sumOf(expenses.amountCents) })
    .from(expenses)
    .where(and(eq(expenses.locationId, p.locationId), gte(expenses.incurredOn, prevFrom), lte(expenses.incurredOn, prevTo)))
    .get())!.v;

  // Profit and loss, month by month. Income counts when the money arrives, costs when they are incurred.
  const months = [...monthly.keys()];
  const monthIndex = new Map(months.map((m, i) => [m, i]));
  const blank = () => months.map(() => 0);
  const incomeRows = new Map<string, number[]>([
    ['subscription', blank()],
    ['manual', blank()],
    ['kept_deposit', blank()],
    ['advance', blank()],
    ['amenities', blank()],
  ]);
  for (const x of pays) {
    const i = monthIndex.get(localDate(x.paidAt, tz).slice(0, 7));
    if (i !== undefined) incomeRows.get(x.kind)![i]! += x.amountCents;
  }
  for (const x of keptDeposits) {
    const i = monthIndex.get(localDate(x.paidAt, tz).slice(0, 7));
    if (i !== undefined) incomeRows.get('kept_deposit')![i]! += x.amountCents;
  }
  for (const x of advances) {
    const i = monthIndex.get(localDate(x.paidAt, tz).slice(0, 7));
    if (i !== undefined) incomeRows.get('advance')![i]! += x.amountCents;
  }
  for (const x of amenity.collected) {
    const i = monthIndex.get(localDate(x.paidAt, tz).slice(0, 7));
    if (i !== undefined) incomeRows.get('amenities')![i]! += x.amountCents;
  }
  const costRows = new Map<string, number[]>();
  for (const x of spend) {
    const i = monthIndex.get(x.incurredOn.slice(0, 7));
    if (i === undefined) continue;
    if (!costRows.has(x.category)) costRows.set(x.category, blank());
    costRows.get(x.category)![i]! += x.amountCents;
  }
  const rowTotal = (by: number[]) => by.reduce((a, b) => a + b, 0);

  return {
    from: p.from,
    to: p.to,
    currency: loc.currency,
    previous: {
      from: prevFrom,
      to: prevTo,
      collectedCents: prevCollected + prevKept + prevAmenities,
      expensesCents: prevExpenses,
      netCents: prevCollected + prevKept + prevAmenities - prevExpenses,
    },
    incomeByKind: [...incomeRows.entries()].map(([kind, by]) => ({ kind, amountCents: rowTotal(by) })),
    profitLoss: {
      months,
      income: [...incomeRows.entries()].map(([kind, byMonth]) => ({ kind, byMonth, totalCents: rowTotal(byMonth) })),
      costs: [...costRows.entries()]
        .map(([category, byMonth]) => ({ category, byMonth, totalCents: rowTotal(byMonth) }))
        .sort((a, b) => b.totalCents - a.totalCents),
    },
    totals: {
      invoicedCents: invs.reduce((s, x) => s + x.totalCents, 0),
      collectedCents,
      expensesCents,
      netCents: collectedCents - expensesCents,
    },
    monthly: [...monthly.values()],
    expensesByCategory: group(spend, (r: { category: string }) => r.category).map(({ key, amountCents }) => ({ category: key, amountCents })),
    paymentsByMethod: group(pays, (r: { method: string }) => r.method).map(({ key, amountCents }) => ({ method: key, amountCents })),
    receivablesAging: aging,
    amenities: { owedCents: amenity.owedRows.reduce((s, x) => s + x.owedCents, 0), collectedCents: amenityCents, owedBy: amenity.owedRows },
    deposits: {
      heldCents,
      receivedCents: depositMoves.filter((x) => x.e.kind === 'received').reduce((s, x) => s + x.e.amountCents, 0),
      refundedCents: depositMoves.filter((x) => x.e.kind === 'refunded').reduce((s, x) => s + x.e.amountCents, 0),
      keptCents,
      advanceCents,
      movements: depositMoves.map(({ e, memberName, resourceName }) => ({
        id: e.id,
        contractId: e.contractId,
        kind: e.kind,
        amountCents: e.amountCents,
        method: e.method,
        reference: e.reference,
        occurredAt: e.occurredAt,
        memberName,
        resourceName,
      })),
    },
  };
}
