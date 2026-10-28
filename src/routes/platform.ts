import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { and, asc, desc, eq, gte, lt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import type { Db } from '../db/client.js';
import {
  ORG_STATUSES,
  PACKAGE_INTERVALS,
  PAYMENT_METHODS,
  locations,
  organizations,
  packages,
  platformPayments,
  users,
} from '../db/schema.js';
import { CORE_FEATURES, FEATURES, normalizeFeatures, parseFeatures, unknownFeatures } from '../features.js';
import { orgUsage, superAdminOnly } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { idParam } from '../lib/http.js';
import { tempPassword } from '../lib/passwords.js';
import { addDays, addMonthsToDate, daysBetween, isValidDate, isValidTimezone, monthRange, todayIn } from '../lib/time.js';
import { parse } from '../lib/validate.js';

type Package = typeof packages.$inferSelect;
type Organization = typeof organizations.$inferSelect;

const dateStr = z.string().refine(isValidDate, 'Use YYYY-MM-DD');
const limit = z.number().int().min(1).max(1_000_000).nullable();

const packageFields = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
  interval: z.enum(PACKAGE_INTERVALS),
  priceCents: z.number().int().min(0).max(100_000_000_000),
  features: z.array(z.string()),
  maxLocations: limit,
  maxFloors: limit,
  maxMembers: limit,
  active: z.boolean(),
});

const shapePackage = (p: Package, tenants = 0) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  interval: p.interval,
  priceCents: p.priceCents,
  features: parseFeatures(p.features),
  maxLocations: p.maxLocations,
  maxFloors: p.maxFloors,
  maxMembers: p.maxMembers,
  active: p.active,
  tenants,
});

const today = () => todayIn(config.platformTimezone);
const isExpired = (o: Organization) => (o.status === 'trial' || o.status === 'active') && o.periodEnd < today();
const monthlyCents = (p: Package) => (p.interval === 'year' ? Math.round(p.priceCents / 12) : p.priceCents);

async function requireActivePackage(db: Db, id: string, currentId?: string) {
  const pkg = await db.select().from(packages).where(eq(packages.id, id)).get();
  if (!pkg) throw badRequest('Unknown package');
  if (!pkg.active && pkg.id !== currentId) throw badRequest(`${pkg.name} is not offered any more`);
  return pkg;
}

async function loadOrg(db: Db, id: string) {
  const org = await db.select().from(organizations).where(eq(organizations.id, id)).get();
  if (!org) throw notFound('Coworking space');
  return org;
}

function owners(db: Db, organizationId: string) {
  return db
    .select({ id: users.id, name: users.name, email: users.email, phone: users.phone, active: users.active, lastLoginAt: users.lastLoginAt })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.role, 'owner')))
    .orderBy(asc(users.createdAt))
    .all();
}

async function summarise(db: Db, org: Organization, pkg: Package) {
  const usage = await orgUsage(db, org.id);
  const [owner] = await owners(db, org.id);
  return {
    id: org.id,
    name: org.name,
    city: org.city,
    status: org.status,
    expired: isExpired(org),
    periodEnd: org.periodEnd,
    package: { id: pkg.id, name: pkg.name, priceCents: pkg.priceCents, interval: pkg.interval },
    usage,
    owner: owner ? { name: owner.name, email: owner.email, lastLoginAt: owner.lastLoginAt } : null,
    createdAt: org.createdAt,
  };
}

