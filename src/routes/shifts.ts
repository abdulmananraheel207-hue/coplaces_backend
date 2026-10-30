import { Router } from 'express';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { members, plans, resources, shiftSpaces, shiftTemplates } from '../db/schema.js';
import { loadLocation, requireLocationId } from '../lib/access.js';
import { assertLocation } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { idParam, queryString } from '../lib/http.js';
import { requirePermission } from '../lib/permissions.js';
import { TIME_RE, toMinutes } from '../lib/time.js';
import { parse } from '../lib/validate.js';

/** Rooms, desks and offices can have shifts. Lockers and parking cannot. */
const BOOKABLE = ['room', 'corporate_room', 'hot_desk', 'dedicated_desk', 'office'] as const;

const timeStr = z.string().regex(TIME_RE, 'Use HH:mm');
const fields = z.object({
  name: z.string().trim().min(1).max(80),
  planId: z.string().nullable(),
  /** The spaces this shift is limited to. Empty means every bookable space. */
  spaceIds: z.array(z.string()).max(500),
  startTime: timeStr,
  endTime: timeStr,
  priceCents: z.number().int().min(0).nullable(),
  active: z.boolean(),
});

async function check(db: Db, locationId: string, v: { planId: string | null; spaceIds: string[]; startTime: string; endTime: string }) {
  const dur = toMinutes(v.endTime) - toMinutes(v.startTime);
  if (dur <= 0) throw badRequest('A shift must end after it starts');
  if (dur % 15 !== 0) throw badRequest('Shifts run in 15 minute steps');
  if (v.planId) {
    const p = await db.select({ locationId: plans.locationId }).from(plans).where(eq(plans.id, v.planId)).get();
    if (!p || p.locationId !== locationId) throw notFound('Plan');
  }
  if (v.spaceIds.length) {
    const rows = await db.select().from(resources).where(inArray(resources.id, v.spaceIds)).all();
    if (rows.length !== new Set(v.spaceIds).size || rows.some((r) => r.locationId !== locationId)) throw notFound('Space');
    if (rows.some((r) => !(BOOKABLE as readonly string[]).includes(r.kind))) throw badRequest('Only rooms, desks and offices can have shifts');
  }
}

/** Replaces the spaces a shift is limited to. */
async function setSpaces(db: Db, shiftId: string, spaceIds: string[]) {
  await db.delete(shiftSpaces).where(eq(shiftSpaces.shiftId, shiftId)).run();
  for (const resourceId of new Set(spaceIds)) await db.insert(shiftSpaces).values({ shiftId, resourceId }).run();
}

/** Shifts, each inside a plan: ready-made time slots such as "Morning, 09:00 to 14:00" with a price, that members on the plan pick when they book. */
export function shiftsRouter(db: Db) {
  const r = Router();

  const shape = async (rows: (typeof shiftTemplates.$inferSelect)[]) => {
    const listed = rows.length ? await db.select().from(shiftSpaces).where(inArray(shiftSpaces.shiftId, rows.map((x) => x.id))).all() : [];
    return rows.map((x) => ({ ...x, spaceIds: listed.filter((s) => s.shiftId === x.id).map((s) => s.resourceId) }));
  };

  // Anyone signed in to the location can see them, so the booking form can offer them. A member sees their own plan's shifts
  // (and ones that belong to no plan); staff booking for a member pass that member's id, and staff without one see every shift.
  r.get('/', async (req, res) => {
    const locationId = requireLocationId(req);
    await loadLocation(db, locationId);
    let rows = await db.select().from(shiftTemplates).where(eq(shiftTemplates.locationId, locationId)).orderBy(asc(shiftTemplates.startTime), asc(shiftTemplates.name)).all();
    const memberId = req.user!.role === 'member' ? req.user!.memberId : queryString(req, 'memberId');
    if (memberId) {
      const m = await db.select({ planId: members.planId, locationId: members.locationId }).from(members).where(eq(members.id, memberId)).get();
      if (!m || m.locationId !== locationId) throw notFound('Member');
      rows = rows.filter((x) => !x.planId || x.planId === m.planId);
    }
    res.json(await shape(rows));
  });

  r.post('/', requirePermission('plans'), async (req, res) => {
    const body = parse(fields.partial({ planId: true, spaceIds: true, priceCents: true, active: true }).extend({ locationId: z.string() }), req.body);
    assertLocation(req.user!, body.locationId);
    const { spaceIds = [], ...rest } = body;
    const v = { planId: null, priceCents: null, active: true, ...rest };
    await check(db, v.locationId, { ...v, spaceIds });
    const made = await db.insert(shiftTemplates).values(v).returning().get();
    await setSpaces(db, made.id, spaceIds);
    res.status(201).json((await shape([made]))[0]);
  });

  r.patch('/:id', requirePermission('plans'), async (req, res) => {
    const body = parse(fields.partial(), req.body);
    const cur = await db.select().from(shiftTemplates).where(eq(shiftTemplates.id, idParam(req))).get();
    if (!cur) throw notFound('Shift');
    assertLocation(req.user!, cur.locationId);
    const have = (await shape([cur]))[0]!;
    const { spaceIds, ...rest } = body;
    await check(db, cur.locationId, { planId: cur.planId, startTime: cur.startTime, endTime: cur.endTime, ...rest, spaceIds: spaceIds ?? have.spaceIds });
    // Choosing spaces replaces the older one-space or one-kind scope.
    const patch = { ...rest, ...(spaceIds ? { resourceId: null, kind: null } : {}) };
    const updated = Object.keys(patch).length ? await db.update(shiftTemplates).set(patch).where(eq(shiftTemplates.id, cur.id)).returning().get() : cur;
    if (spaceIds) await setSpaces(db, cur.id, spaceIds);
    res.json((await shape([updated]))[0]);
  });

  r.delete('/:id', requirePermission('plans'), async (req, res) => {
    const cur = await db.select().from(shiftTemplates).where(and(eq(shiftTemplates.id, idParam(req)))).get();
    if (!cur) throw notFound('Shift');
    assertLocation(req.user!, cur.locationId);
    await db.delete(shiftTemplates).where(eq(shiftTemplates.id, cur.id)).run();
    res.status(204).end();
  });

  return r;
}
