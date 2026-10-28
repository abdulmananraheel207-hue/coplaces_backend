import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { locations, userLocations, users } from '../db/schema.js';
import type { AuthUser } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { idParam } from '../lib/http.js';
import { tempPassword } from '../lib/passwords.js';
import { FRONT_DESK_PRESET, PERMISSIONS, PERMISSION_KEYS, resolvePermissions, sanitizePermissions } from '../lib/permissions.js';
import { parse } from '../lib/validate.js';
import { syncUser } from '../services/devices.js';

/** Team members choose what they can do. The old two roles still work in the API as shortcuts for a set of permissions. */
const permissionList = z.array(z.enum(PERMISSION_KEYS));
const legacyRole = z.enum(['manager', 'staff']);

async function shape(db: Db, rows: (typeof users.$inferSelect)[]) {
  const links = rows.length
    ? await db.select().from(userLocations).where(inArray(userLocations.userId, rows.map((u) => u.id))).all()
    : [];
  return rows.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    permissions: resolvePermissions(u.role, u.permissions),
    active: u.active,
    lastLoginAt: u.lastLoginAt,
    devicePin: u.devicePin,
    locationIds: links.filter((l) => l.userId === u.id).map((l) => l.locationId),
  }));
}

/** Every location must belong to the caller's own organization. */
async function assertLocationsExist(db: Db, ids: string[], user: AuthUser) {
  if (!ids.length) throw badRequest('Assign at least one location');
  const found = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(inArray(locations.id, ids), eq(locations.organizationId, user.organizationId!)))
    .all();
  if (found.length !== new Set(ids).size) throw badRequest('Unknown location');
}

/** Staff accounts of the caller's organization only; super admins and members are never listed. */
async function loadStaff(db: Db, user: AuthUser, id: string) {
  const target = await db.select().from(users).where(eq(users.id, id)).get();
  if (!target || target.organizationId !== user.organizationId || target.role === 'member' || target.role === 'superadmin') {
    throw notFound('Staff member');
  }
  return target;
}

/** Owner-only management of team accounts and what each member may do. Mounted behind ownerOnly. */
export function staffRouter(db: Db) {
  const r = Router();

  /** Everything that can be granted, for the form. */
  r.get('/permissions', (_req, res) => {
    res.json(PERMISSIONS);
  });

  r.get('/', async (req, res) => {
    const rows = await db
      .select()
      .from(users)
      .where(and(eq(users.organizationId, req.user!.organizationId!), ne(users.role, 'member')))
      .all();
    res.json(await shape(db, rows));
  });

  r.post('/', async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(100),
        email: z.string().trim().toLowerCase().pipe(z.email()),
        phone: z.string().trim().max(40).default(''),
        permissions: permissionList.optional(),
        role: legacyRole.optional(),
        locationIds: z.array(z.string()),
        password: z.string().min(8).optional(),
      }),
      req.body,
    );
    await assertLocationsExist(db, body.locationIds, req.user!);
    if (await db.select().from(users).where(eq(users.email, body.email)).get()) throw conflict('That email is already in use');

    const granted = body.permissions ?? (body.role === 'manager' ? PERMISSION_KEYS : FRONT_DESK_PRESET);
    const password = body.password ?? tempPassword();
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await db.transaction(async (tx) => {
      const u = await tx
        .insert(users)
        .values({ organizationId: req.user!.organizationId!, name: body.name, email: body.email, phone: body.phone, role: body.role ?? 'staff', permissions: JSON.stringify(sanitizePermissions(granted)), passwordHash })
        .returning()
        .get();
      for (const locationId of new Set(body.locationIds)) await tx.insert(userLocations).values({ userId: u.id, locationId }).run();
      return u;
    });
    await syncUser(db, user.id);
    const fresh = (await db.select().from(users).where(eq(users.id, user.id)).get())!;
    res.status(201).json({ ...(await shape(db, [fresh]))[0], tempPassword: body.password ? undefined : password });
  });

  r.patch('/:id', async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(100),
        phone: z.string().trim().max(40),
        permissions: permissionList,
        role: legacyRole,
        locationIds: z.array(z.string()),
        active: z.boolean(),
        resetPassword: z.boolean(),
      }).partial(),
      req.body,
    );
    const target = await loadStaff(db, req.user!, idParam(req));
    if (target.role === 'owner' && (body.role || body.permissions || body.active === false || body.locationIds)) {
      throw badRequest('Owner accounts cannot be changed this way');
    }
    if (body.locationIds) await assertLocationsExist(db, body.locationIds, req.user!);

    let temp: string | undefined;
    const { locationIds, resetPassword, permissions, role, ...fields } = body;
    const patch: Partial<typeof users.$inferInsert> = { ...fields };
    if (permissions) {
      patch.permissions = JSON.stringify(sanitizePermissions(permissions));
      patch.role = 'staff'; // an explicit list replaces whatever the old role granted
    } else if (role) {
      patch.role = role;
      patch.permissions = JSON.stringify(role === 'manager' ? PERMISSION_KEYS : FRONT_DESK_PRESET);
    }
    if (resetPassword) {
      temp = tempPassword();
      patch.passwordHash = await bcrypt.hash(temp, 10);
    }
    const updated = await db.transaction(async (tx) => {
      const u = Object.keys(patch).length
        ? await tx.update(users).set(patch).where(eq(users.id, target.id)).returning().get()
        : target;
      if (locationIds) {
        await tx.delete(userLocations).where(eq(userLocations.userId, target.id)).run();
        for (const locationId of new Set(locationIds)) await tx.insert(userLocations).values({ userId: target.id, locationId }).run();
      }
      return u;
    });
    if (body.name !== undefined || body.active !== undefined || locationIds) await syncUser(db, target.id);
    res.json({ ...(await shape(db, [updated]))[0], tempPassword: temp });
  });

  return r;
}
