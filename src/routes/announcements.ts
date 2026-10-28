import { Router } from 'express';
import { and, desc, eq, isNull, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { announcements } from '../db/schema.js';
import { requireLocationId } from '../lib/access.js';
import { assertLocation, isStaff } from '../lib/auth.js';
import { requirePermission } from '../lib/permissions.js';
import { notFound } from '../lib/errors.js';
import { idParam } from '../lib/http.js';
import { parse } from '../lib/validate.js';

const fields = z.object({
  title: z.string().trim().min(1).max(150),
  body: z.string().trim().max(5000),
  draft: z.boolean(),
  publishAt: z.string().datetime().nullable(),
});

type Row = typeof announcements.$inferSelect;
const withState = (a: Row, now = new Date().toISOString()) => ({ ...a, state: a.draft ? 'draft' : a.publishAt && a.publishAt > now ? 'scheduled' : 'live' });

export function announcementsRouter(db: Db) {
  const r = Router();

  // Staff see everything with its state; members only what is live now.
  r.get('/', async (req, res) => {
    const locationId = requireLocationId(req);
    const now = new Date().toISOString();
    const where = isStaff(req.user!)
      ? eq(announcements.locationId, locationId)
      : and(eq(announcements.locationId, locationId), eq(announcements.draft, false), or(isNull(announcements.publishAt), lte(announcements.publishAt, now)));
    res.json(
      (await db
        .select()
        .from(announcements)
        .where(where)
        .orderBy(desc(announcements.createdAt))
        .limit(200)
        .all())
        .map((a) => withState(a, now)),
    );
  });

  r.post('/', requirePermission('announcements'), async (req, res) => {
    const body = parse(fields.partial({ body: true, draft: true, publishAt: true }).extend({ locationId: z.string() }), req.body);
    assertLocation(req.user!, body.locationId);
    res.status(201).json(withState(await db.insert(announcements).values({ body: '', draft: true, publishAt: null, ...body, createdById: req.user!.id }).returning().get()));
  });

  r.patch('/:id', requirePermission('announcements'), async (req, res) => {
    const body = parse(fields.partial(), req.body);
    const cur = await db.select().from(announcements).where(eq(announcements.id, idParam(req))).get();
    if (!cur) throw notFound('Announcement');
    assertLocation(req.user!, cur.locationId);
    res.json(withState(await db.update(announcements).set(body).where(eq(announcements.id, cur.id)).returning().get()));
  });

  r.delete('/:id', requirePermission('announcements'), async (req, res) => {
    const cur = await db.select().from(announcements).where(eq(announcements.id, idParam(req))).get();
    if (!cur) throw notFound('Announcement');
    assertLocation(req.user!, cur.locationId);
    await db.delete(announcements).where(eq(announcements.id, cur.id)).run();
    res.status(204).end();
  });

  return r;
}
