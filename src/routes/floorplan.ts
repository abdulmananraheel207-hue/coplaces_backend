import { Router } from 'express';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { isValidStyle } from '../catalogue.js';
import type { Db } from '../db/client.js';
import { FLOOR_OBJECT_TYPES, RESOURCE_KINDS, floorObjects, floorTemplates, resources } from '../db/schema.js';
import { requireLocationId } from '../lib/access.js';
import { assertLocation, requireFeature } from '../lib/auth.js';
import { idParam } from '../lib/http.js';
import { requirePermission } from '../lib/permissions.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { assertRetirable } from '../services/floorplan.js';

const coord = z.number().min(-300).max(300);
const size = z.number().min(0.4).max(40);
/** Walls and doors are thin, so things on the floor other than rooms and desks may be as slim as ten centimetres. */
const slim = z.number().min(0.1).max(60);
const floor = z.string().trim().max(50);

const plan = z.object({
  x: coord,
  z: coord,
  rot: z.number().int().min(0).max(3),
  w: size.nullable().default(null),
  d: size.nullable().default(null),
});

/** A variant of a thing (an L-shaped zone, a double door) and the colour wash of a zone. */
const variant = z.enum(['', 'l', 'double', 'sliding']).default('');
const tint = z.enum(['', 'blue', 'green', 'yellow', 'rose', 'slate']).default('');

const props = z
  .object({
    name: z.string().trim().min(1).max(100),
    style: z.string().trim().max(40),
    capacity: z.number().int().min(1).max(500),
    hourlyRateCents: z.number().int().min(0),
    dailyRateCents: z.number().int().min(0),
    amenities: z.string().trim().max(300),
  })
  .partial();

const body = z.object({
  locationId: z.string(),
  /** Spaces that already exist: where they now sit, and any changes to their details. */
  update: z
    .array(z.object({ id: z.string(), floor: floor.optional(), plan: plan.optional(), props: props.optional() }))
    .max(500)
    .default([]),
  create: z
    .array(
      z.object({
        kind: z.enum(RESOURCE_KINDS),
        style: z.string().trim().max(40).default(''),
        name: z.string().trim().min(1).max(100),
        floor,
        capacity: z.number().int().min(1).max(500).default(1),
        hourlyRateCents: z.number().int().min(0).default(0),
        dailyRateCents: z.number().int().min(0).default(0),
        amenities: z.string().trim().max(300).default(''),
        plan,
      }),
    )
    .max(200)
    .default([]),
  retire: z.array(z.string()).max(200).default([]),
  objects: z
    .object({
      upsert: z
        .array(z.object({ id: z.string().optional(), type: z.enum(FLOOR_OBJECT_TYPES), floor, label: z.string().trim().max(60).default(''), variant, tint, x: coord, z: coord, rot: plan.shape.rot, w: slim.nullable().default(null), d: slim.nullable().default(null) }))
        .max(300)
        .default([]),
      remove: z.array(z.string()).max(300).default([]),
    })
    .default({ upsert: [], remove: [] }),
});

/** What a template remembers about each thing: where it sat in the group, and how it was set up. */
const templateThing = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('resource'),
    kind: z.enum(RESOURCE_KINDS),
    style: z.string().trim().max(40),
    name: z.string().trim().max(100),
    capacity: z.number().int().min(1).max(500),
    hourlyRateCents: z.number().int().min(0),
    dailyRateCents: z.number().int().min(0),
    amenities: z.string().trim().max(300),
    x: coord,
    z: coord,
    rot: z.number().int().min(0).max(3),
    w: size.nullable(),
    d: size.nullable(),
  }),
  z.object({
    type: z.literal('object'),
    object: z.enum(FLOOR_OBJECT_TYPES),
    label: z.string().trim().max(60),
    variant,
    tint,
    x: coord,
    z: coord,
    rot: z.number().int().min(0).max(3),
    w: slim.nullable(),
    d: slim.nullable(),
  }),
]);
const templateBody = z.object({ name: z.string().trim().min(1).max(80), things: z.array(templateThing).min(1).max(300) });

