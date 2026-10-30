import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { amenityOrders, attendance, bookings, contractPeople, contracts, depositEntries, deviceUsers, devicePunches, invoiceItems, invoices, issues, memberDesks, memberShifts, members, payments, resourceAssignments, roomRequests, users, visitors } from '../db/schema.js';
import { loadMember } from '../lib/access.js';
import { assertLocation, type AuthUser } from '../lib/auth.js';
import { conflict } from '../lib/errors.js';
import { syncUser } from './devices.js';

const count = async (q: PromiseLike<{ n: number }[]>) => (await q)[0]?.n ?? 0;

/**
 * Deletes a member who was added by mistake, along with what was made for them (their plan bookings, shifts, desks, requests and
 * any unpaid invoice). Anyone with history that has to be kept (check-ins, payments, contracts, visitors, reported problems or an
 * invoice that was paid) cannot be deleted: cancelling their membership keeps those records and closes the account.
 */
export async function deleteMember(db: Db, actor: AuthUser, memberId: string) {
  const { member, user } = await loadMember(db, memberId);
  assertLocation(actor, member.locationId);

  const kept: string[] = [];
  const check = async (label: string, n: Promise<number>) => {
    if ((await n) > 0) kept.push(label);
  };
  await check('check-ins', count(db.select({ n: sql<number>`count(*)` }).from(attendance).where(eq(attendance.memberId, member.id)).all()));
  await check('payments', count(db.select({ n: sql<number>`count(*)` }).from(payments).where(eq(payments.memberId, member.id)).all()));
  await check('an advance or security deposit', count(db.select({ n: sql<number>`count(*)` }).from(depositEntries).where(eq(depositEntries.memberId, member.id)).all()));
  await check('amenities given', count(db.select({ n: sql<number>`count(*)` }).from(amenityOrders).where(eq(amenityOrders.memberId, member.id)).all()));
  await check('contracts', count(db.select({ n: sql<number>`count(*)` }).from(contracts).where(eq(contracts.memberId, member.id)).all()));
  await check('a company contract', count(db.select({ n: sql<number>`count(*)` }).from(contractPeople).where(eq(contractPeople.memberId, member.id)).all()));
  await check('assigned spaces', count(db.select({ n: sql<number>`count(*)` }).from(resourceAssignments).where(eq(resourceAssignments.memberId, member.id)).all()));
  await check('visitors', count(db.select({ n: sql<number>`count(*)` }).from(visitors).where(eq(visitors.hostMemberId, member.id)).all()));
  await check('reported problems', count(db.select({ n: sql<number>`count(*)` }).from(issues).where(eq(issues.reportedById, user.id)).all()));
  await check('invoices that were paid or settled', count(db.select({ n: sql<number>`count(*)` }).from(invoices).where(and(eq(invoices.memberId, member.id), or(ne(invoices.status, 'open'), sql`${invoices.paidCents} > 0`))).all()));
  if (kept.length) throw conflict(`${user.name} has ${kept.join(', ')}, which have to be kept. Cancel their membership instead: they lose access and the records stay.`);

  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const unpaid = (await t.select({ id: invoices.id }).from(invoices).where(eq(invoices.memberId, member.id)).all()).map((i) => i.id);
    if (unpaid.length) {
      await t.delete(invoiceItems).where(inArray(invoiceItems.invoiceId, unpaid)).run();
      await t.delete(invoices).where(inArray(invoices.id, unpaid)).run();
    }
    await t.delete(bookings).where(eq(bookings.memberId, member.id)).run();
    await t.delete(roomRequests).where(eq(roomRequests.memberId, member.id)).run();
    await t.delete(memberShifts).where(eq(memberShifts.memberId, member.id)).run();
    await t.delete(memberDesks).where(eq(memberDesks.memberId, member.id)).run();
    await t.delete(deviceUsers).where(eq(deviceUsers.userId, user.id)).run();
    await t.update(devicePunches).set({ userId: null }).where(eq(devicePunches.userId, user.id)).run();
    await t.delete(members).where(eq(members.id, member.id)).run();
    await t.delete(users).where(eq(users.id, user.id)).run();
  });
  // Attendance devices drop them.
  await syncUser(db, user.id).catch(() => undefined);
}
