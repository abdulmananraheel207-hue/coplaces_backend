import express, { Router } from 'express';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import { isValidStyle } from '../catalogue.js';
import type { Db } from '../db/client.js';
import { RESOURCE_KINDS, RESOURCE_STATUSES, members, resourceAssignments, resourcePhotos, resources, users } from '../db/schema.js';
import { loadLocation, loadMember, requireLocationId } from '../lib/access.js';
import { assertLocation, staffOnly } from '../lib/auth.js';
import { requirePermission } from '../lib/permissions.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { idParam, queryString } from '../lib/http.js';
import { isValidDate, TIME_RE, todayIn } from '../lib/time.js';
import { byName } from '../lib/sort.js';
import { parse } from '../lib/validate.js';
import { assignSpace } from '../services/contracts.js';
import { assertRetirable } from '../services/floorplan.js';

const dateStr = z.string().refine(isValidDate, 'Use YYYY-MM-DD');

const fields = z.object({
  kind: z.enum(RESOURCE_KINDS),
  name: z.string().trim().min(1).max(100),
  floor: z.string().trim().max(50),
  capacity: z.number().int().min(1).max(500),
  hourlyRateCents: z.number().int().min(0),
  dailyRateCents: z.number().int().min(0),
  amenities: z.string().trim().max(300),
  status: z.enum(RESOURCE_STATUSES),
  notes: z.string().trim().max(1000),
  style: z.string().trim().max(40),
  planX: z.number().min(-300).max(300).nullable(),
  planZ: z.number().min(-300).max(300).nullable(),
  planW: z.number().min(0.4).max(40).nullable(),
  planD: z.number().min(0.4).max(40).nullable(),
  planRot: z.number().int().min(0).max(3),
  description: z.string().trim().max(1000),
  openTime: z.string().regex(TIME_RE, 'Use HH:mm').nullable(),
  closeTime: z.string().regex(TIME_RE, 'Use HH:mm').nullable(),
  closedWeekdays: z.string().regex(/^([0-6](,[0-6])*)?$/, 'Weekdays are numbers 0 to 6').nullable(),
  offPeakRateCents: z.number().int().min(0).nullable(),
  peakStart: z.string().regex(TIME_RE, 'Use HH:mm').nullable(),
  peakEnd: z.string().regex(TIME_RE, 'Use HH:mm').nullable(),
  halfDayRateCents: z.number().int().min(0).nullable(),
  fullDayRateCents: z.number().int().min(0).nullable(),
  noPlanRateCents: z.number().int().min(0).nullable(),
});

/** Opening hours and peak hours must be a proper window, and an off-peak rate needs the peak window it is the opposite of. */
function checkWindows(v: { openTime?: string | null; closeTime?: string | null; peakStart?: string | null; peakEnd?: string | null; offPeakRateCents?: number | null }) {
  if ((v.openTime == null) !== (v.closeTime == null)) throw badRequest('Give both an opening and a closing time, or neither');
  if (v.openTime && v.closeTime && v.openTime >= v.closeTime) throw badRequest('Closing time must be after opening time');
  if ((v.peakStart == null) !== (v.peakEnd == null)) throw badRequest('Give both the start and the end of peak hours, or neither');
  if (v.peakStart && v.peakEnd && v.peakStart >= v.peakEnd) throw badRequest('Peak hours must end after they start');
  if (v.offPeakRateCents != null && !v.peakStart) throw badRequest('Set the peak hours that the off-peak rate is the opposite of');
}

/** Image types that can be stored as a photo of a space, with the first bytes that prove a file really is one. */
const PHOTO_TYPES: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
const MAX_PHOTOS = 8;

