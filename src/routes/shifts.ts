import { Router } from 'express';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { RESOURCE_KINDS, resources, shiftTemplates } from '../db/schema.js';
import { loadLocation, requireLocationId } from '../lib/access.js';
import { assertLocation } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { idParam } from '../lib/http.js';
import { requirePermission } from '../lib/permissions.js';
import { TIME_RE, toMinutes } from '../lib/time.js';
import { parse } from '../lib/validate.js';

/** Only spaces that are booked can have shifts. */
const BOOKABLE = ['room', 'corporate_room', 'hot_desk'] as const;

const timeStr = z.string().regex(TIME_RE, 'Use HH:mm');
const fields = z.object({
  name: z.string().trim().min(1).max(80),
  resourceId: z.string().nullable(),
  kind: z.enum(RESOURCE_KINDS).nullable(),
  startTime: timeStr,
  endTime: timeStr,
  priceCents: z.number().int().min(0).nullable(),
  active: z.boolean(),
});

async function check(db: Db, locationId: string, v: { resourceId: string | null; kind: string | null; startTime: string; endTime: string }) {
  const dur = toMinutes(v.endTime) - toMinutes(v.startTime);
  if (dur <= 0) throw badRequest('A shift must end after it starts');
  if (dur % 15 !== 0) throw badRequest('Shifts run in 15 minute steps');
  if (v.kind && !(BOOKABLE as readonly string[]).includes(v.kind)) throw badRequest('Only rooms and hot desks can have shifts');
  if (v.resourceId) {
    const r = await db.select().from(resources).where(eq(resources.id, v.resourceId)).get();
    if (!r || r.locationId !== locationId) throw notFound('Space');
    if (!(BOOKABLE as readonly string[]).includes(r.kind)) throw badRequest('Only rooms and hot desks can have shifts');
  }
}

/** Shift templates: ready-made time slots, such as "Morning, 09:00 to 14:00", that people pick when they book. */
export function shiftsRouter(db: Db) {
  const r = Router();

  // Anyone signed in to the location can see them, so the booking form can offer them.
  r.get('/', async (req, res) => {
    const locationId = requireLocationId(req);
    await loadLocation(db, locationId);
    res.json(await db.select().from(shiftTemplates).where(eq(shiftTemplates.locationId, locationId)).orderBy(asc(shiftTemplates.startTime), asc(shiftTemplates.name)).all());
  });

  r.post('/', requirePermission('spaces'), async (req, res) => {
    const body = parse(fields.partial({ resourceId: true, kind: true, priceCents: true, active: true }).extend({ locationId: z.string() }), req.body);
    assertLocation(req.user!, body.locationId);
    const v = { resourceId: null, kind: null, priceCents: null, active: true, ...body };
    await check(db, v.locationId, v);
    res.status(201).json(await db.insert(shiftTemplates).values(v).returning().get());
  });

  r.patch('/:id', requirePermission('spaces'), async (req, res) => {
    const body = parse(fields.partial(), req.body);
    const cur = await db.select().from(shiftTemplates).where(eq(shiftTemplates.id, idParam(req))).get();
    if (!cur) throw notFound('Shift template');
    assertLocation(req.user!, cur.locationId);
    await check(db, cur.locationId, { ...cur, ...body });
    res.json(await db.update(shiftTemplates).set(body).where(eq(shiftTemplates.id, cur.id)).returning().get());
  });

  r.delete('/:id', requirePermission('spaces'), async (req, res) => {
    const cur = await db.select().from(shiftTemplates).where(and(eq(shiftTemplates.id, idParam(req)))).get();
    if (!cur) throw notFound('Shift template');
    assertLocation(req.user!, cur.locationId);
    await db.delete(shiftTemplates).where(eq(shiftTemplates.id, cur.id)).run();
    res.status(204).end();
  });

  return r;
}
