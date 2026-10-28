import { Router } from 'express';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { ASSET_STATUSES, ISSUE_PRIORITIES, ISSUE_STATUSES, TASK_KINDS, issues, resources, spaceAssets, spaceTasks, taskLogs, users } from '../db/schema.js';
import { loadLocation, requireLocationId } from '../lib/access.js';
import { assertLocation } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { idParam, queryString } from '../lib/http.js';
import { can, requirePermission } from '../lib/permissions.js';
import { addDays, isValidDate, todayIn } from '../lib/time.js';
import { parse } from '../lib/validate.js';

const dateStr = z.string().refine(isValidDate, 'Use YYYY-MM-DD');

/** The space must belong to the location; a job or item that names none covers the whole location. */
async function checkSpace(db: Db, locationId: string, resourceId: string | null | undefined) {
  if (!resourceId) return;
  const r = await db.select({ locationId: resources.locationId }).from(resources).where(eq(resources.id, resourceId)).get();
  if (!r || r.locationId !== locationId) throw notFound('Space');
}

// ---------------------------------------------------------------------------------------------
// Cleaning and upkeep schedule

const taskFields = z.object({
  resourceId: z.string().nullable(),
  kind: z.enum(TASK_KINDS),
  title: z.string().trim().min(1).max(150),
  notes: z.string().trim().max(1000),
  everyDays: z.number().int().min(1).max(730).nullable(),
  nextDue: dateStr,
  active: z.boolean(),
});

export function tasksRouter(db: Db) {
  const r = Router();
  r.use(requirePermission('maintenance'));

  r.get('/', async (req, res) => {
    const locationId = requireLocationId(req);
    const today = todayIn((await loadLocation(db, locationId)).timezone);
    const conds = [eq(spaceTasks.locationId, locationId)];
    const resourceId = queryString(req, 'resourceId');
    if (resourceId) conds.push(eq(spaceTasks.resourceId, resourceId));
    if (queryString(req, 'all') !== '1') conds.push(eq(spaceTasks.active, true));
    const rows = await db
      .select({ t: spaceTasks, resourceName: resources.name })
      .from(spaceTasks)
      .leftJoin(resources, eq(resources.id, spaceTasks.resourceId))
      .where(and(...conds))
      .orderBy(asc(spaceTasks.nextDue))
      .limit(500)
      .all();
    res.json(rows.map(({ t, resourceName }) => ({ ...t, resourceName, overdue: t.active && t.nextDue < today })));
  });

  r.post('/', async (req, res) => {
    const body = parse(taskFields.partial({ resourceId: true, kind: true, notes: true, everyDays: true, nextDue: true, active: true }).extend({ locationId: z.string() }), req.body);
    assertLocation(req.user!, body.locationId);
    await checkSpace(db, body.locationId, body.resourceId);
    const today = todayIn((await loadLocation(db, body.locationId)).timezone);
    res.status(201).json(await db.insert(spaceTasks).values({ resourceId: null, kind: 'cleaning', notes: '', everyDays: null, active: true, ...body, nextDue: body.nextDue ?? today }).returning().get());
  });

  const load = async (req: Parameters<typeof idParam>[0]) => {
    const t = await db.select().from(spaceTasks).where(eq(spaceTasks.id, idParam(req))).get();
    if (!t) throw notFound('Task');
    assertLocation(req.user!, t.locationId);
    return t;
  };

  r.patch('/:id', async (req, res) => {
    const body = parse(taskFields.partial(), req.body);
    const t = await load(req);
    await checkSpace(db, t.locationId, body.resourceId);
    res.json(await db.update(spaceTasks).set(body).where(eq(spaceTasks.id, t.id)).returning().get());
  });

  r.delete('/:id', async (req, res) => {
    const t = await load(req);
    await db.delete(taskLogs).where(eq(taskLogs.taskId, t.id)).run();
    await db.delete(spaceTasks).where(eq(spaceTasks.id, t.id)).run();
    res.status(204).end();
  });

  // Marking it done is logged. A repeating job comes round again that many days later; a one-off is finished.
  r.post('/:id/done', async (req, res) => {
    const body = parse(z.object({ note: z.string().trim().max(500).default('') }), req.body);
    const t = await load(req);
    const today = todayIn((await loadLocation(db, t.locationId)).timezone);
    const updated = await db.transaction(async (tx) => {
      await tx.insert(taskLogs).values({ taskId: t.id, doneAt: new Date().toISOString(), doneById: req.user!.id, note: body.note }).run();
      return tx
        .update(spaceTasks)
        .set(t.everyDays ? { nextDue: addDays(today, t.everyDays), lastDoneAt: new Date().toISOString() } : { active: false, lastDoneAt: new Date().toISOString() })
        .where(eq(spaceTasks.id, t.id))
        .returning()
        .get();
    });
    res.json(updated);
  });

  r.get('/:id/logs', async (req, res) => {
    const t = await load(req);
    res.json(
      await db
        .select({ id: taskLogs.id, doneAt: taskLogs.doneAt, note: taskLogs.note, doneBy: users.name })
        .from(taskLogs)
        .innerJoin(users, eq(users.id, taskLogs.doneById))
        .where(eq(taskLogs.taskId, t.id))
        .orderBy(desc(taskLogs.doneAt))
        .limit(50)
        .all(),
    );
  });

  return r;
}

