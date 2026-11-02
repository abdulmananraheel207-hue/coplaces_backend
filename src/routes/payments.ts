import { Router } from 'express';
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { PAYMENT_METHODS, invoices, members, payments, users } from '../db/schema.js';
import { loadLocation, requireLocationId } from '../lib/access.js';
import { assertLocation, assertSees } from '../lib/auth.js';
import { requirePermission } from '../lib/permissions.js';
import { badRequest, notFound } from '../lib/errors.js';
import { idParam, queryString } from '../lib/http.js';
import { addDays, isValidDate, zonedToUtc } from '../lib/time.js';
import { reversePayment } from '../services/billing.js';
import { z } from 'zod';
import { parse } from '../lib/validate.js';

export function paymentsRouter(db: Db) {
  const r = Router();

  r.get('/', requirePermission('invoices'), async (req, res) => {
    const locationId = requireLocationId(req);
    const loc = await loadLocation(db, locationId);
    const conds = [eq(payments.locationId, locationId)];
    const method = queryString(req, 'method');
    if (method) {
      if (!(PAYMENT_METHODS as readonly string[]).includes(method)) throw badRequest('Unknown method');
      conds.push(eq(payments.method, method as (typeof PAYMENT_METHODS)[number]));
    }
    const from = queryString(req, 'from');
    const to = queryString(req, 'to');
    if (from) {
      if (!isValidDate(from)) throw badRequest('from must be YYYY-MM-DD');
      conds.push(gte(payments.paidAt, zonedToUtc(from, '00:00', loc.timezone).toISOString()));
    }
    if (to) {
      if (!isValidDate(to)) throw badRequest('to must be YYYY-MM-DD');
      conds.push(lt(payments.paidAt, zonedToUtc(addDays(to, 1), '00:00', loc.timezone).toISOString()));
    }
    const rows = await db
      .select({ p: payments, invoiceNumber: invoices.number, memberName: users.name })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .innerJoin(members, eq(members.id, payments.memberId))
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(...conds))
      .orderBy(desc(payments.paidAt))
      .limit(500)
      .all();
    res.json(rows.map(({ p, ...rest }) => ({ ...p, ...rest })));
  });

  const reverse = async (req: Parameters<typeof idParam>[0], reason: string) => {
    const p = await db.select().from(payments).where(eq(payments.id, idParam(req))).get();
    if (!p) throw notFound('Payment');
    assertSees(req.user!, p.locationId, 'Payment');
    return reversePayment(db, p.id, req.user!.id, reason);
  };

  /**
   * Takes back a payment that was recorded by mistake. Nothing is deleted: a reversal is written (see reversePayment), and the
   * invoice's status is re-derived. Returns the invoice. DELETE is kept for the existing screens; POST /:id/reverse takes a reason.
   */
  r.delete('/:id', requirePermission('billing_admin'), async (req, res) => {
    res.json(await reverse(req, ''));
  });

  r.post('/:id/reverse', requirePermission('billing_admin'), async (req, res) => {
    const body = parse(z.object({ reason: z.string().trim().max(300).default('') }), req.body ?? {});
    res.json(await reverse(req, body.reason));
  });

  return r;
}
