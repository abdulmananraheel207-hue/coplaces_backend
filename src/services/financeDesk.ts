import { and, desc, eq, gte, inArray, isNotNull, lt, lte, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { contracts, depositEntries, expenses, invoices, memberShifts, members, payments, plans, resources, shiftTemplates, users } from '../db/schema.js';
import { loadLocation } from '../lib/access.js';
import { addDays, daysBetween, todayIn, zonedToUtc } from '../lib/time.js';
import * as core from './financeCore.js';
import { loadBooks } from './financeBooks.js';

/**
 * The parts of the finance screen about customers and channels, rather than about income:
 * - renewals: who is due to leave in the next 30, 60 and 90 days, and what they pay a month (revenue at risk);
 * - churn: who was won and who was lost in a period;
 * - a channel's own book: every movement through cash, card, online transfer or cheque.
 */

/** A customer: one contract (single or company), or one member on a plan with shifts. What they pay a month comes from what is billed today. */
interface Customer {
  kind: 'contract' | 'company' | 'plan';
  id: string;
  memberId: string;
  contractId: string | null;
  name: string;
  company: string;
  space: string;
  startDate: string;
  endDate: string | null;
  monthlyCents: number;
  depositHeldCents: number;
  /** Still running on the books (contract active, member active), whatever its end date. */
  running: boolean;
  /** Running and not past its end. */
  active: boolean;
}

async function customers(db: Db, locationId: string, today: string): Promise<Customer[]> {
  const [cs, ms, shiftPrices] = await Promise.all([
    db
      .select({ c: contracts, name: users.name, space: resources.name })
      .from(contracts)
      .innerJoin(members, eq(members.id, contracts.memberId))
      .innerJoin(users, eq(users.id, members.userId))
      .leftJoin(resources, eq(resources.id, contracts.resourceId))
      .where(and(eq(contracts.locationId, locationId), inArray(contracts.status, ['active', 'ended'])))
      .all(),
    db
      .select({ m: members, name: users.name, plan: plans.name })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .leftJoin(plans, eq(plans.id, members.planId))
      .where(and(eq(members.locationId, locationId), isNotNull(members.planEnd)))
      .all(),
    db
      .select({ memberId: memberShifts.memberId, v: sql<number>`coalesce(sum(${shiftTemplates.priceCents}), 0)` })
      .from(memberShifts)
      .innerJoin(shiftTemplates, eq(shiftTemplates.id, memberShifts.shiftId))
      .innerJoin(members, eq(members.id, memberShifts.memberId))
      .where(eq(members.locationId, locationId))
      .groupBy(memberShifts.memberId)
      .all(),
  ]);
  const onContract = new Set(cs.filter((x) => x.c.status === 'active').map((x) => x.c.memberId));
  return [
    ...cs.map(({ c, name, space }) => ({
      kind: c.companyName ? ('company' as const) : ('contract' as const),
      id: c.id,
      memberId: c.memberId,
      contractId: c.id,
      name: c.companyName || name,
      company: c.companyName,
      space: space ?? '',
      startDate: c.startDate,
      endDate: c.endDate,
      monthlyCents: c.rentCents,
      depositHeldCents: c.depositStatus === 'held' ? c.depositCents : 0,
      running: c.status === 'active',
      active: c.status === 'active' && (!c.endDate || c.endDate >= today),
    })),
    // A member on a plan with shifts and no running contract: their period's end is when they leave unless they renew.
    ...ms
      .filter(({ m }) => !onContract.has(m.id))
      .map(({ m, name, plan }) => ({
        kind: 'plan' as const,
        id: m.id,
        memberId: m.id,
        contractId: null,
        name,
        company: m.company,
        space: plan ?? '',
        startDate: m.startDate,
        endDate: m.planEnd,
        monthlyCents: shiftPrices.find((s) => s.memberId === m.id)?.v ?? 0,
        depositHeldCents: m.depositStatus === 'held' ? m.depositCents : 0,
        running: m.status === 'active',
        active: m.status === 'active' && !!m.planEnd && m.planEnd >= today,
      })),
  ];
}

/**
 * Contracts and plan periods ending in the next 90 days, soonest first, each in the 30, 60 or 90 day group, with what they pay a month
 * and the deposit that will need settling. Ones that already passed their end but are still running are shown as overdue (group 0).
 */
export async function renewals(db: Db, locationId: string, now = new Date()) {
  const loc = await loadLocation(db, locationId);
  const today = todayIn(loc.timezone, now);
  const horizon = addDays(today, 90);
  const all = await customers(db, locationId, today);
  const due = all
    .filter((c) => c.running && c.endDate && c.endDate <= horizon && c.endDate >= addDays(today, -30))
    .map((c) => {
      const daysLeft = daysBetween(today, c.endDate!);
      return { ...c, daysLeft, within: daysLeft < 0 ? 0 : daysLeft <= 30 ? 30 : daysLeft <= 60 ? 60 : 90 };
    })
    .sort((a, b) => a.endDate!.localeCompare(b.endDate!));
  const group = (n: number) => {
    const list = due.filter((d) => d.within === n);
    return { count: list.length, monthlyCents: list.reduce((s, x) => s + x.monthlyCents, 0) };
  };
  return { today, overdue: group(0), in30: group(30), in60: group(60), in90: group(90), rows: due };
}

/**
 * Customers won and lost in a period of local days. Lost: a contract or plan period that ended in the period, on or before today, and was
 * not extended or renewed (its end date would have moved). Won: one that started in the period. The rate is lost over those running on
 * the first day. Lost monthly revenue is what the lost ones paid a month.
 */
export async function churn(db: Db, locationId: string, from: string, to: string, now = new Date()) {
  const loc = await loadLocation(db, locationId);
  const today = todayIn(loc.timezone, now);
  const all = await customers(db, locationId, today);
  const lastDay = to < today ? to : addDays(today, -1);
  const lost = all.filter((c) => c.endDate && c.endDate >= from && c.endDate <= lastDay && !c.active);
  const won = all.filter((c) => c.startDate >= from && c.startDate <= to);
  const atStart = all.filter((c) => c.startDate < from && (!c.endDate || c.endDate >= from)).length;
  const brief = (c: Customer) => ({ kind: c.kind, id: c.id, memberId: c.memberId, contractId: c.contractId, name: c.name, space: c.space, startDate: c.startDate, endDate: c.endDate, monthlyCents: c.monthlyCents });
  return {
    from,
    to,
    atStart,
    activeNow: all.filter((c) => c.active).length,
    lostCount: lost.length,
    wonCount: won.length,
    lostMonthlyCents: lost.reduce((s, c) => s + c.monthlyCents, 0),
    wonMonthlyCents: won.reduce((s, c) => s + c.monthlyCents, 0),
    /** Lost over those running on the first day, as a percentage with one decimal; null when nobody was. */
    churnPct: atStart > 0 ? Math.round((lost.length / atStart) * 1000) / 10 : null,
    lost: lost.map(brief).sort((a, b) => (b.endDate ?? '').localeCompare(a.endDate ?? '')),
    won: won.map(brief).sort((a, b) => b.startDate.localeCompare(a.startDate)),
  };
}

/** Cheques still waiting to clear at a location, with what they come to. */
export async function pendingCheques(db: Db, locationId: string) {
  const [p, e] = await Promise.all([
    db.select({ n: sql<number>`count(*)`, v: sql<number>`coalesce(sum(${payments.amountCents}), 0)` }).from(payments).where(and(eq(payments.locationId, locationId), eq(payments.status, 'pending'))).get(),
    db.select({ n: sql<number>`count(*)`, v: sql<number>`coalesce(sum(${depositEntries.amountCents}), 0)` }).from(depositEntries).where(and(eq(depositEntries.locationId, locationId), eq(depositEntries.status, 'pending'))).get(),
  ]);
  return { count: (p?.n ?? 0) + (e?.n ?? 0), amountCents: (p?.v ?? 0) + (e?.v ?? 0) };
}

/** Every expense at a location up to a day, with how it was paid: for the till and bank balances. */
export const expensesUpTo = (db: Db, locationId: string, to: string) =>
  db.select({ amountCents: expenses.amountCents, method: expenses.method, incurredOn: expenses.incurredOn }).from(expenses).where(and(eq(expenses.locationId, locationId), lte(expenses.incurredOn, to))).all();

/**
 * One channel's book for a period: what came in and went out through it, and every movement, newest first. Pending and bounced
 * cheques are listed (marked) but counted in nothing. The balance is the till (cash) or this channel's share of the bank at the end.
 */
export async function channelBook(db: Db, p: { locationId: string; method: core.Channel; from: string; to: string }) {
  const loc = await loadLocation(db, p.locationId);
  const tz = loc.timezone;
  const start = zonedToUtc(p.from, '00:00', tz).toISOString();
  const end = zonedToUtc(addDays(p.to, 1), '00:00', tz).toISOString();
  const effectivePaid = sql<string>`coalesce(${payments.clearedAt}, ${payments.paidAt})`;
  const effectiveEntry = sql<string>`coalesce(${depositEntries.clearedAt}, ${depositEntries.occurredAt})`;
  const [books, spendAll, pays, entries, spent] = await Promise.all([
    loadBooks(db, p.locationId),
    expensesUpTo(db, p.locationId, p.to),
    db
      .select({ x: payments, number: invoices.number, name: users.name })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .innerJoin(members, eq(members.id, payments.memberId))
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(payments.locationId, p.locationId), eq(payments.method, p.method), gte(effectivePaid, start), lt(effectivePaid, end)))
      .orderBy(desc(effectivePaid))
      .limit(1000)
      .all(),
    db
      .select({ x: depositEntries, company: contracts.companyName, contractMember: contracts.memberId })
      .from(depositEntries)
      .leftJoin(contracts, eq(contracts.id, depositEntries.contractId))
      .where(and(eq(depositEntries.locationId, p.locationId), eq(depositEntries.method, p.method), ne(depositEntries.kind, 'kept'), gte(effectiveEntry, start), lt(effectiveEntry, end)))
      .orderBy(desc(effectiveEntry))
      .limit(1000)
      .all(),
    db
      .select()
      .from(expenses)
      .where(and(eq(expenses.locationId, p.locationId), eq(expenses.method, p.method), gte(expenses.incurredOn, p.from), lte(expenses.incurredOn, p.to)))
      .orderBy(desc(expenses.incurredOn))
      .limit(1000)
      .all(),
  ]);
  const ids = [...new Set(entries.map((e) => e.x.memberId ?? e.contractMember).filter((x): x is string => !!x))];
  const names = ids.length ? await db.select({ id: members.id, name: users.name }).from(members).innerJoin(users, eq(users.id, members.userId)).where(inArray(members.id, ids)).all() : [];
  const nameOf = (id: string | null | undefined) => names.find((n) => n.id === id)?.name ?? '';

  const flow = core.channelFlows(books, spendAll, { start, end }, { from: p.from, to: p.to }).find((f) => f.method === p.method)!;
  const balances = core.balancesAsOf(books, spendAll, end, p.to);
  const ENTRY_LABEL = { advance: 'Advance received', received: 'Security deposit received', refunded: 'Security deposit returned', advance_refund: 'Advance returned' } as const;
  const rows = [
    ...pays.map(({ x, number, name }) => ({
      kind: x.amountCents < 0 ? ('reversal' as const) : ('payment' as const),
      id: x.id,
      at: x.clearedAt ?? x.paidAt,
      receivedAt: x.paidAt,
      label: x.amountCents < 0 ? `Payment taken back, invoice ${number}` : `Payment, invoice ${number}`,
      who: name,
      memberId: x.memberId,
      invoiceId: x.invoiceId,
      contractId: null as string | null,
      reference: x.reference,
      amountCents: x.amountCents,
      status: x.status,
    })),
    ...entries.map(({ x, company, contractMember }) => {
      const out = x.kind === 'refunded' || x.kind === 'advance_refund';
      return {
        kind: (out ? 'refund' : x.kind === 'received' ? 'deposit' : 'advance') as 'refund' | 'deposit' | 'advance',
        id: x.id,
        at: x.clearedAt ?? x.occurredAt,
        receivedAt: x.occurredAt,
        label: ENTRY_LABEL[x.kind as keyof typeof ENTRY_LABEL],
        who: company || nameOf(x.memberId ?? contractMember),
        memberId: x.memberId ?? contractMember ?? null,
        invoiceId: null as string | null,
        contractId: x.contractId,
        reference: x.reference,
        amountCents: out ? -x.amountCents : x.amountCents,
        status: x.status,
      };
    }),
    ...spent.map((x) => ({
      kind: 'expense' as const,
      id: x.id,
      at: zonedToUtc(x.incurredOn, '12:00', tz).toISOString(),
      receivedAt: zonedToUtc(x.incurredOn, '12:00', tz).toISOString(),
      label: `Expense: ${x.category.replace(/_/g, ' ')}${x.description ? `, ${x.description}` : ''}`,
      who: x.vendor,
      memberId: null as string | null,
      invoiceId: null as string | null,
      contractId: null as string | null,
      reference: x.reference,
      amountCents: -x.amountCents,
      status: 'cleared' as const,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const waiting = rows.filter((r) => r.status === 'pending');
  return {
    from: p.from,
    to: p.to,
    currency: loc.currency,
    ...flow,
    balanceEndCents: balances.byChannel[p.method],
    cashInHandCents: balances.cashInHandCents,
    bankCents: balances.bankCents,
    pending: { count: waiting.length, amountCents: waiting.reduce((s, r) => s + r.amountCents, 0) },
    rows,
  };
}
