import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { and, asc, desc, eq, gt, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  MEMBER_STATUSES,
  attendance,
  bookings,
  contracts,
  invoices,
  members,
  plans,
  resourceAssignments,
  resources,
  users,
} from '../db/schema.js';
import { assertMemberAccess, loadLocation, loadMember, requireLocationId } from '../lib/access.js';
import { assertLocation, assertWithinLimit } from '../lib/auth.js';
import { requirePermission } from '../lib/permissions.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { DATE_RE, isValidDate, todayIn } from '../lib/time.js';
import { finishBookingOnCheckOut } from '../services/checkin.js';
import { syncUser } from '../services/devices.js';
import { idParam } from '../lib/http.js';
import { tempPassword } from '../lib/passwords.js';
import { parse } from '../lib/validate.js';

const dateStr = z.string().refine(isValidDate, 'Use YYYY-MM-DD');

async function checkPlan(db: Db, planId: string | null | undefined, locationId: string) {
  if (!planId) return;
  const plan = await db.select().from(plans).where(eq(plans.id, planId)).get();
  if (!plan || plan.locationId !== locationId) throw badRequest('Plan does not belong to this location');
}

export function membersRouter(db: Db) {
  const r = Router();

  r.get('/', requirePermission('members', 'front_desk', 'bookings', 'invoices', 'contracts'), async (req, res) => {
    const locationId = requireLocationId(req);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const conds = [eq(members.locationId, locationId)];
    if ((MEMBER_STATUSES as readonly string[]).includes(status)) {
      conds.push(eq(members.status, status as (typeof MEMBER_STATUSES)[number]));
    }
    if (q) {
      const pat = `%${q.replace(/[%_]/g, '')}%`;
      conds.push(or(like(users.name, pat), like(users.email, pat), like(members.company, pat))!);
    }
    const rows = await db
      .select({ member: members, user: users, plan: plans })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .leftJoin(plans, eq(plans.id, members.planId))
      .where(and(...conds))
      .orderBy(asc(users.name))
      .all();
    const present = new Set(
      (await db
        .select({ memberId: attendance.memberId })
        .from(attendance)
        .where(and(eq(attendance.locationId, locationId), isNull(attendance.checkOutAt)))
        .all())
        .map((a) => a.memberId),
    );
    res.json(
      rows.map(({ member, user, plan }) => ({
        ...member,
        name: user.name,
        email: user.email,
        phone: user.phone,
        devicePin: user.devicePin,
        planName: plan?.name ?? null,
        checkedIn: present.has(member.id),
      })),
    );
  });

  r.post('/', requirePermission('members'), async (req, res) => {
    const body = parse(
      z.object({
        locationId: z.string(),
        name: z.string().trim().min(1).max(100),
        email: z.string().trim().toLowerCase().pipe(z.email()),
        phone: z.string().trim().max(40).default(''),
        company: z.string().trim().max(120).default(''),
        planId: z.string().nullable().default(null),
        status: z.enum(MEMBER_STATUSES).default('active'),
        startDate: dateStr.optional(),
        notes: z.string().trim().max(2000).default(''),
        password: z.string().min(8).optional(),
      }),
      req.body,
    );
    assertLocation(req.user!, body.locationId);
    const loc = await loadLocation(db, body.locationId);
    await checkPlan(db, body.planId, loc.id);
    if (body.status !== 'cancelled') await assertWithinLimit(db, req.user!, 'members');
    if (await db.select().from(users).where(eq(users.email, body.email)).get()) throw conflict('That email is already in use');

    const password = body.password ?? tempPassword();
    const passwordHash = await bcrypt.hash(password, 10);
    const member = await db.transaction(async (tx) => {
      const user = await tx
        .insert(users)
        .values({ organizationId: loc.organizationId, name: body.name, email: body.email, phone: body.phone, role: 'member', passwordHash })
        .returning()
        .get();
      return tx
        .insert(members)
        .values({
          userId: user.id,
          locationId: loc.id,
          company: body.company,
          planId: body.planId,
          status: body.status,
          startDate: body.startDate ?? todayIn(loc.timezone),
          notes: body.notes,
        })
        .returning()
        .get();
    });
    await syncUser(db, member.userId);
    const { devicePin } = (await db.select({ devicePin: users.devicePin }).from(users).where(eq(users.id, member.userId)).get())!;
    res.status(201).json({
      ...member,
      name: body.name,
      email: body.email,
      phone: body.phone,
      devicePin,
      tempPassword: body.password ? undefined : password,
    });
  });

  r.get('/:id', async (req, res) => {
    const { member, user } = await loadMember(db, idParam(req));
    assertMemberAccess(req.user!, member);
    const loc = await loadLocation(db, member.locationId);
    const today = todayIn(loc.timezone);

    const plan = member.planId ? await db.select().from(plans).where(eq(plans.id, member.planId)).get() : null;
    const assigned = await db
      .select({ assignment: resourceAssignments, resource: resources })
      .from(resourceAssignments)
      .innerJoin(resources, eq(resources.id, resourceAssignments.resourceId))
      .where(eq(resourceAssignments.memberId, member.id))
      .orderBy(desc(resourceAssignments.startDate))
      .all();
    const open = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.memberId, member.id), eq(invoices.status, 'open')))
      .all();
    res.json({
      ...member,
      name: user.name,
      email: user.email,
      phone: user.phone,
      devicePin: user.devicePin,
      plan,
      assignments: assigned.map(({ assignment, resource }) => ({
        ...assignment,
        resourceName: resource.name,
        resourceKind: resource.kind,
        active: assignment.startDate <= today && (!assignment.endDate || assignment.endDate >= today),
      })),
      balanceDueCents: open.reduce((s, i) => s + i.totalCents - i.paidCents, 0),
      overdueCents: open.filter((i) => i.dueDate < today).reduce((s, i) => s + i.totalCents - i.paidCents, 0),
    });
  });

  r.patch('/:id', requirePermission('members'), async (req, res) => {
    const body = parse(
      z
        .object({
          name: z.string().trim().min(1).max(100),
          email: z.string().trim().toLowerCase().pipe(z.email()),
          phone: z.string().trim().max(40),
          company: z.string().trim().max(120),
          planId: z.string().nullable(),
          status: z.enum(MEMBER_STATUSES),
          startDate: dateStr,
          endDate: dateStr.nullable(),
          notes: z.string().trim().max(2000),
        })
        .partial(),
      req.body,
    );
    const { member, user } = await loadMember(db, idParam(req));
    assertLocation(req.user!, member.locationId);
    if (body.planId !== undefined) await checkPlan(db, body.planId, member.locationId);
    if (member.status === 'cancelled' && body.status && body.status !== 'cancelled') await assertWithinLimit(db, req.user!, 'members');
    if (body.email && body.email !== user.email) {
      if (await db.select().from(users).where(eq(users.email, body.email)).get()) throw conflict('That email is already in use');
    }

    const { name, email, phone, ...memberFields } = body;
    // Cancelling someone must not leave a rent running or a security deposit unsettled.
    if (body.status === 'cancelled' && member.status !== 'cancelled') {
      const live = await db.select({ id: contracts.id }).from(contracts).where(and(eq(contracts.memberId, member.id), inArray(contracts.status, ['draft', 'active']))).get();
      if (live) throw conflict('This member has a contract that is still running. End or cancel it first.');
    }
    const updated = await db.transaction(async (tx) => {
      if (body.status === 'cancelled' && member.status !== 'cancelled') {
        const nowIso = new Date().toISOString();
        // Bookings that have not started are cancelled so the spaces are free again; anything invoiced or already under way stays.
        await tx.update(bookings)
          .set({ status: 'cancelled', cancelledAt: nowIso })
          .where(and(eq(bookings.memberId, member.id), eq(bookings.status, 'confirmed'), isNull(bookings.invoiceId), gt(bookings.startsAt, nowIso)))
          .run();
        // They are no longer in the building.
        const open = await tx.select().from(attendance).where(and(eq(attendance.memberId, member.id), isNull(attendance.checkOutAt))).all();
        for (const a of open) {
          await tx.update(attendance).set({ checkOutAt: nowIso }).where(eq(attendance.id, a.id)).run();
          await finishBookingOnCheckOut(tx as unknown as Db, a);
        }
      }
      const userPatch: Partial<typeof users.$inferInsert> = {};
      if (name !== undefined) userPatch.name = name;
      if (email !== undefined) userPatch.email = email;
      if (phone !== undefined) userPatch.phone = phone;
      // Cancelled members lose portal access; every other status keeps it.
      if (body.status) userPatch.active = body.status !== 'cancelled';
      if (Object.keys(userPatch).length) await tx.update(users).set(userPatch).where(eq(users.id, user.id)).run();
      return Object.keys(memberFields).length
        ? await tx.update(members).set(memberFields).where(eq(members.id, member.id)).returning().get()
        : member;
    });
    // The devices show their name, and take them off when they leave.
    if (name !== undefined || body.status !== undefined) await syncUser(db, user.id);
    res.json(updated);
  });

  r.post('/:id/reset-password', requirePermission('members'), async (req, res) => {
    const { member, user } = await loadMember(db, idParam(req));
    assertLocation(req.user!, member.locationId);
    const temp = tempPassword();
    await db.update(users).set({ passwordHash: await bcrypt.hash(temp, 10) }).where(eq(users.id, user.id)).run();
    res.json({ tempPassword: temp });
  });

  return r;
}
