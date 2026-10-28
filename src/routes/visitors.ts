import { Router } from 'express';
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { VISITOR_STATUSES, members, users, visitors } from '../db/schema.js';
import { loadLocation, loadMember, requireLocationId } from '../lib/access.js';
import { assertLocation, isStaff } from '../lib/auth.js';
import { assertCan } from '../lib/permissions.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { idParam, queryString } from '../lib/http.js';
import { dayRange, isValidDate, TIME_RE, zonedToUtc } from '../lib/time.js';
import { parse } from '../lib/validate.js';

export function visitorsRouter(db: Db) {
  const r = Router();

  r.get('/', async (req, res) => {
    const locationId = requireLocationId(req);
    const loc = await loadLocation(db, locationId);
    const user = req.user!;
    const conds = [eq(visitors.locationId, locationId)];
    if (!isStaff(user)) conds.push(eq(visitors.hostMemberId, user.memberId!));

    const date = queryString(req, 'date');
    if (date) {
      if (!isValidDate(date)) throw badRequest('date must be YYYY-MM-DD');
      const range = dayRange(date, loc.timezone);
      conds.push(gte(visitors.expectedAt, range.start), lt(visitors.expectedAt, range.end));
    }
    const status = queryString(req, 'status');
    if (status) {
      if (!(VISITOR_STATUSES as readonly string[]).includes(status)) throw badRequest('Unknown status');
      conds.push(eq(visitors.status, status as (typeof VISITOR_STATUSES)[number]));
    }
    const rows = await db
      .select({ v: visitors, hostName: users.name, hostCompany: members.company })
      .from(visitors)
      .innerJoin(members, eq(members.id, visitors.hostMemberId))
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(...conds))
      .orderBy(asc(visitors.expectedAt))
      .limit(500)
      .all();
    res.json(rows.map(({ v, ...rest }) => ({ ...v, ...rest })));
  });

  r.post('/', async (req, res) => {
    const body = parse(
      z.object({
        hostMemberId: z.string().optional(),
        name: z.string().trim().min(1).max(100),
        email: z.string().trim().max(200).default(''),
        phone: z.string().trim().max(40).default(''),
        company: z.string().trim().max(120).default(''),
        purpose: z.string().trim().max(300).default(''),
        expectedDate: z.string().refine(isValidDate, 'Use YYYY-MM-DD').optional(),
        expectedTime: z.string().regex(TIME_RE, 'Use HH:mm').optional(),
        checkInNow: z.boolean().default(false),
      }),
      req.body,
    );
    const user = req.user!;
    if (isStaff(user)) assertCan(user, 'front_desk');
    const hostId = isStaff(user) ? body.hostMemberId : user.memberId;
    if (!hostId) throw badRequest('hostMemberId is required');
    const { member: host } = await loadMember(db, hostId);
    if (isStaff(user)) assertLocation(user, host.locationId);
    if (!isStaff(user) && body.checkInNow) throw forbidden('Only the front desk can check visitors in');
    const loc = await loadLocation(db, host.locationId);

    const now = new Date();
    let expectedAt = now.toISOString();
    if (!body.checkInNow && (body.expectedDate || body.expectedTime)) {
      if (!body.expectedDate || !body.expectedTime) throw badRequest('Provide both expectedDate and expectedTime');
      expectedAt = zonedToUtc(body.expectedDate, body.expectedTime, loc.timezone).toISOString();
    }
    const { hostMemberId: _h, expectedDate: _d, expectedTime: _t, checkInNow, ...fields } = body;
    const row = await db
      .insert(visitors)
      .values({
        ...fields,
        locationId: host.locationId,
        hostMemberId: host.id,
        expectedAt,
        status: checkInNow ? 'checked_in' : 'expected',
        checkInAt: checkInNow ? now.toISOString() : null,
      })
      .returning()
      .get();
    res.status(201).json(row);
  });

  function transition(
    action: 'check-in' | 'check-out' | 'cancel',
    from: (typeof VISITOR_STATUSES)[number],
    to: (typeof VISITOR_STATUSES)[number],
    patch: (now: string) => Partial<typeof visitors.$inferInsert>,
    hostMayDo = false,
  ) {
    r.post(`/:id/${action}`, async (req, res) => {
      const v = await db.select().from(visitors).where(eq(visitors.id, idParam(req))).get();
      if (!v) throw notFound('Visitor');
      const user = req.user!;
      if (isStaff(user)) {
        assertCan(user, 'front_desk');
        assertLocation(user, v.locationId);
      } else if (!hostMayDo || user.memberId !== v.hostMemberId) throw forbidden();
      if (v.status !== from) throw conflict(`Visitor is ${v.status.replace('_', ' ')}`);
      res.json(
        await db.update(visitors).set({ status: to, ...patch(new Date().toISOString()) }).where(eq(visitors.id, v.id)).returning().get(),
      );
    });
  }
  transition('check-in', 'expected', 'checked_in', (now) => ({ checkInAt: now }));
  transition('check-out', 'checked_in', 'checked_out', (now) => ({ checkOutAt: now }));
  transition('cancel', 'expected', 'cancelled', () => ({}), true);

  return r;
}