/** The platform operator's console: tenants, packages and what tenants pay. Super admin only. */
export function platformRouter(db: Db) {
  const r = Router();
  r.use(superAdminOnly);

  r.get('/features', (_req, res) => {
    res.json({ features: FEATURES, core: CORE_FEATURES });
  });

  // ---- Packages ------------------------------------------------------------

  r.get('/packages', async (_req, res) => {
    const counts = await db
      .select({ packageId: organizations.packageId, n: sql<number>`count(*)` })
      .from(organizations)
      .groupBy(organizations.packageId)
      .all();
    const rows = await db.select().from(packages).orderBy(asc(packages.priceCents)).all();
    res.json(rows.map((p) => shapePackage(p, counts.find((c) => c.packageId === p.id)?.n ?? 0)));
  });

  const checkFeatures = (keys: string[]) => {
    const bad = unknownFeatures(keys);
    if (bad.length) throw badRequest(`Unknown feature: ${bad.join(', ')}`);
    return JSON.stringify(normalizeFeatures(keys));
  };

  r.post('/packages', async (req, res) => {
    const body = parse(packageFields.partial({ description: true, maxLocations: true, maxFloors: true, maxMembers: true, active: true }), req.body);
    const created = await db
      .insert(packages)
      .values({
        name: body.name,
        description: body.description ?? '',
        interval: body.interval,
        priceCents: body.priceCents,
        features: checkFeatures(body.features),
        maxLocations: body.maxLocations ?? null,
        maxFloors: body.maxFloors ?? null,
        maxMembers: body.maxMembers ?? null,
        active: body.active ?? true,
      })
      .returning()
      .get();
    res.status(201).json(shapePackage(created));
  });

  r.patch('/packages/:id', async (req, res) => {
    const body = parse(packageFields.partial(), req.body);
    const current = await db.select().from(packages).where(eq(packages.id, idParam(req))).get();
    if (!current) throw notFound('Package');
    const { features, ...rest } = body;
    const patch: Partial<typeof packages.$inferInsert> = { ...rest };
    if (features) patch.features = checkFeatures(features);
    const updated = Object.keys(patch).length
      ? await db.update(packages).set(patch).where(eq(packages.id, current.id)).returning().get()
      : current;
    const tenants = (await db.select({ n: sql<number>`count(*)` }).from(organizations).where(eq(organizations.packageId, current.id)).get())!.n;
    res.json(shapePackage(updated, tenants));
  });

  // ---- Coworking spaces (tenants) -----------------------------------------

  r.get('/organizations', async (_req, res) => {
    const rows = await db
      .select({ org: organizations, pkg: packages })
      .from(organizations)
      .innerJoin(packages, eq(packages.id, organizations.packageId))
      .orderBy(asc(organizations.name))
      .all();
    res.json(await Promise.all(rows.map(({ org, pkg }) => summarise(db, org, pkg))));
  });

  r.post('/organizations', async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(120),
        contactEmail: z.string().trim().max(200).default(''),
        phone: z.string().trim().max(40).default(''),
        city: z.string().trim().max(80).default(''),
        packageId: z.string(),
        status: z.enum(['trial', 'active']).default('trial'),
        periodEnd: dateStr.optional(),
        notes: z.string().trim().max(2000).default(''),
        owner: z.object({
          name: z.string().trim().min(1).max(100),
          email: z.string().trim().toLowerCase().pipe(z.email()),
          phone: z.string().trim().max(40).default(''),
        }),
        location: z.object({
          name: z.string().trim().min(1).max(100),
          code: z
            .string()
            .trim()
            .toUpperCase()
            .regex(/^[A-Z0-9]{2,6}$/, 'Code must be 2–6 letters or digits'),
          address: z.string().trim().max(300).default(''),
          timezone: z.string().refine(isValidTimezone, 'Unknown timezone').default('Asia/Karachi'),
          currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('PKR'),
          taxRateBps: z.number().int().min(0).max(10_000).default(0),
        }),
      }),
      req.body,
    );
    const pkg = await requireActivePackage(db, body.packageId);
    if (await db.select({ id: users.id }).from(users).where(eq(users.email, body.owner.email)).get()) {
      throw conflict('That owner email is already in use');
    }
    const periodEnd =
      body.periodEnd ?? (body.status === 'trial' ? addDays(today(), 14) : addMonthsToDate(today(), pkg.interval === 'year' ? 12 : 1));

    const password = tempPassword();
    const passwordHash = await bcrypt.hash(password, 10);
    const created = await db.transaction(async (tx) => {
      const org = await tx
        .insert(organizations)
        .values({
          name: body.name,
          contactEmail: body.contactEmail,
          phone: body.phone,
          city: body.city,
          packageId: pkg.id,
          status: body.status,
          periodEnd,
          notes: body.notes,
        })
        .returning()
        .get();
      await tx.insert(locations).values({ ...body.location, organizationId: org.id }).run();
      await tx.insert(users)
        .values({ organizationId: org.id, name: body.owner.name, email: body.owner.email, phone: body.owner.phone, role: 'owner', passwordHash })
        .run();
      return org;
    });
    res.status(201).json({ ...await summarise(db, created, pkg), owner: { ...body.owner, tempPassword: password } });
  });

  r.get('/organizations/:id', async (req, res) => {
    const org = await loadOrg(db, idParam(req));
    const pkg = (await db.select().from(packages).where(eq(packages.id, org.packageId)).get())!;
    res.json({
      ...await summarise(db, org, pkg),
      contactEmail: org.contactEmail,
      phone: org.phone,
      notes: org.notes,
      package: shapePackage(pkg),
      owners: await owners(db, org.id),
      locations: await db
        .select({ id: locations.id, name: locations.name, code: locations.code, timezone: locations.timezone, currency: locations.currency, address: locations.address })
        .from(locations)
        .where(eq(locations.organizationId, org.id))
        .orderBy(asc(locations.name))
        .all(),
      payments: await db
        .select()
        .from(platformPayments)
        .where(eq(platformPayments.organizationId, org.id))
        .orderBy(desc(platformPayments.paidAt))
        .limit(20)
        .all(),
    });
  });

  r.patch('/organizations/:id', async (req, res) => {
    const body = parse(
      z
        .object({
          name: z.string().trim().min(1).max(120),
          contactEmail: z.string().trim().max(200),
          phone: z.string().trim().max(40),
          city: z.string().trim().max(80),
          packageId: z.string(),
          status: z.enum(ORG_STATUSES),
          periodEnd: dateStr,
          notes: z.string().trim().max(2000),
        })
        .partial(),
      req.body,
    );
    const org = await loadOrg(db, idParam(req));
    if (body.packageId) await requireActivePackage(db, body.packageId, org.packageId);
    const updated = Object.keys(body).length
      ? await db.update(organizations).set(body).where(eq(organizations.id, org.id)).returning().get()
      : org;
    const pkg = (await db.select().from(packages).where(eq(packages.id, updated.packageId)).get())!;
    res.json(await summarise(db, updated, pkg));
  });

  r.post('/organizations/:id/reset-owner-password', async (req, res) => {
    const org = await loadOrg(db, idParam(req));
    const body = parse(z.object({ userId: z.string().optional() }), req.body);
    const list = await owners(db, org.id);
    const owner = body.userId ? list.find((o) => o.id === body.userId) : list[0];
    if (!owner) throw notFound('Owner account');
    const password = tempPassword();
    await db.update(users).set({ passwordHash: await bcrypt.hash(password, 10) }).where(eq(users.id, owner.id)).run();
    res.json({ name: owner.name, email: owner.email, tempPassword: password });
  });

  /** Records money received from a tenant and extends their subscription by the paid periods. */
  r.post('/organizations/:id/payments', async (req, res) => {
    const body = parse(
      z.object({
        amountCents: z.number().int().min(1),
        method: z.enum(PAYMENT_METHODS),
        periods: z.number().int().min(1).max(36).default(1),
        reference: z.string().trim().max(200).default(''),
        notes: z.string().trim().max(500).default(''),
        paidAt: z.iso.datetime().optional(),
      }),
      req.body,
    );
    const org = await loadOrg(db, idParam(req));
    const pkg = (await db.select().from(packages).where(eq(packages.id, org.packageId)).get())!;
    const t = today();
    const periodStart = org.periodEnd >= t ? org.periodEnd : t;
    const periodEnd = addMonthsToDate(periodStart, body.periods * (pkg.interval === 'year' ? 12 : 1));

    const result = await db.transaction(async (tx) => {
      const payment = await tx
        .insert(platformPayments)
        .values({
          organizationId: org.id,
          packageId: pkg.id,
          amountCents: body.amountCents,
          method: body.method,
          reference: body.reference,
          notes: body.notes,
          periodStart,
          periodEnd,
          paidAt: body.paidAt ?? new Date().toISOString(),
          recordedById: req.user!.id,
        })
        .returning()
        .get();
      const updated = await tx
        .update(organizations)
        .set({ periodEnd, status: org.status === 'trial' ? 'active' : org.status })
        .where(eq(organizations.id, org.id))
        .returning()
        .get();
      return { payment, organization: await summarise(tx as unknown as Db, updated, pkg) };
    });
    res.status(201).json(result);
  });

  // ---- Payments and overview ----------------------------------------------

  r.get('/payments', async (_req, res) => {
    const rows = await db
      .select({ p: platformPayments, organizationName: organizations.name, packageName: packages.name })
      .from(platformPayments)
      .innerJoin(organizations, eq(organizations.id, platformPayments.organizationId))
      .innerJoin(packages, eq(packages.id, platformPayments.packageId))
      .orderBy(desc(platformPayments.paidAt))
      .limit(500)
      .all();
    res.json(rows.map(({ p, ...rest }) => ({ ...p, ...rest })));
  });

  r.get('/overview', async (_req, res) => {
    const t = today();
    const month = monthRange(t.slice(0, 7), config.platformTimezone);
    const rows = await db
      .select({ org: organizations, pkg: packages })
      .from(organizations)
      .innerJoin(packages, eq(packages.id, organizations.packageId))
      .all();

    const count = (s: string) => rows.filter((x) => x.org.status === s).length;
    const mrrCents = rows.filter((x) => x.org.status === 'active').reduce((sum, x) => sum + monthlyCents(x.pkg), 0);
    const collected = (await db
      .select({ v: sql<number>`coalesce(sum(${platformPayments.amountCents}), 0)` })
      .from(platformPayments)
      .where(and(gte(platformPayments.paidAt, month.start), lt(platformPayments.paidAt, month.end)))
      .get())!.v;

    const memberTotal = (await db.select({ n: sql<number>`count(*)` }).from(users).where(eq(users.role, 'member')).get())!.n;
    const staffTotal = (await db.select({ n: sql<number>`count(*)` }).from(users).where(and(ne(users.role, 'member'), ne(users.role, 'superadmin'))).get())!.n;
    const locationTotal = (await db.select({ n: sql<number>`count(*)` }).from(locations).get())!.n;

    const attention = rows
      .filter((x) => (x.org.status === 'trial' || x.org.status === 'active') && daysBetween(t, x.org.periodEnd) <= 14)
      .map((x) => ({ id: x.org.id, name: x.org.name, status: x.org.status, periodEnd: x.org.periodEnd, daysLeft: daysBetween(t, x.org.periodEnd), package: x.pkg.name }))
      .sort((a, b) => a.daysLeft - b.daysLeft);

    const byPackage = await db
      .select({ id: packages.id, name: packages.name, tenants: sql<number>`count(${organizations.id})` })
      .from(packages)
      .leftJoin(organizations, eq(organizations.packageId, packages.id))
      .groupBy(packages.id)
      .orderBy(asc(packages.priceCents))
      .all();

    res.json({
      today: t,
      currency: 'PKR',
      organizations: { total: rows.length, trial: count('trial'), active: count('active'), suspended: count('suspended'), cancelled: count('cancelled'), expired: rows.filter((x) => isExpired(x.org)).length },
      mrrCents,
      collectedThisMonthCents: collected,
      people: { members: memberTotal, staff: staffTotal, locations: locationTotal },
      attention,
      byPackage,
      recent: await Promise.all(
        [...rows]
          .sort((a, b) => b.org.createdAt.localeCompare(a.org.createdAt))
          .slice(0, 5)
          .map((x) => summarise(db, x.org, x.pkg)),
      ),
    });
  });

  return r;
}