export function resourcesRouter(db: Db) {
  const r = Router();

  r.get('/', async (req, res) => {
    const locationId = requireLocationId(req);
    const kind = queryString(req, 'kind');
    const loc = await loadLocation(db, locationId);
    const today = todayIn(loc.timezone);

    const rows = (await db
      .select()
      .from(resources)
      .where(eq(resources.locationId, locationId))
      .orderBy(asc(resources.kind))
      .all())
      .filter((x) => !kind || x.kind === kind)
      .sort((a, b) => a.kind.localeCompare(b.kind) || byName(a.name, b.name));

    // Members only see who occupies a space if they are staff.
    const staff = req.user!.role !== 'member';
    const photoRows = rows.length
      ? await db
          .select({ id: resourcePhotos.id, resourceId: resourcePhotos.resourceId })
          .from(resourcePhotos)
          .where(inArray(resourcePhotos.resourceId, rows.map((x) => x.id)))
          .orderBy(asc(resourcePhotos.createdAt))
          .all()
      : [];
    const active = await db
      .select({ a: resourceAssignments, name: users.name, company: members.company })
      .from(resourceAssignments)
      .innerJoin(members, eq(members.id, resourceAssignments.memberId))
      .innerJoin(users, eq(users.id, members.userId))
      .where(
        and(
          lte(resourceAssignments.startDate, today),
          or(isNull(resourceAssignments.endDate), gte(resourceAssignments.endDate, today)),
        ),
      )
      .all();

    res.json(
      rows.map((x) => {
        const hit = active.find((a) => a.a.resourceId === x.id);
        return {
          ...x,
          photoIds: photoRows.filter((p) => p.resourceId === x.id).map((p) => p.id),
          occupied: Boolean(hit),
          occupant: hit && staff ? { assignmentId: hit.a.id, memberId: hit.a.memberId, name: hit.name, company: hit.company } : null,
        };
      }),
    );
  });

  r.post('/', requirePermission('spaces'), async (req, res) => {
    const body = parse(
      fields
        .partial({ floor: true, capacity: true, hourlyRateCents: true, dailyRateCents: true, amenities: true, status: true, notes: true, style: true, planX: true, planZ: true, planW: true, planD: true, planRot: true, description: true, openTime: true, closeTime: true, closedWeekdays: true, offPeakRateCents: true, peakStart: true, peakEnd: true, halfDayRateCents: true, fullDayRateCents: true, noPlanRateCents: true })
        .extend({ locationId: z.string() }),
      req.body,
    );
    assertLocation(req.user!, body.locationId);
    checkWindows(body);
    if (body.style !== undefined && !isValidStyle(body.kind, body.style)) throw badRequest(`"${body.style}" is not a style of ${body.kind.replace('_', ' ')}`);
    res.status(201).json(await db.insert(resources).values(body).returning().get());
  });

  r.patch('/:id', requirePermission('spaces'), async (req, res) => {
    const body = parse(fields.partial(), req.body);
    const current = await db.select().from(resources).where(eq(resources.id, idParam(req))).get();
    if (!current) throw notFound('Resource');
    assertLocation(req.user!, current.locationId);
    checkWindows({ ...current, ...body });
    if (body.style !== undefined && !isValidStyle(body.kind ?? current.kind, body.style)) throw badRequest(`"${body.style}" is not a style of ${(body.kind ?? current.kind).replace('_', ' ')}`);
    if (body.status === 'retired' && current.status !== 'retired') await assertRetirable(db, current);
    res.json(await db.update(resources).set(body).where(eq(resources.id, current.id)).returning().get());
  });

  // ---- Photos of a space. Anyone who can see the location can see them; the spaces permission changes them.

  const spaceOf = async (req: Parameters<typeof idParam>[0]) => {
    const row = await db.select().from(resources).where(eq(resources.id, idParam(req))).get();
    if (!row) throw notFound('Space');
    assertLocation(req.user!, row.locationId);
    return row;
  };

  r.get('/:id', async (req, res) => {
    const row = await spaceOf(req);
    const photoIds = (await db.select({ id: resourcePhotos.id }).from(resourcePhotos).where(eq(resourcePhotos.resourceId, row.id)).orderBy(asc(resourcePhotos.createdAt)).all()).map((p) => p.id);
    res.json({ ...row, photoIds });
  });

  r.post(
    '/:id/photos',
    requirePermission('spaces'),
    express.raw({ type: Object.keys(PHOTO_TYPES), limit: '3mb' }),
    async (req, res) => {
      const row = await spaceOf(req);
      const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
      const check = PHOTO_TYPES[type];
      if (!check) throw badRequest('Photos must be JPEG, PNG or WebP');
      const data = req.body as unknown;
      if (!Buffer.isBuffer(data) || data.length === 0) throw badRequest('No photo was sent');
      if (!check(data)) throw badRequest('That file is not a valid photo');
      const have = (await db.select({ id: resourcePhotos.id }).from(resourcePhotos).where(eq(resourcePhotos.resourceId, row.id)).all()).length;
      if (have >= MAX_PHOTOS) throw conflict(`A space can have up to ${MAX_PHOTOS} photos`);
      const made = await db.insert(resourcePhotos).values({ resourceId: row.id, contentType: type, data }).returning({ id: resourcePhotos.id }).get();
      res.status(201).json(made);
    },
  );

  r.get('/photos/:photoId/file', async (req, res) => {
    const photo = await db.select().from(resourcePhotos).where(eq(resourcePhotos.id, String(req.params.photoId))).get();
    if (!photo) throw notFound('Photo');
    const space = await db.select({ locationId: resources.locationId }).from(resources).where(eq(resources.id, photo.resourceId)).get();
    if (!space) throw notFound('Photo');
    assertLocation(req.user!, space.locationId);
    res.setHeader('Content-Type', photo.contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(photo.data);
  });

  r.delete('/:id/photos/:photoId', requirePermission('spaces'), async (req, res) => {
    const row = await spaceOf(req);
    const gone = await db
      .delete(resourcePhotos)
      .where(and(eq(resourcePhotos.id, String(req.params.photoId)), eq(resourcePhotos.resourceId, row.id)))
      .returning({ id: resourcePhotos.id })
      .get();
    if (!gone) throw notFound('Photo');
    res.status(204).end();
  });

  return r;
}

export function assignmentsRouter(db: Db) {
  const r = Router();
  r.use(staffOnly);

  r.get('/', async (req, res) => {
    const locationId = requireLocationId(req);
    const rows = await db
      .select({ a: resourceAssignments, resource: resources, name: users.name })
      .from(resourceAssignments)
      .innerJoin(resources, eq(resources.id, resourceAssignments.resourceId))
      .innerJoin(members, eq(members.id, resourceAssignments.memberId))
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(resources.locationId, locationId))
      .orderBy(asc(resources.name))
      .all();
    res.json(rows.map(({ a, resource, name }) => ({ ...a, resourceName: resource.name, resourceKind: resource.kind, memberName: name })));
  });

  r.post('/', requirePermission('members', 'spaces'), async (req, res) => {
    const body = parse(
      z.object({
        resourceId: z.string(),
        memberId: z.string(),
        startDate: dateStr,
        endDate: dateStr.nullable().default(null),
      }),
      req.body,
    );
    res.status(201).json(await assignSpace(db, req.user!, body));
  });

  // End (or shorten) an assignment.
  r.patch('/:id', requirePermission('members', 'spaces'), async (req, res) => {
    const body = parse(z.object({ endDate: dateStr }), req.body);
    const row = await db
      .select({ a: resourceAssignments, locationId: resources.locationId })
      .from(resourceAssignments)
      .innerJoin(resources, eq(resources.id, resourceAssignments.resourceId))
      .where(eq(resourceAssignments.id, idParam(req)))
      .get();
    if (!row) throw notFound('Assignment');
    assertLocation(req.user!, row.locationId);
    if (body.endDate < row.a.startDate) throw badRequest('End date is before start date');
    res.json(
      await db.update(resourceAssignments).set({ endDate: body.endDate }).where(eq(resourceAssignments.id, row.a.id)).returning().get(),
    );
  });

  return r;
}