export function floorPlanRouter(db: Db) {
  const r = Router();

  // ---- Templates: a saved arrangement that can be dropped onto any floor of any of the organization's locations.
  r.get('/templates', requirePermission('spaces'), requireFeature('floor_3d'), async (req, res) => {
    const rows = await db.select().from(floorTemplates).where(eq(floorTemplates.organizationId, req.user!.organizationId!)).orderBy(asc(floorTemplates.name)).all();
    res.json(rows.map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt, things: JSON.parse(t.data) as unknown[] })));
  });

  r.post('/templates', requirePermission('spaces'), requireFeature('floor_3d'), async (req, res) => {
    const input = parse(templateBody, req.body);
    const orgId = req.user!.organizationId!;
    const exists = await db.select({ id: floorTemplates.id }).from(floorTemplates).where(and(eq(floorTemplates.organizationId, orgId), eq(floorTemplates.name, input.name))).get();
    if (exists) throw conflict('You already have a template with that name');
    const made = await db.insert(floorTemplates).values({ organizationId: orgId, name: input.name, data: JSON.stringify(input.things), createdById: req.user!.id }).returning().get();
    res.status(201).json({ id: made.id, name: made.name, createdAt: made.createdAt, things: input.things });
  });

  r.delete('/templates/:id', requirePermission('spaces'), requireFeature('floor_3d'), async (req, res) => {
    const gone = await db
      .delete(floorTemplates)
      .where(and(eq(floorTemplates.id, idParam(req)), eq(floorTemplates.organizationId, req.user!.organizationId!)))
      .returning({ id: floorTemplates.id })
      .get();
    if (!gone) throw notFound('Template');
    res.status(204).end();
  });

  /** Kitchens, coffee machines and the like. Members see them too, since the floor view shows them. */
  r.get('/objects', requireFeature('floor_3d'), async (req, res) => {
    const locationId = requireLocationId(req);
    res.json(await db.select().from(floorObjects).where(eq(floorObjects.locationId, locationId)).orderBy(asc(floorObjects.createdAt)).all());
  });

  /**
   * Saves a whole editing session in one go: new spaces, moved and changed ones, removed ones, and the
   * objects. It either all applies or none of it does.
   */
  r.put('/', requirePermission('spaces'), requireFeature('floor_3d'), async (req, res) => {
    const input = parse(body, req.body);
    assertLocation(req.user!, input.locationId);
    const here = input.locationId;

    const created = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const ids = [...new Set([...input.update.map((u) => u.id), ...input.retire])];
      const rows = ids.length ? await t.select().from(resources).where(inArray(resources.id, ids)).all() : [];
      const byId = new Map(rows.map((x) => [x.id, x]));
      // Anything outside this location is reported as missing, never as someone else's.
      for (const id of ids) if (byId.get(id)?.locationId !== here) throw notFound('Space');

      for (const id of input.retire) {
        const row = byId.get(id)!;
        await assertRetirable(t, row);
        await t.update(resources).set({ status: 'retired', planX: null, planZ: null, planW: null, planD: null }).where(eq(resources.id, id)).run();
      }

      const retiring = new Set(input.retire);
      for (const u of input.update) {
        if (retiring.has(u.id)) continue;
        const row = byId.get(u.id)!;
        if (u.props?.style !== undefined && !isValidStyle(row.kind, u.props.style)) throw badRequest(`"${u.props.style}" is not a style of ${row.kind.replace('_', ' ')}`);
        await t.update(resources)
          .set({
            ...u.props,
            ...(u.floor !== undefined ? { floor: u.floor } : {}),
            ...(u.plan ? { planX: u.plan.x, planZ: u.plan.z, planRot: u.plan.rot, planW: u.plan.w, planD: u.plan.d } : {}),
          })
          .where(eq(resources.id, row.id))
          .run();
      }

      const made: string[] = [];
      for (const c of input.create) {
        if (!isValidStyle(c.kind, c.style)) throw badRequest(`"${c.style}" is not a style of ${c.kind.replace('_', ' ')}`);
        const { plan: p, ...rest } = c;
        made.push(
          (await t
            .insert(resources)
            .values({ ...rest, locationId: here, planX: p.x, planZ: p.z, planRot: p.rot, planW: p.w, planD: p.d })
            .returning({ id: resources.id })
            .get()).id,
        );
      }

      const touched = [...input.objects.remove, ...input.objects.upsert.flatMap((o) => (o.id ? [o.id] : []))];
      const objects = touched.length ? await t.select().from(floorObjects).where(inArray(floorObjects.id, touched)).all() : [];
      const known = new Map(objects.map((o) => [o.id, o]));
      for (const id of touched) if (known.get(id)?.locationId !== here) throw notFound('Object');

      for (const id of input.objects.remove) await t.delete(floorObjects).where(eq(floorObjects.id, id)).run();
      for (const { id, ...o } of input.objects.upsert) {
        if (id && input.objects.remove.includes(id)) continue;
        if (id) await t.update(floorObjects).set(o).where(eq(floorObjects.id, id)).run();
        else await t.insert(floorObjects).values({ ...o, locationId: here }).run();
      }
      return made;
    });

    res.json({ created });
  });

  return r;
}
