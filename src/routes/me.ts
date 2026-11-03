import { Router } from 'express';
import { and, asc, eq, gt, gte, inArray, isNull, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { attendance, bookings, invoices, plans, resources, visitors } from '../db/schema.js';
import { loadLocation, loadMember } from '../lib/access.js';
import { hasFeature } from '../lib/auth.js';
import { forbidden } from '../lib/errors.js';
import { dayRange, localDate, minutesBetween, monthRange, todayIn } from '../lib/time.js';
import { amenityOwed, listAmenityRequests, memberMenu } from '../services/amenities.js';
import { overstayers } from '../services/checkin.js';
import { withBalance } from '../services/billing.js';
import { isWholeDay } from '../services/bookings.js';

/** Self-service summary for the signed-in member. */
export function meRouter(db: Db) {
  const r = Router();

  r.get('/summary', async (req, res) => {
    const user = req.user!;
    if (!user.memberId) throw forbidden('Member accounts only');
    // A member's one location is known from their sign-in, so the member and the location load together; then everything else does.
    const [{ member }, loc] = await Promise.all([loadMember(db, user.memberId), loadLocation(db, user.locationIds[0]!)]);
    const now = new Date();
    const nowIso = now.toISOString();
    const today = todayIn(loc.timezone, now);
    const month = monthRange(today.slice(0, 7), loc.timezone);
    const [plan, checkedIn, upcoming, openRows, expectedVisitors, monthBookings, menu, amenityDueCents, amenityRequestList, overstay] = await Promise.all([
      member.planId ? db.select().from(plans).where(eq(plans.id, member.planId)).get() : Promise.resolve(undefined),
      db.select().from(attendance).where(and(eq(attendance.memberId, member.id), isNull(attendance.checkOutAt))).get(),
      db
        .select({ b: bookings, resourceName: resources.name, resourceKind: resources.kind, resourceOpen: resources.openTime, resourceClose: resources.closeTime })
        .from(bookings)
        .innerJoin(resources, eq(resources.id, bookings.resourceId))
        .where(and(eq(bookings.memberId, member.id), eq(bookings.status, 'confirmed'), gt(bookings.endsAt, nowIso)))
        .orderBy(asc(bookings.startsAt))
        .limit(5)
        .all(),
      // Invoices and visitors only exist for tenants whose package includes them.
      hasFeature(user, 'invoicing')
        ? db.select().from(invoices).where(and(eq(invoices.memberId, member.id), eq(invoices.status, 'open'))).orderBy(asc(invoices.dueDate)).all()
        : Promise.resolve([]),
      hasFeature(user, 'visitors')
        ? db
            .select()
            .from(visitors)
            .where(and(eq(visitors.hostMemberId, member.id), eq(visitors.status, 'expected'), gte(visitors.expectedAt, dayRange(today, loc.timezone).start)))
            .orderBy(asc(visitors.expectedAt))
            .limit(5)
            .all()
        : Promise.resolve([]),
      // Included meeting minutes consumed this month (live room bookings only).
      db
        .select({ startsAt: bookings.startsAt, endsAt: bookings.endsAt, billable: bookings.billableMinutes })
        .from(bookings)
        .innerJoin(resources, eq(resources.id, bookings.resourceId))
        .where(and(eq(bookings.memberId, member.id), eq(resources.kind, 'room'), inArray(bookings.status, ['confirmed', 'completed']), gte(bookings.startsAt, month.start), lt(bookings.startsAt, month.end)))
        .all(),
      memberMenu(db, member.id, loc.id, today),
      amenityOwed(db, member.id),
      listAmenityRequests(db, user, loc.id),
      overstayers(db, loc.id, member.id, now, loc),
    ]);
    const upcomingBookings = upcoming.map(({ b, resourceOpen, resourceClose, ...rest }) => ({ ...b, ...rest, allDay: isWholeDay(b, rest.resourceKind, resourceOpen ?? loc.openTime, resourceClose ?? loc.closeTime, loc.timezone) }));
    const open = openRows.map((i) => withBalance(i, today));
    const usedMinutes = monthBookings.reduce((s, b) => s + (minutesBetween(b.startsAt, b.endsAt) - b.billable), 0);

    res.json({
      member: { id: member.id, company: member.company, status: member.status, locationId: loc.id, locationName: loc.name },
      currency: loc.currency,
      timezone: loc.timezone,
      today: localDate(now, loc.timezone),
      plan: plan ?? null,
      meetingMinutes: { included: (plan?.includedMeetingMinutes ?? 0) + member.meetingCredits * 30, used: usedMinutes },
      amenities: menu,
      amenityDueCents,
      amenityRequests: amenityRequestList.slice(0, 8),
      overstay: overstay[0] ?? null,
      checkedIn: checkedIn ?? null,
      upcomingBookings,
      openInvoices: open,
      balanceDueCents: open.reduce((s, i) => s + i.balanceCents, 0),
      overdueCents: open.filter((i) => i.overdue).reduce((s, i) => s + i.balanceCents, 0),
      expectedVisitors,
    });
  });

  return r;
}
