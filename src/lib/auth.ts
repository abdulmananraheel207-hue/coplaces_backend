import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { and, eq, ne, sql } from 'drizzle-orm';
import { config } from '../config.js';
import type { Db } from '../db/client.js';
import { locations, members, organizations, packages, userLocations, users } from '../db/schema.js';
import { parseFeatures, type FeatureKey } from '../features.js';
import { forbidden, HttpError, unauthorized } from './errors.js';
import { resolvePermissions, type Permission } from './permissions.js';
import { todayIn } from './time.js';

export type Role = (typeof users.$inferSelect)['role'];

export interface OrgContext {
  id: string;
  name: string;
  status: 'trial' | 'active' | 'suspended' | 'cancelled';
  packageName: string;
  features: FeatureKey[];
  maxLocations: number | null;
  maxMembers: number | null;
  periodEnd: string;
  /** The subscription period has run out. Shown as a warning; only suspension blocks access. */
  expired: boolean;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** What this user may do. Owners have everything; members and super admins have none of the team permissions. */
  permissions: Permission[];
  /** Locations this user may act in. Always inside their own organization. */
  locationIds: string[];
  /** Set when role === 'member'. */
  memberId: string | null;
  /** Null for platform super admins. */
  organizationId: string | null;
  org: OrgContext | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const SESSION_COOKIE = 'cp_session';

export function signSession(userId: string) {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: `${config.sessionDays}d` });
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.secureCookies,
    maxAge: config.sessionDays * 86_400_000,
    path: '/',
  };
}

export async function loadOrgContext(db: Db, organizationId: string): Promise<OrgContext | null> {
  const row = await db
    .select({ org: organizations, pkg: packages })
    .from(organizations)
    .innerJoin(packages, eq(packages.id, organizations.packageId))
    .where(eq(organizations.id, organizationId))
    .get();
  if (!row) return null;
  return {
    id: row.org.id,
    name: row.org.name,
    status: row.org.status,
    packageName: row.pkg.name,
    features: parseFeatures(row.pkg.features),
    maxLocations: row.pkg.maxLocations,
    maxMembers: row.pkg.maxMembers,
    periodEnd: row.org.periodEnd,
    expired:
      (row.org.status === 'trial' || row.org.status === 'active') &&
      row.org.periodEnd < todayIn(config.platformTimezone),
  };
}

export type AuthResult = { user: AuthUser } | { blocked: string };

export async function resolveAuth(db: Db, userId: string): Promise<AuthResult> {
  const u = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!u || !u.active) return { blocked: 'Account unavailable' };

  if (u.role === 'superadmin') {
    return { user: { id: u.id, email: u.email, name: u.name, role: u.role, permissions: [], locationIds: [], memberId: null, organizationId: null, org: null } };
  }

  if (!u.organizationId) return { blocked: 'Account unavailable' };
  const org = await loadOrgContext(db, u.organizationId);
  if (!org) return { blocked: 'Account unavailable' };
  if (org.status === 'suspended' || org.status === 'cancelled') {
    return { blocked: `The subscription for ${org.name} is ${org.status}. Please contact Coplaces support.` };
  }

  let locationIds: string[];
  let memberId: string | null = null;
  if (u.role === 'owner') {
    locationIds = (await db
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.organizationId, org.id))
      .all())
      .map((l) => l.id);
  } else if (u.role === 'member') {
    if (!org.features.includes('member_portal')) {
      return { blocked: `${org.name} has not turned on the member portal. Please ask the front desk.` };
    }
    const m = await db.select().from(members).where(eq(members.userId, u.id)).get();
    if (!m) return { blocked: 'Account unavailable' };
    memberId = m.id;
    locationIds = [m.locationId];
  } else {
    locationIds = (await db
      .select({ id: userLocations.locationId })
      .from(userLocations)
      .innerJoin(locations, eq(locations.id, userLocations.locationId))
      .where(and(eq(userLocations.userId, u.id), eq(locations.organizationId, org.id)))
      .all())
      .map((l) => l.id);
  }
  return { user: { id: u.id, email: u.email, name: u.name, role: u.role, permissions: resolvePermissions(u.role, u.permissions), locationIds, memberId, organizationId: org.id, org } };
}

export async function loadAuthUser(db: Db, userId: string): Promise<AuthUser | null> {
  const r = await resolveAuth(db, userId);
  return 'user' in r ? r.user : null;
}

export function authenticate(db: Db) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) throw unauthorized();
    let userId: string;
    try {
      const payload = jwt.verify(token, config.jwtSecret) as { sub: string };
      userId = payload.sub;
    } catch {
      throw unauthorized('Session expired');
    }
    const r = await resolveAuth(db, userId);
    if ('blocked' in r) throw unauthorized(r.blocked);
    req.user = r.user;
    next();
  };
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) throw forbidden();
    next();
  };
}

/** Rejects the request unless the caller's organization has this feature in its package. */
export function requireFeature(feature: FeatureKey) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user?.org?.features.includes(feature)) {
      throw new HttpError(403, 'This is not included in your current package. Ask Coplaces about upgrading.', { feature });
    }
    next();
  };
}

export const hasFeature = (u: AuthUser, feature: FeatureKey) => !!u.org?.features.includes(feature);

/** Staff-side roles inside a tenant: everything except `member` and the platform super admin. */
export const staffOnly = requireRole('owner', 'manager', 'staff');
export const managerUp = requireRole('owner', 'manager');
export const ownerOnly = requireRole('owner');
export const superAdminOnly = requireRole('superadmin');

export const isStaff = (u: AuthUser) => u.role === 'owner' || u.role === 'manager' || u.role === 'staff';
export const isManagerUp = (u: AuthUser) => u.role === 'owner' || u.role === 'manager';

export function assertLocation(user: AuthUser, locationId: string) {
  if (!user.locationIds.includes(locationId)) throw forbidden('No access to this location');
}

export interface OrgUsage {
  locations: number;
  /** Members who count against the package limit: everyone except cancelled. */
  members: number;
  activeMembers: number;
  staff: number;
}

export async function orgUsage(db: Db, organizationId: string): Promise<OrgUsage> {
  const locs = (await db
    .select({ n: sql<number>`count(*)` })
    .from(locations)
    .where(eq(locations.organizationId, organizationId))
    .get())!.n;
  const byStatus = await db
    .select({ status: members.status, n: sql<number>`count(*)` })
    .from(members)
    .innerJoin(locations, eq(locations.id, members.locationId))
    .where(eq(locations.organizationId, organizationId))
    .groupBy(members.status)
    .all();
  const staff = (await db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), ne(users.role, 'member'), ne(users.role, 'owner')))
    .get())!.n;
  const total = byStatus.filter((s) => s.status !== 'cancelled').reduce((a, s) => a + s.n, 0);
  return { locations: locs, members: total, activeMembers: byStatus.find((s) => s.status === 'active')?.n ?? 0, staff };
}

export async function assertWithinLimit(db: Db, user: AuthUser, what: 'locations' | 'members') {
  const org = user.org;
  if (!org) return;
  const limit = what === 'locations' ? org.maxLocations : org.maxMembers;
  if (limit === null) return;
  const used = (await orgUsage(db, org.id))[what];
  if (used >= limit) {
    throw new HttpError(
      403,
      `Your ${org.packageName} package allows up to ${limit} ${what}. Ask Coplaces about upgrading to add more.`,
      { limit: what },
    );
  }
}
