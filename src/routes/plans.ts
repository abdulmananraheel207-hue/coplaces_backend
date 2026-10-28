import { Router } from 'express';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { PLAN_INTERVALS, members, plans, shiftTemplates } from '../db/schema.js';
import { requireLocationId } from '../lib/access.js';
import { assertLocation, staffOnly } from '../lib/auth.js';
import { requirePermission } from '../lib/permissions.js';
import { notFound } from '../lib/errors.js';
import { idParam } from '../lib/http.js';
import { parse } from '../lib/validate.js';

const fields = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500),
  interval: z.enum(PLAN_INTERVALS),
  priceCents: z.number().int().min(0),
  includedMeetingMinutes: z.number().int().min(0).max(100_000),
  includesHotDesk: z.boolean(),
  active: z.boolean(),
});

export function plansRouter(db: Db) {
  const r = Router();

  r.get('/', staffOnly, async (req, res) => {
    const locationId = requireLocationId(req);
    res.json(await db.select().from(plans).where(eq(plans.locationId, locationId)).orderBy(asc(plans.priceCents)).all());
  });

  r.post('/', requirePermission('plans'), async (req, res) => {
    const body = parse(
      fields.partial({ description: true, interval: true, priceCents: true, includedMeetingMinutes: true, includesHotDesk: true, active: true })
        .extend({ locationId: z.string() }),
      req.body,
    );
    assertLocation(req.user!, body.locationId);
    // A plan has no price of its own: what members pay comes from its shifts.
    res.status(201).json(await db.insert(plans).values({ ...body, priceCents: body.priceCents ?? 0 }).returning().get());
  });

  r.patch('/:id', requirePermission('plans'), async (req, res) => {
    const body = parse(fields.partial(), req.body);
    const plan = await db.select().from(plans).where(eq(plans.id, idParam(req))).get();
    if (!plan) throw notFound('Plan');
    assertLocation(req.user!, plan.locationId);
    res.json(await db.update(plans).set(body).where(and(eq(plans.id, plan.id))).returning().get());
  });

  /** Deleting a plan also deletes its shifts, and members on it are left without a plan. */
  r.delete('/:id', requirePermission('plans'), async (req, res) => {
    const plan = await db.select().from(plans).where(eq(plans.id, idParam(req))).get();
    if (!plan) throw notFound('Plan');
    assertLocation(req.user!, plan.locationId);
    await db.transaction(async (tx) => {
      await tx.update(members).set({ planId: null }).where(eq(members.planId, plan.id)).run();
      await tx.delete(shiftTemplates).where(eq(shiftTemplates.planId, plan.id)).run();
      await tx.delete(plans).where(eq(plans.id, plan.id)).run();
    });
    res.status(204).end();
  });

  return r;
}