// ---------------------------------------------------------------------------------------------
// Equipment

const assetFields = z.object({
  resourceId: z.string().nullable(),
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().max(60),
  serialNumber: z.string().trim().max(80),
  purchasedOn: dateStr.nullable(),
  warrantyUntil: dateStr.nullable(),
  status: z.enum(ASSET_STATUSES),
  notes: z.string().trim().max(1000),
});

export function assetsRouter(db: Db) {
  const r = Router();
  r.use(requirePermission('maintenance'));

  r.get('/', async (req, res) => {
    const locationId = requireLocationId(req);
    const conds = [eq(spaceAssets.locationId, locationId)];
    const resourceId = queryString(req, 'resourceId');
    if (resourceId) conds.push(eq(spaceAssets.resourceId, resourceId));
    const status = queryString(req, 'status');
    if (status) {
      if (!(ASSET_STATUSES as readonly string[]).includes(status)) throw badRequest('Unknown status');
      conds.push(eq(spaceAssets.status, status as (typeof ASSET_STATUSES)[number]));
    }
    const rows = await db
      .select({ a: spaceAssets, resourceName: resources.name })
      .from(spaceAssets)
      .leftJoin(resources, eq(resources.id, spaceAssets.resourceId))
      .where(and(...conds))
      .orderBy(asc(spaceAssets.name))
      .limit(1000)
      .all();
    res.json(rows.map(({ a, resourceName }) => ({ ...a, resourceName })));
  });

  r.post('/', async (req, res) => {
    const body = parse(assetFields.partial({ resourceId: true, category: true, serialNumber: true, purchasedOn: true, warrantyUntil: true, status: true, notes: true }).extend({ locationId: z.string() }), req.body);
    assertLocation(req.user!, body.locationId);
    await checkSpace(db, body.locationId, body.resourceId);
    res.status(201).json(await db.insert(spaceAssets).values({ resourceId: null, purchasedOn: null, warrantyUntil: null, ...body }).returning().get());
  });

  const load = async (req: Parameters<typeof idParam>[0]) => {
    const a = await db.select().from(spaceAssets).where(eq(spaceAssets.id, idParam(req))).get();
    if (!a) throw notFound('Equipment');
    assertLocation(req.user!, a.locationId);
    return a;
  };

  r.patch('/:id', async (req, res) => {
    const body = parse(assetFields.partial(), req.body);
    const a = await load(req);
    await checkSpace(db, a.locationId, body.resourceId);
    res.json(await db.update(spaceAssets).set(body).where(eq(spaceAssets.id, a.id)).returning().get());
  });

  r.delete('/:id', async (req, res) => {
    const a = await load(req);
    await db.delete(spaceAssets).where(eq(spaceAssets.id, a.id)).run();
    res.status(204).end();
  });

  return r;
}

// ---------------------------------------------------------------------------------------------
// Problems reported about a space

