import { Router } from 'express';
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { locationHolidays, locations } from '../db/schema.js';
import { assertLocation, assertWithinLimit, ownerOnly } from '../lib/auth.js';
import { requirePermission } from '../lib/permissions.js';
import { badRequest, notFound } from '../lib/errors.js';
import { isValidDate, isValidTimezone, TIME_RE } from '../lib/time.js';
import { queryString } from '../lib/http.js';
import { idParam } from '../lib/http.js';
import { parse } from '../lib/validate.js';

const timeStr = z.string().regex(TIME_RE, 'Use HH:mm');
const locationFields = z.object({
  name: z.string().trim().min(1).max(100),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,6}$/, 'Code must be 2–6 letters or digits'),
  address: z.string().trim().max(300).default(''),
  timezone: z.string().refine(isValidTimezone, 'Unknown timezone'),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code'),
  openTime: timeStr,
  closeTime: timeStr,
  taxRateBps: z.number().int().min(0).max(10_000),
  closedWeekdays: z.string().regex(/^([0-6](,[0-6])*)?$/, 'Weekdays are numbers 0 to 6'),
  active: z.boolean(),
});

const createSchema = locationFields.partial({ address: true, active: true, closedWeekdays: true }).extend({
  timezone: z.string().refine(isValidTimezone, 'Unknown timezone').default('Asia/Karachi'),
  taxRateBps: z.number().int().min(0).max(10_000).default(0),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('PKR'),
});

export function locationsRouter(db: Db) {
  const r = Router();

  r.get('/', async (req, res) => {
    const ids = req.user!.locationIds;
    res.json(ids.length ? await db.select().from(locations).where(inArray(locations.id, ids)).orderBy(asc(locations.name)).all() : []);
  });

  r.post('/', ownerOnly, async (req, res) => {
    const body = parse(createSchema, req.body);
    if (body.openTime >= body.closeTime) throw badRequest('Closing time must be after opening time');
    await assertWithinLimit(db, req.user!, 'locations');
    res.status(201).json(await db.insert(locations).values({ ...body, organizationId: req.user!.organizationId! }).returning().get());
  });

  r.patch('/:id', ownerOnly, async (req, res) => {
    const body = parse(locationFields.partial(), req.body);
    const current = await db.select().from(locations).where(eq(locations.id, idParam(req))).get();
    if (!current) throw notFound('Location');
    assertLocation(req.user!, current.id);
    const open = body.openTime ?? current.openTime;
    const close = body.closeTime ?? current.closeTime;
    if (open >= close) throw badRequest('Closing time must be after opening time');
    res.json(await db.update(locations).set(body).where(eq(locations.id, current.id)).returning().get());
  });

  // Dates the location is shut. Anyone with access to the location can read them; managers and owners change them.
  r.get('/:id/holidays', async (req, res) => {
    const id = idParam(req);
    assertLocation(req.user!, id);
    const conds = [eq(locationHolidays.locationId, id)];
    const from = queryString(req, 'from');
    const to = queryString(req, 'to');
    if (from) conds.push(gte(locationHolidays.date, from));
    if (to) conds.push(lte(locationHolidays.date, to));
    res.json(await db.select().from(locationHolidays).where(and(...conds)).orderBy(asc(locationHolidays.date)).all());
  });

  r.post('/:id/holidays', requirePermission('holidays'), async (req, res) => {
    const body = parse(z.object({ date: z.string().refine(isValidDate, 'Use YYYY-MM-DD'), name: z.string().trim().max(100).default('') }), req.body);
    const id = idParam(req);
    assertLocation(req.user!, id);
    res.status(201).json(await db.insert(locationHolidays).values({ ...body, locationId: id }).returning().get());
  });

  r.delete('/:id/holidays/:holidayId', requirePermission('holidays'), async (req, res) => {
    const id = idParam(req);
    assertLocation(req.user!, id);
    const gone = await db
      .delete(locationHolidays)
      .where(and(eq(locationHolidays.id, String(req.params.holidayId)), eq(locationHolidays.locationId, id)))
      .returning()
      .get();
    if (!gone) throw notFound('Holiday');
    res.status(204).end();
  });

  return r;
}
