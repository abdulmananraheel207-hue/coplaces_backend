import { Router } from 'express';
import { and, asc, desc, eq, like, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { invoiceItems, invoices, members, payments, users } from '../db/schema.js';
import { assertMemberAccess, loadLocation, loadMember, requireLocationId } from '../lib/access.js';
import { assertLocation, isStaff } from '../lib/auth.js';
import { assertCan, requirePermission } from '../lib/permissions.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { idParam, queryString } from '../lib/http.js';
import { addDays, isValidDate, MONTH_RE, todayIn } from '../lib/time.js';
import { parse } from '../lib/validate.js';
import { createInvoice, generateSubscriptionInvoices, recordPayment, voidInvoice, withBalance } from '../services/billing.js';
import { PAYMENT_METHODS } from '../db/schema.js';

const dateStr = z.string().refine(isValidDate, 'Use YYYY-MM-DD');

export function invoicesRouter(db: Db) {
  const r = Router();

  r.get('/', async (req, res) => {
    const locationId = requireLocationId(req);
    const loc = await loadLocation(db, locationId);
    const user = req.user!;
    const today = todayIn(loc.timezone);
    const conds = [eq(invoices.locationId, locationId)];

    if (isStaff(user)) assertCan(user, 'invoices');
    const memberId = isStaff(user) ? queryString(req, 'memberId') : user.memberId!;
    if (memberId) conds.push(eq(invoices.memberId, memberId));

    const status = queryString(req, 'status');
    if (status === 'overdue') conds.push(eq(invoices.status, 'open'), lt(invoices.dueDate, today));
    else if (status === 'open' || status === 'paid' || status === 'void') conds.push(eq(invoices.status, status));
    else if (status) throw badRequest('Unknown status');

    const q = queryString(req, 'q');
    if (q) {
      const pat = `%${q.replace(/[%_]/g, '')}%`;
      conds.push(or(like(invoices.number, pat), like(users.name, pat))!);
    }

    const rows = await db
      .select({ inv: invoices, memberName: users.name, company: members.company })
      .from(invoices)
      .innerJoin(members, eq(members.id, invoices.memberId))
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(...conds))
      .orderBy(desc(invoices.issueDate), desc(invoices.number))
      .limit(500)
      .all();
    res.json(rows.map(({ inv, ...rest }) => ({ ...withBalance(inv, today), ...rest })));
  });

  r.get('/:id', async (req, res) => {
    const inv = await db.select().from(invoices).where(eq(invoices.id, idParam(req))).get();
    if (!inv) throw notFound('Invoice');
    const user = req.user!;
    if (isStaff(user)) {
      assertCan(user, 'invoices');
      assertLocation(user, inv.locationId);
    } else if (user.memberId !== inv.memberId) throw forbidden();

    const loc = await loadLocation(db, inv.locationId);
    const { member, user: memberUser } = await loadMember(db, inv.memberId);
    res.json({
      ...withBalance(inv, todayIn(loc.timezone)),
      memberName: memberUser.name,
      memberEmail: memberUser.email,
      company: member.company,
      currency: loc.currency,
      timezone: loc.timezone,
      location: { name: loc.name, address: loc.address },
      items: await db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, inv.id)).all(),
      payments: await db.select().from(payments).where(eq(payments.invoiceId, inv.id)).orderBy(asc(payments.paidAt)).all(),
    });
  });

  r.post('/', requirePermission('invoices'), async (req, res) => {
    const body = parse(
      z.object({
        memberId: z.string(),
        issueDate: dateStr.optional(),
        dueDate: dateStr.optional(),
        notes: z.string().trim().max(1000).default(''),
        items: z
          .array(
            z.object({
              description: z.string().trim().min(1).max(200),
              quantity: z.number().int().min(1).max(10_000).default(1),
              unitPriceCents: z.number().int().min(0),
            }),
          )
          .min(1)
          .max(100),
      }),
      req.body,
    );
    const { member } = await loadMember(db, body.memberId);
    assertLocation(req.user!, member.locationId);
    const loc = await loadLocation(db, member.locationId);
    const issueDate = body.issueDate ?? todayIn(loc.timezone);
    const dueDate = body.dueDate ?? addDays(issueDate, 14);
    if (dueDate < issueDate) throw badRequest('Due date is before issue date');

    const inv = await db.transaction((tx) =>
      createInvoice(tx, { locationId: loc.id, memberId: member.id, kind: 'manual', issueDate, dueDate, items: body.items, notes: body.notes }),
    );
    res.status(201).json(inv);
  });

  r.post('/generate', requirePermission('billing_admin'), async (req, res) => {
    const body = parse(
      z.object({
        locationId: z.string(),
        month: z.string().regex(MONTH_RE, 'Use YYYY-MM'),
        dueInDays: z.number().int().min(0).max(120).default(7),
      }),
      req.body,
    );
    assertLocation(req.user!, body.locationId);
    const { created, skipped } = await generateSubscriptionInvoices(db, body);
    res.status(201).json({ created: created.length, skipped, invoices: created });
  });

  r.post('/:id/void', requirePermission('billing_admin'), async (req, res) => {
    const inv = await db.select().from(invoices).where(eq(invoices.id, idParam(req))).get();
    if (!inv) throw notFound('Invoice');
    assertLocation(req.user!, inv.locationId);
    res.json(await voidInvoice(db, inv.id));
  });

  r.post('/:id/payments', requirePermission('invoices'), async (req, res) => {
    const body = parse(
      z.object({
        amountCents: z.number().int().min(1),
        method: z.enum(PAYMENT_METHODS),
        paidAt: z.iso.datetime().optional(),
        reference: z.string().trim().max(200).default(''),
        notes: z.string().trim().max(500).default(''),
      }),
      req.body,
    );
    const inv = await db.select().from(invoices).where(eq(invoices.id, idParam(req))).get();
    if (!inv) throw notFound('Invoice');
    assertLocation(req.user!, inv.locationId);
    const out = await recordPayment(db, {
      invoiceId: inv.id,
      amountCents: body.amountCents,
      method: body.method,
      paidAt: body.paidAt ?? new Date().toISOString(),
      reference: body.reference,
      notes: body.notes,
      recordedById: req.user!.id,
    });
    res.status(201).json(out);
  });

  return r;
}
