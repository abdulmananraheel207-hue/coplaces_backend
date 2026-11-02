import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  attendance,
  bookings,
  contracts,
  depositEntries,
  expenses,
  invoices,
  memberShifts,
  members,
  payments,
  plans,
  resourceAssignments,
  resources,
  shiftTemplates,
  users,
  visitors,
} from '../db/schema.js';
import { isHourly } from '../catalogue.js';
import { amenityFinance } from './amenities.js';
import { overstayers } from './checkin.js';
import { loadLocation } from '../lib/access.js';
import * as core from './financeCore.js';
import { loadBooks, unappliedOf } from './financeBooks.js';
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
    overstaying: await overstayers(db, locationId, undefined, now),
  };

  let finance = null;
  if (includeFinance) {
    const books = await loadBooks(db, locationId);
    const w = { start: month.start, end: month.end };
    const thisMonth = { from: month.firstDay, to: addDays(month.nextFirstDay, -1) };
    const spent = (await db
      .select({ v: sumOf(expenses.amountCents) })
      .from(expenses)
      .where(and(eq(expenses.locationId, locationId), gte(expenses.incurredOn, month.firstDay), lt(expenses.incurredOn, month.nextFirstDay)))
      .get())!.v;
    const open = books.invoices.filter((i) => i.status === 'open' && i.dueDate < today);
    finance = {
      mrrCents: await monthlyRecurring(db, locationId, today),
      collectedThisMonthCents: core.collectedCents(books, w),
      invoicedThisMonthCents: core.billedCents(books.invoices, books.lines, thisMonth),
      taxCollectedThisMonthCents: core.taxCollectedCents(books, w),
      expensesThisMonthCents: spent,
      outstandingCents: core.outstandingCents(books.invoices),
      overdueCents: core.overdueCents(books.invoices, today),
      overdueCount: open.length,
    };
  }

  return { today, currency: loc.currency, ops, finance };
}

/**
 * Monthly recurring income to expect, as of today: each active member's monthly plan (the sum of their shifts' prices, or a plan from
 * before shifts its own price) while their plan period has not lapsed, and the monthly rent of every contract running today.
 */
async function monthlyRecurring(db: Db, locationId: string, today: string) {
  const onShifts = await db
    .select({ memberId: memberShifts.memberId, price: shiftTemplates.priceCents, planEnd: members.planEnd })
    .from(memberShifts)
    .innerJoin(shiftTemplates, eq(shiftTemplates.id, memberShifts.shiftId))
    .innerJoin(members, eq(members.id, memberShifts.memberId))
    .innerJoin(plans, eq(plans.id, members.planId))
    .where(and(eq(members.locationId, locationId), eq(members.status, 'active'), eq(plans.interval, 'month')))
    .all();
  const withShifts = new Set(onShifts.map((x) => x.memberId));
  const legacy = await db
    .select({ id: members.id, price: plans.priceCents })
    .from(members)
    .innerJoin(plans, eq(plans.id, members.planId))
    .where(and(eq(members.locationId, locationId), eq(members.status, 'active'), eq(plans.interval, 'month'), isNull(members.planStart)))
    .all();
  const rent = (await db.select().from(contracts).where(and(eq(contracts.locationId, locationId), eq(contracts.status, 'active'))).all()).filter(
    (c) => c.startDate <= today && (!c.endDate || c.endDate >= today),
  );
  return (
    onShifts.filter((x) => !x.planEnd || x.planEnd >= today).reduce((s, x) => s + (x.price ?? 0), 0) +
    legacy.filter((x) => !withShifts.has(x.id)).reduce((s, x) => s + x.price, 0) +
    rent.reduce((s, c) => s + c.rentCents, 0)
  );
}

/** The longest range a finance report or chart covers, in months. */
export const MAX_REPORT_MONTHS = 240;

const monthsOf = (from: string, to: string) => {
  const out: string[] = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = addMonths(m, 1)) out.push(m);
  return out;
};

