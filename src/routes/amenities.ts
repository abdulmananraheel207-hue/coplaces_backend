import { Router } from 'express';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { amenities, amenityOrders } from '../db/schema.js';
import { requireLocationId } from '../lib/access.js';
import { assertLocation } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { idParam, queryString } from '../lib/http.js';
import { requirePermission } from '../lib/permissions.js';
import { parse } from '../lib/validate.js';
import { collectAmenities, giveAmenity, listOrders } from '../services/amenities.js';

const fields = z.object({
  name: z.string().trim().min(1).max(60),
  priceCents: z.number().int().min(0).max(1_000_000_000),
});

/** The owner's list of amenities, and the front desk recording who was given what. */
export function amenitiesRouter(db: Db) {
  const r = Router();

  r.get('/', requirePermission('plans', 'members', 'front_desk'), async (req, res) => {
    const locationId = requireLocationId(req);
    res.json(await db.select().from(amenities).where(and(eq(amenities.locationId, locationId), eq(amenities.active, true))).orderBy(asc(amenities.name)).all());
  });

  r.post('/', requirePermission('plans'), async (req, res) => {
    const body = parse(fields.extend({ locationId: z.string() }), req.body);
    assertLocation(req.user!, body.locationId);
    res.status(201).json(await db.insert(amenities).values(body).returning().get());
  });

  r.patch('/:id', requirePermission('plans'), async (req, res) => {
    const body = parse(fields.partial(), req.body);
    const found = await db.select().from(amenities).where(eq(amenities.id, idParam(req))).get();
    if (!found) throw notFound('Amenity');
    assertLocation(req.user!, found.locationId);
    res.json(Object.keys(body).length ? await db.update(amenities).set(body).where(eq(amenities.id, found.id)).returning().get() : found);
  });

  /** Taken off the list. What was already given stays in the records, so it is hidden rather than erased. */
  r.delete('/:id', requirePermission('plans'), async (req, res) => {
    const found = await db.select().from(amenities).where(eq(amenities.id, idParam(req))).get();
    if (!found) throw notFound('Amenity');
    assertLocation(req.user!, found.locationId);
    const given = (await db.select({ n: sql<number>`count(*)` }).from(amenityOrders).where(eq(amenityOrders.amenityId, found.id)).get())!.n;
    if (given) await db.update(amenities).set({ active: false }).where(eq(amenities.id, found.id)).run();
    else await db.delete(amenities).where(eq(amenities.id, found.id)).run();
    res.status(204).end();
  });

  r.get('/orders', requirePermission('front_desk', 'invoices', 'reports'), async (req, res) => {
    res.json(await listOrders(db, requireLocationId(req), queryString(req, 'memberId')));
  });

  r.post('/orders', requirePermission('front_desk'), async (req, res) => {
    const body = parse(z.object({ memberId: z.string(), amenityId: z.string(), quantity: z.number().int().min(1).max(100).default(1) }), req.body);
    res.status(201).json(await giveAmenity(db, req.user!, body));
  });

  /** The member paid what they owe for amenities. */
  r.post('/collect', requirePermission('front_desk', 'invoices'), async (req, res) => {
    const body = parse(z.object({ memberId: z.string() }), req.body);
    res.json(await collectAmenities(db, req.user!, body.memberId));
  });

  return r;
}
