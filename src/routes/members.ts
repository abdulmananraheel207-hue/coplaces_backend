import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { and, asc, desc, eq, gt, inArray, isNull, like, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  MEMBER_STATUSES,
  PAYMENT_METHODS,
  attendance,
  bookings,
  contractPeople,
  contracts,
  depositEntries,
  memberDesks,
  memberShifts,
  shiftTemplates,
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
import { amenityOwed, memberAllowance, setMemberAmenities } from '../services/amenities.js';
import { deleteMember } from '../services/memberDelete.js';
import { recordMemberMoney, settleMemberDeposit } from '../services/memberMoney.js';
import { changePlan, freeSpacesForPlan, renewPlan, startPlanPeriod } from '../services/planBookings.js';
import { syncUser } from '../services/devices.js';
import { idParam } from '../lib/http.js';
import { tempPassword } from '../lib/passwords.js';
import { parse } from '../lib/validate.js';

const dateStr = z.string().refine(isValidDate, 'Use YYYY-MM-DD');
/** The amenities a member gets free each day, and the meeting room credit hours (two make an hour) they get each month. */
const freeAmenities = z.array(z.object({ amenityId: z.string(), freePerDay: z.number().int().min(1).max(1000) })).max(100);
const meetingCredits = z.number().int().min(0).max(10_000);

async function checkPlan(db: Db, planId: string | null | undefined, locationId: string) {
  if (!planId) return;
  const plan = await db.select().from(plans).where(eq(plans.id, planId)).get();
  if (!plan || plan.locationId !== locationId) throw badRequest('Plan does not belong to this location');
}

/** The company each of these members came in through, for members created from a company contract. */
async function contractCompanies(db: Db, memberIds: string[]) {
  const out = new Map<string, string>();
  if (!memberIds.length) return out;
  const rows = await db
    .select({ memberId: contractPeople.memberId, company: contracts.companyName })
    .from(contractPeople)
    .innerJoin(contracts, eq(contracts.id, contractPeople.contractId))
    .where(and(inArray(contractPeople.memberId, memberIds), ne(contracts.companyName, '')))
    .all();
  for (const r of rows) out.set(r.memberId, r.company);
  return out;
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
    const companies = await contractCompanies(db, rows.map(({ member }) => member.id));
    res.json(
      rows.map(({ member, user, plan }) => ({
        ...member,
        contractCompany: companies.get(member.id) ?? null,
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
        /** Which of the plan's shifts they take, and the desks or offices they are given for them. */
        shiftIds: z.array(z.string()).max(50).default([]),
        deskIds: z.array(z.string()).max(50).default([]),
        /** Paid when they join: the advance comes off the shift prices, and the deposit is held until the end of the plan period. */
        advanceCents: z.number().int().min(0).max(1_000_000_000_000).default(0),
        depositCents: z.number().int().min(0).max(1_000_000_000_000).default(0),
        method: z.enum(PAYMENT_METHODS).default('cash'),
        reference: z.string().trim().max(100).default(''),
        amenities: freeAmenities.default([]),
        meetingCredits: meetingCredits.default(0),
      }),
      req.body,
    );
    assertLocation(req.user!, body.locationId);
    const loc = await loadLocation(db, body.locationId);
    await checkPlan(db, body.planId, loc.id);
    const plan = body.planId ? await db.select().from(plans).where(eq(plans.id, body.planId)).get() : undefined;
    const planShifts = plan ? await db.select({ id: shiftTemplates.id }).from(shiftTemplates).where(and(eq(shiftTemplates.planId, plan.id), eq(shiftTemplates.active, true))).all() : [];
    if (plan && planShifts.length && !body.shiftIds.length) throw badRequest('Choose at least one of the plan\'s shifts');
    if (!plan && (body.shiftIds.length || body.deskIds.length)) throw badRequest('Shifts belong to a plan. Choose the plan first');
    if (body.deskIds.length && !body.shiftIds.length) throw badRequest('Choose the shifts the desks are for');
    if (body.shiftIds.length && body.status !== 'active') throw badRequest('Start the member as Active to give them shifts');
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
      const created = await tx
        .insert(members)
        .values({
          userId: user.id,
          locationId: loc.id,
          company: body.company,
          planId: body.planId,
          status: body.status,
          startDate: body.startDate ?? todayIn(loc.timezone),
          notes: body.notes,
          meetingCredits: body.meetingCredits,
        })
        .returning()
        .get();
      await setMemberAmenities(tx as unknown as Db, created.id, loc.id, body.amenities);
      // What they paid when joining is recorded before the first invoice, so the advance comes off it.
      if (body.advanceCents || body.depositCents) await recordMemberMoney(tx as unknown as Db, req.user!, created.id, { advanceCents: body.advanceCents, depositCents: body.depositCents, method: body.method, reference: body.reference });
      // Shifts, desks and the first period of the plan are made together with the member, or not at all.
      if (!plan || !body.shiftIds.length) return created;
      await startPlanPeriod(tx as unknown as Db, req.user!, created.id, plan, body.shiftIds, body.deskIds, body.startDate ?? todayIn(loc.timezone));
      return (await tx.select().from(members).where(eq(members.id, created.id)).get())!;
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

  /** The desks and offices that are free for a plan's shifts from a start date, for the new member form. */
  r.get('/available-spaces', requirePermission('members'), async (req, res) => {
    const locationId = requireLocationId(req);
    const planId = typeof req.query.planId === 'string' ? req.query.planId : '';
    const shiftIds = typeof req.query.shiftIds === 'string' ? req.query.shiftIds.split(',').filter(Boolean) : [];
    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : '';
    if (!planId || !isValidDate(startDate)) throw badRequest('planId and startDate are required');
    const exceptMemberId = typeof req.query.memberId === 'string' && req.query.memberId ? req.query.memberId : undefined;
    const out = await freeSpacesForPlan(db, req.user!, planId, shiftIds, startDate, exceptMemberId);
    const plan = (await db.select({ l: plans.locationId }).from(plans).where(eq(plans.id, planId)).get())!;
    if (plan.l !== locationId) throw badRequest('Plan does not belong to this location');
    res.json({ end: out.end, spaces: out.spaces.map((s) => ({ id: s.id, name: s.name, kind: s.kind, floor: s.floor })) });
  });

  /** Changes a member's plan, shifts or desks, re-booking what has not happened yet. */
  r.put('/:id/plan', requirePermission('members'), async (req, res) => {
    const body = parse(z.object({ planId: z.string().nullable(), shiftIds: z.array(z.string()).max(50).default([]), deskIds: z.array(z.string()).max(50).default([]), startDate: dateStr.optional() }), req.body);
    res.json(await changePlan(db, req.user!, idParam(req), { planId: body.planId, shiftIds: body.shiftIds, spaceIds: body.deskIds, startDate: body.startDate }));
  });

  /** Removes a member who was added by mistake. Anyone with history that must stay is cancelled instead. */
  r.delete('/:id', requirePermission('members'), async (req, res) => {
    await deleteMember(db, req.user!, idParam(req));
    res.status(204).end();
  });

  /** Records an advance or a security deposit that was forgotten when the member was added. */
  r.post('/:id/money', requirePermission('members'), async (req, res) => {
    const body = parse(z.object({ advanceCents: z.number().int().min(0).max(1_000_000_000_000).optional(), depositCents: z.number().int().min(0).max(1_000_000_000_000).optional(), method: z.enum(PAYMENT_METHODS).default('cash'), reference: z.string().trim().max(100).default('') }), req.body);
    await db.transaction((tx) => recordMemberMoney(tx as unknown as Db, req.user!, idParam(req), body));
    res.status(204).end();
  });

  /** Settles the security deposit at the end of the plan period: some or all goes back, the rest is kept. */
  r.post('/:id/deposit', requirePermission('members'), async (req, res) => {
    const body = parse(z.object({ action: z.enum(['refund', 'forfeit']), returnedCents: z.number().int().min(0).optional(), method: z.enum(PAYMENT_METHODS).default('cash'), reference: z.string().trim().max(100).default('') }), req.body);
    res.json(await settleMemberDeposit(db, req.user!, idParam(req), body));
  });

  r.post('/:id/renew', requirePermission('members'), async (req, res) => {
    const body = parse(z.object({ startDate: dateStr.optional() }), req.body);
    res.json(await renewPlan(db, req.user!, idParam(req), body.startDate));
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
      contractCompany: (await contractCompanies(db, [member.id])).get(member.id) ?? null,
      name: user.name,
      email: user.email,
      phone: user.phone,
      devicePin: user.devicePin,
      plan,
      shifts: await db
        .select({ id: shiftTemplates.id, name: shiftTemplates.name, startTime: shiftTemplates.startTime, endTime: shiftTemplates.endTime, priceCents: shiftTemplates.priceCents })
        .from(memberShifts)
        .innerJoin(shiftTemplates, eq(shiftTemplates.id, memberShifts.shiftId))
        .where(eq(memberShifts.memberId, member.id))
        .orderBy(asc(shiftTemplates.startTime))
        .all(),
      amenities: await memberAllowance(db, member.id, today),
      amenityOwedCents: await amenityOwed(db, member.id),
      moneyEntries: await db.select().from(depositEntries).where(eq(depositEntries.memberId, member.id)).orderBy(asc(depositEntries.occurredAt)).all(),
      desks: await db.select({ id: resources.id, name: resources.name, kind: resources.kind }).from(memberDesks).innerJoin(resources, eq(resources.id, memberDesks.resourceId)).where(eq(memberDesks.memberId, member.id)).all(),
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
          meetingCredits,
          amenities: freeAmenities,
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

    const { name, email, phone, amenities: freeList, ...memberFields } = body;
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
      if (freeList) await setMemberAmenities(tx as unknown as Db, member.id, member.locationId, freeList);
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
