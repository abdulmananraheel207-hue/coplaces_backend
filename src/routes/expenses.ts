import { Router } from 'express';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { EXPENSE_CATEGORIES, expenses } from '../db/schema.js';
import { loadLocation, requireLocationId } from '../lib/access.js';
import { assertLocation } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { idParam, queryString } from '../lib/http.js';
import { isValidDate, todayIn } from '../lib/time.js';
import { parse } from '../lib/validate.js';

const fields = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  vendor: z.string().trim().max(120),
  description: z.string().trim().max(300),
  amountCents: z.number().int().min(1),
  incurredOn: z.string().refine(isValidDate, 'Use YYYY-MM-DD'),
});

/** Mounted behind the expenses permission. */
export function expensesRouter(db: Db) {
  const r = Router();

  r.get('/', async (req, res) => {
    const locationId = requireLocationId(req);
    const conds = [eq(expenses.locationId, locationId)];
    const category = queryString(req, 'category');
    if (category) {
      if (!(EXPENSE_CATEGORIES as readonly string[]).includes(category)) throw badRequest('Unknown category');
      conds.push(eq(expenses.category, category as (typeof EXPENSE_CATEGORIES)[number]));
    }
    const from = queryString(req, 'from');
    const to = queryString(req, 'to');
    if (from) conds.push(gte(expenses.incurredOn, from));
    if (to) conds.push(lte(expenses.incurredOn, to));
    res.json(
      await db
        .select()
        .from(expenses)
        .where(and(...conds))
        .orderBy(desc(expenses.incurredOn), desc(expenses.createdAt))
        .limit(500)
        .all(),
    );
  });

  r.post('/', async (req, res) => {
    const body = parse(
      fields.partial({ vendor: true, description: true, incurredOn: true }).extend({ locationId: z.string() }),
      req.body,
    );
    assertLocation(req.user!, body.locationId);
    const loc = await loadLocation(db, body.locationId);
    res
      .status(201)
      .json(
        await db
          .insert(expenses)
          .values({ ...body, incurredOn: body.incurredOn ?? todayIn(loc.timezone), createdById: req.user!.id })
          .returning()
          .get(),
      );
  });

  r.patch('/:id', async (req, res) => {
    const body = parse(fields.partial(), req.body);
    const e = await db.select().from(expenses).where(eq(expenses.id, idParam(req))).get();
    if (!e) throw notFound('Expense');
    assertLocation(req.user!, e.locationId);
    res.json(await db.update(expenses).set(body).where(eq(expenses.id, e.id)).returning().get());
  });

  r.delete('/:id', async (req, res) => {
    const e = await db.select().from(expenses).where(eq(expenses.id, idParam(req))).get();
    if (!e) throw notFound('Expense');
    assertLocation(req.user!, e.locationId);
    await db.delete(expenses).where(eq(expenses.id, e.id)).run();
    res.status(204).end();
  });

  return r;
}
