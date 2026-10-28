import { Router } from 'express';
import { and, desc, eq, gte, inArray, isNull, lt, lte, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { attendance, bookings, members, resourceAssignments, resources, staffAttendance, users } from '../db/schema.js';
import { assertMemberAccess, loadLocation, loadMember, requireLocationId } from '../lib/access.js';
import { assertLocation, isStaff, managerUp, staffOnly } from '../lib/auth.js';
import { assertCan } from '../lib/permissions.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { idParam, queryString } from '../lib/http.js';
import { dayRange, isValidDate, todayIn } from '../lib/time.js';
import { parse } from '../lib/validate.js';
import { checkInMember, closeStaleVisits, finishBookingOnCheckOut } from '../services/checkin.js';

export function attendanceRouter(db: Db) {
  const r = Router();

  const select = () =>
    db
      .select({ a: attendance, memberName: users.name, company: members.company, resourceName: resources.name })
      .from(attendance)
      .innerJoin(members, eq(members.id, attendance.memberId))
      .innerJoin(users, eq(users.id, members.userId))
      .leftJoin(resources, eq(resources.id, attendance.resourceId));

  // Staff: a day's log, or only who is in the building right now with ?open=1.
  r.get('/', staffOnly, async (req, res) => {
    const locationId = requireLocationId(req);
    const loc = await loadLocation(db, locationId);
    const conds = [eq(attendance.locationId, locationId)];
    if (queryString(req, 'open') === '1') {
      await closeStaleVisits(db, locationId);
      conds.push(isNull(attendance.checkOutAt));
    } else {
      const date = queryString(req, 'date') ?? todayIn(loc.timezone);
      if (!isValidDate(date)) throw badRequest('date must be YYYY-MM-DD');
      const range = dayRange(date, loc.timezone);
      conds.push(gte(attendance.checkInAt, range.start), lt(attendance.checkInAt, range.end));
    }
    const rows = await select().where(and(...conds)).orderBy(desc(attendance.checkInAt)).limit(500).all();
    res.json(rows.map(({ a, ...rest }) => ({ ...a, ...rest })));
  });

  r.post('/check-in', async (req, res) => {
    const body = parse(z.object({ memberId: z.string().optional(), resourceId: z.string().nullable().default(null) }), req.body);
    const user = req.user!;
    if (isStaff(user) && body.memberId) assertCan(user, 'front_desk');
    const memberId = isStaff(user) ? body.memberId : user.memberId;
    if (!memberId) throw badRequest('memberId is required');
    const { member } = await loadMember(db, memberId);
    assertMemberAccess(user, member);
    if (member.status !== 'active') throw badRequest('Only active members can check in');

    const row = await checkInMember(db, member, body.resourceId);
    res.status(201).json(row);
  });

  r.post('/:id/check-out', async (req, res) => {
    const row = await db.select().from(attendance).where(eq(attendance.id, idParam(req))).get();
    if (!row) throw notFound('Check-in');
    const user = req.user!;
    if (isStaff(user)) {
      assertCan(user, 'front_desk');
      assertLocation(user, row.locationId);
    } else if (user.memberId !== row.memberId) throw forbidden();
    if (row.checkOutAt) throw conflict('Already checked out');
    const out = await db.update(attendance).set({ checkOutAt: new Date().toISOString() }).where(eq(attendance.id, row.id)).returning().get();
    await finishBookingOnCheckOut(db, row);
    res.json(out);
  });

  // The team's clock-ins from attendance devices on a day. One left open from an earlier day is a missed clock-out.
  r.get('/staff', managerUp, async (req, res) => {
    const locationId = requireLocationId(req);
    const loc = await loadLocation(db, locationId);
    const date = queryString(req, 'date') ?? todayIn(loc.timezone);
    if (!isValidDate(date)) throw badRequest('date must be YYYY-MM-DD');
    const range = dayRange(date, loc.timezone);
    const rows = await db
      .select({ a: staffAttendance, name: users.name, role: users.role })
      .from(staffAttendance)
      .innerJoin(users, eq(users.id, staffAttendance.userId))
      .where(and(eq(staffAttendance.locationId, locationId), gte(staffAttendance.checkInAt, range.start), lt(staffAttendance.checkInAt, range.end)))
      .orderBy(desc(staffAttendance.checkInAt))
      .all();
    res.json(rows.map(({ a, ...rest }) => ({ ...a, ...rest, minutes: a.checkOutAt ? Math.round((Date.parse(a.checkOutAt) - Date.parse(a.checkInAt)) / 60_000) : null })));
  });

  // Members' own recent visits.
  r.get('/mine', async (req, res) => {
    const user = req.user!;
    if (!user.memberId) throw forbidden();
    const rows = await select().where(eq(attendance.memberId, user.memberId)).orderBy(desc(attendance.checkInAt)).limit(30).all();
    res.json(rows.map(({ a, ...rest }) => ({ ...a, ...rest })));
  });

  return r;
}