export function issuesRouter(db: Db) {
  const r = Router();

  const shape = (rows: { i: typeof issues.$inferSelect; resourceName: string; reporter: string }[]) => rows.map(({ i, ...rest }) => ({ ...i, ...rest }));

  /** Anyone who can see the location can report a problem with a space in it: members, and every team member. */
  r.post('/', async (req, res) => {
    const body = parse(
      z.object({
        resourceId: z.string(),
        title: z.string().trim().min(1).max(150),
        description: z.string().trim().max(2000).default(''),
        priority: z.enum(ISSUE_PRIORITIES).default('normal'),
      }),
      req.body,
    );
    const space = await db.select().from(resources).where(eq(resources.id, body.resourceId)).get();
    if (!space) throw notFound('Space');
    assertLocation(req.user!, space.locationId);
    res.status(201).json(await db.insert(issues).values({ ...body, locationId: space.locationId, reportedById: req.user!.id }).returning().get());
  });

  /** The team member who handles maintenance sees everything; everyone else sees what they reported themselves. */
  r.get('/', async (req, res) => {
    const locationId = requireLocationId(req);
    const user = req.user!;
    const conds = [eq(issues.locationId, locationId)];
    if (!can(user, 'maintenance')) conds.push(eq(issues.reportedById, user.id));
    const status = queryString(req, 'status');
    if (status) {
      if (!(ISSUE_STATUSES as readonly string[]).includes(status)) throw badRequest('Unknown status');
      conds.push(eq(issues.status, status as (typeof ISSUE_STATUSES)[number]));
    }
    const resourceId = queryString(req, 'resourceId');
    if (resourceId) conds.push(eq(issues.resourceId, resourceId));
    res.json(
      shape(
        await db
          .select({ i: issues, resourceName: resources.name, reporter: users.name })
          .from(issues)
          .innerJoin(resources, eq(resources.id, issues.resourceId))
          .innerJoin(users, eq(users.id, issues.reportedById))
          .where(and(...conds))
          .orderBy(desc(issues.createdAt))
          .limit(500)
          .all(),
      ),
    );
  });

  const load = async (req: Parameters<typeof idParam>[0]) => {
    const i = await db.select().from(issues).where(eq(issues.id, idParam(req))).get();
    if (!i) throw notFound('Issue');
    assertLocation(req.user!, i.locationId);
    return i;
  };

  r.patch('/:id', requirePermission('maintenance'), async (req, res) => {
    const body = parse(z.object({ status: z.enum(ISSUE_STATUSES), priority: z.enum(ISSUE_PRIORITIES), resolution: z.string().trim().max(1000) }).partial(), req.body);
    const i = await load(req);
    const resolvedAt = body.status === undefined ? undefined : body.status === 'resolved' ? new Date().toISOString() : null;
    res.json(await db.update(issues).set({ ...body, ...(resolvedAt !== undefined ? { resolvedAt } : {}) }).where(eq(issues.id, i.id)).returning().get());
  });

  /** Turns a report into a job on the maintenance schedule, due today, and marks it as being worked on. */
  r.post('/:id/task', requirePermission('maintenance'), async (req, res) => {
    const i = await load(req);
    if (i.taskId) throw badRequest('A task was already made from this report');
    const today = todayIn((await loadLocation(db, i.locationId)).timezone);
    const made = await db.transaction(async (tx) => {
      const t = await tx.insert(spaceTasks).values({ locationId: i.locationId, resourceId: i.resourceId, kind: 'maintenance', title: `Fix: ${i.title}`.slice(0, 150), notes: i.description, nextDue: today }).returning().get();
      await tx.update(issues).set({ taskId: t.id, status: i.status === 'open' ? 'in_progress' : i.status }).where(eq(issues.id, i.id)).run();
      return t;
    });
    res.status(201).json(made);
  });

  // Space ids with something open against them, for badges. Team members who handle maintenance only.
  r.get('/open/by-space', requirePermission('maintenance'), async (req, res) => {
    const locationId = requireLocationId(req);
    const rows = await db
      .select({ resourceId: issues.resourceId })
      .from(issues)
      .where(and(eq(issues.locationId, locationId), inArray(issues.status, ['open', 'in_progress'])))
      .all();
    const counts: Record<string, number> = {};
    for (const x of rows) counts[x.resourceId] = (counts[x.resourceId] ?? 0) + 1;
    res.json(counts);
  });

  return r;
}