/**
 * The finance report for a range of local days. Every figure comes from financeCore over the location's books, so it agrees with the
 * Today page, the charts, the invoice and payment lists and every member's balance.
 *
 * - Money in (`collectedCents`) is cash basis: invoice payments when made (a reversal when taken back), advances when received,
 *   deposits when kept, old-style desk amenity collections. `paymentsByMethod` covers all of it.
 * - Income (`incomeCents`, the profit and loss) is money in less the tax inside the payments (`taxCollectedCents`), shared over what
 *   was sold. `incomeByKind` and the profit and loss use the five kinds the screens draw; `incomeByCategory` is the finer split.
 * - Invoiced is what members were billed, including the part an advance paid.
 * - Aging and deposits held are as of the report's end date.
 */
export async function financeReport(db: Db, p: { locationId: string; from: string; to: string }, now = new Date()) {
  const loc = await loadLocation(db, p.locationId);
  const tz = loc.timezone;
  const window = (from: string, to: string) => ({ start: zonedToUtc(from, '00:00', tz).toISOString(), end: zonedToUtc(addDays(to, 1), '00:00', tz).toISOString() });
  const w = window(p.from, p.to);
  const books = await loadBooks(db, p.locationId);
  const months = monthsOf(p.from, p.to);
  const monthOf = (iso: string) => localDate(iso, tz).slice(0, 7);
  const index = new Map(months.map((m, i) => [m, i]));
  const blank = () => months.map(() => 0);
  const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  const spend = await db
    .select({ amountCents: expenses.amountCents, category: expenses.category, incurredOn: expenses.incurredOn })
    .from(expenses)
    .where(and(eq(expenses.locationId, p.locationId), gte(expenses.incurredOn, p.from), lte(expenses.incurredOn, p.to)))
    .all();
  const income = core.incomeEntries(books, w);
  const collectedCents = core.collectedCents(books, w);
  const taxCents = core.taxCollectedCents(books, w);
  const expensesCents = total(spend.map((x) => x.amountCents));
  const tax = core.paymentTaxCents(books.invoices, books.payments);

  // Month by month: money in, billed, money out, net (cash).
  const monthly = months.map((month) => {
    const end = addDays(`${addMonths(month, 1)}-01`, -1);
    const a = month === p.from.slice(0, 7) ? p.from : `${month}-01`;
    const b = end > p.to ? p.to : end;
    const collected = core.collectedCents(books, window(a, b));
    const spent = total(spend.filter((x) => x.incurredOn >= a && x.incurredOn <= b).map((x) => x.amountCents));
    return { month, collectedCents: collected, invoicedCents: core.billedCents(books.invoices, books.lines, { from: a, to: b }), expensesCents: spent, netCents: collected - spent };
  });

  // Profit and loss: income before tax by kind, tax, and costs by category, month by month.
  const KINDS: core.IncomeKind[] = ['subscription', 'manual', 'kept_deposit', 'advance', 'amenities'];
  const incomeRows = new Map(KINDS.map((k) => [k, blank()]));
  const categoryRows = new Map<core.IncomeCategory, number[]>();
  for (const e of income) {
    const i = index.get(monthOf(e.at));
    if (i === undefined) continue;
    incomeRows.get(core.INCOME_KIND[e.category])![i]! += e.amountCents;
    if (!categoryRows.has(e.category)) categoryRows.set(e.category, blank());
    categoryRows.get(e.category)![i]! += e.amountCents;
  }
  const taxRow = blank();
  for (const pay of books.payments) {
    const i = index.get(monthOf(pay.paidAt));
    if (i !== undefined && pay.paidAt >= w.start && pay.paidAt < w.end) taxRow[i]! += tax.get(pay.id) ?? 0;
  }
  const costRows = new Map<string, number[]>();
  for (const x of spend) {
    const i = index.get(x.incurredOn.slice(0, 7));
    if (i === undefined) continue;
    if (!costRows.has(x.category)) costRows.set(x.category, blank());
    costRows.get(x.category)![i]! += x.amountCents;
  }
  const incomeCents = collectedCents - taxCents;

  // The period just before, as long as this one, on the same definitions.
  const span = daysBetween(p.from, p.to) + 1;
  const prevTo = addDays(p.from, -1);
  const prevFrom = addDays(p.from, -span);
  const pw = window(prevFrom, prevTo);
  const prevCollected = core.collectedCents(books, pw);
  const prevExpenses = (await db
    .select({ v: sumOf(expenses.amountCents) })
    .from(expenses)
    .where(and(eq(expenses.locationId, p.locationId), gte(expenses.incurredOn, prevFrom), lte(expenses.incurredOn, prevTo)))
    .get())!.v;

  // Deposits: what moved in the range, and what is held at its end.
  const depositMoves = await db
    .select({ e: depositEntries, memberName: users.name, resourceName: resources.name })
    .from(depositEntries)
    .leftJoin(contracts, eq(contracts.id, depositEntries.contractId))
    .innerJoin(members, eq(members.id, sql`coalesce(${depositEntries.memberId}, ${contracts.memberId})`))
    .innerJoin(users, eq(users.id, members.userId))
    .leftJoin(resources, eq(resources.id, contracts.resourceId))
    .where(and(eq(depositEntries.locationId, p.locationId), gte(depositEntries.occurredAt, w.start), lt(depositEntries.occurredAt, w.end)))
    .orderBy(desc(depositEntries.occurredAt))
    .all();
  const moved = (kind: string) => total(depositMoves.filter((x) => x.e.kind === kind).map((x) => x.e.amountCents));

  const amenity = await amenityFinance(db, p.locationId, w.start, w.end);
  const unapplied = await unappliedOf(db, p.locationId);
  const byCategory = (key: core.IncomeCategory) => total(income.filter((e) => e.category === key).map((e) => e.amountCents));

  return {
    from: p.from,
    to: p.to,
    currency: loc.currency,
    previous: { from: prevFrom, to: prevTo, collectedCents: prevCollected, expensesCents: prevExpenses, netCents: prevCollected - prevExpenses },
    incomeByKind: KINDS.map((kind) => ({ kind, amountCents: total(incomeRows.get(kind)!) })),
    incomeByCategory: [...categoryRows.entries()].map(([category, byMonth]) => ({ category, amountCents: total(byMonth) })).sort((a, b) => b.amountCents - a.amountCents),
    profitLoss: {
      months,
      income: KINDS.map((kind) => ({ kind, byMonth: incomeRows.get(kind)!, totalCents: total(incomeRows.get(kind)!) })),
      tax: { byMonth: taxRow, totalCents: total(taxRow) },
      costs: [...costRows.entries()].map(([category, byMonth]) => ({ category, byMonth, totalCents: total(byMonth) })).sort((a, b) => b.totalCents - a.totalCents),
    },
    totals: {
      invoicedCents: core.billedCents(books.invoices, books.lines, { from: p.from, to: p.to }),
      collectedCents,
      taxCollectedCents: taxCents,
      incomeCents,
      expensesCents,
      netCents: collectedCents - expensesCents,
      profitCents: incomeCents - expensesCents,
    },
    monthly,
    expensesByCategory: [...costRows.entries()].map(([category, byMonth]) => ({ category, amountCents: total(byMonth) })).sort((a, b) => b.amountCents - a.amountCents),
    paymentsByMethod: core.moneyInByMethod(books, w),
    asOf: p.to,
    receivablesAging: core.agingAsOf(books.invoices, books.payments, p.to, tz),
    amenities: { owedCents: amenity.owedRows.reduce((s, x) => s + x.owedCents, 0), collectedCents: byCategory('amenity'), owedBy: amenity.owedRows },
    unapplied: { advancesCents: core.advancesUnappliedCents(unapplied), creditsCents: core.creditsUnappliedCents(unapplied.members) },
    deposits: {
      heldCents: core.depositsHeldAsOf(books.ledger, p.to, tz),
      receivedCents: moved('received'),
      refundedCents: moved('refunded'),
      keptCents: moved('kept'),
      advanceCents: moved('advance'),
      movements: depositMoves.map(({ e, memberName, resourceName }) => ({
        id: e.id,
        contractId: e.contractId,
        memberId: e.memberId,
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

/**
 * Month-by-month series for the finance charts, on the same definitions as the report: billed and collected, collection rate, tax,
 * income by category, money in by method, costs by category, and what was owed, overdue and held as deposits at each month end; plus
 * invoices by status, the biggest debtors and income by space and by plan for the whole range.
 */
export async function financeCharts(db: Db, p: { locationId: string; from: string; to: string }, now = new Date()) {
  const loc = await loadLocation(db, p.locationId);
  const tz = loc.timezone;
  const window = (from: string, to: string) => ({ start: zonedToUtc(from, '00:00', tz).toISOString(), end: zonedToUtc(addDays(to, 1), '00:00', tz).toISOString() });
  const books = await loadBooks(db, p.locationId);
  const today = todayIn(tz, now);
  const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const spend = await db
    .select({ amountCents: expenses.amountCents, category: expenses.category, incurredOn: expenses.incurredOn })
    .from(expenses)
    .where(and(eq(expenses.locationId, p.locationId), gte(expenses.incurredOn, p.from), lte(expenses.incurredOn, p.to)))
    .all();

  const months = monthsOf(p.from, p.to).map((month) => {
    const end = addDays(`${addMonths(month, 1)}-01`, -1);
    const a = month === p.from.slice(0, 7) ? p.from : `${month}-01`;
    const b = end > p.to ? p.to : end;
    const w = window(a, b);
    const billed = core.billedCents(books.invoices, books.lines, { from: a, to: b });
    const collected = core.collectedCents(books, w);
    const income = core.incomeEntries(books, w);
    const categories: Record<string, number> = {};
    for (const e of income) categories[e.category] = (categories[e.category] ?? 0) + e.amountCents;
    const costs: Record<string, number> = {};
    for (const x of spend.filter((s) => s.incurredOn >= a && s.incurredOn <= b)) costs[x.category] = (costs[x.category] ?? 0) + x.amountCents;
    const asOf = b < today ? b : today;
    return {
      month,
      billedCents: billed,
      collectedCents: collected,
      collectionRate: billed > 0 ? Math.round((collected / billed) * 1000) / 1000 : null,
      taxCollectedCents: core.taxCollectedCents(books, w),
      expensesCents: total(Object.values(costs)),
      incomeByCategory: categories,
      expensesByCategory: costs,
      moneyInByMethod: Object.fromEntries(core.moneyInByMethod(books, w).map((m) => [m.method, m.amountCents])),
      outstandingEndCents: core.outstandingAsOf(books.invoices, books.payments, asOf, tz),
      overdueEndCents: core.overdueAsOf(books.invoices, books.payments, asOf, tz),
      depositsHeldEndCents: core.depositsHeldAsOf(books.ledger, asOf, tz),
    };
  });

  const w = window(p.from, p.to);
  const income = core.incomeEntries(books, w);
  const sumBy = (key: 'resourceId' | 'planId') => {
    const by = new Map<string, number>();
    for (const e of income) if (e[key]) by.set(e[key]!, (by.get(e[key]!) ?? 0) + e.amountCents);
    return by;
  };
  const bySpace = sumBy('resourceId');
  const byPlan = sumBy('planId');
  const spaceNames = bySpace.size ? await db.select({ id: resources.id, name: resources.name, kind: resources.kind }).from(resources).where(inArray(resources.id, [...bySpace.keys()])).all() : [];
  const planNames = byPlan.size ? await db.select({ id: plans.id, name: plans.name }).from(plans).where(inArray(plans.id, [...byPlan.keys()])).all() : [];
  const end = p.to < today ? p.to : today;
  const debtors = core.topDebtors(books.invoices, books.payments, end, tz);
  const names = debtors.length
    ? await db.select({ id: members.id, name: users.name, company: members.company }).from(members).innerJoin(users, eq(users.id, members.userId)).where(inArray(members.id, debtors.map((d) => d.memberId))).all()
    : [];

  return {
    from: p.from,
    to: p.to,
    currency: loc.currency,
    months,
    invoicesByStatus: core.invoicesByStatus(books.invoices, { from: p.from, to: p.to }, today),
    topDebtors: debtors.map((d) => ({ ...d, name: names.find((n) => n.id === d.memberId)?.name ?? '', company: names.find((n) => n.id === d.memberId)?.company ?? '' })),
    incomeBySpace: [...bySpace.entries()].map(([id, amountCents]) => ({ resourceId: id, name: spaceNames.find((s) => s.id === id)?.name ?? '', kind: spaceNames.find((s) => s.id === id)?.kind ?? '', amountCents })).sort((a, b) => b.amountCents - a.amountCents),
    incomeByPlan: [...byPlan.entries()].map(([id, amountCents]) => ({ planId: id, name: planNames.find((s) => s.id === id)?.name ?? '', amountCents })).sort((a, b) => b.amountCents - a.amountCents),
  };
}
