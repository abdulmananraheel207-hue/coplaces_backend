import type { NextFunction, Request, Response } from 'express';
import type { AuthUser } from './auth.js';
import { forbidden } from './errors.js';

/**
 * What a team member may do. The owner can always do all of it and can give any of it, or all of it, to anyone on the team.
 * Looking things up (the Today page, the room and desk board, plans, spaces) is open to the whole team.
 */
export const PERMISSIONS = [
  { key: 'front_desk', group: 'Daily work', label: 'Front desk', description: 'Check members in and out, add visitors and check them in.' },
  { key: 'bookings', group: 'Daily work', label: 'Bookings', description: 'Book rooms and desks for members, mark them done or no-show, and cancel them.' },
  { key: 'members', group: 'Daily work', label: 'Members', description: 'Add and edit members, reset their passwords and assign them desks and offices.' },
  { key: 'spaces', group: 'Setup', label: 'Spaces', description: 'Add and edit rooms, desks and offices, and draw the floor plan.' },
  { key: 'plans', group: 'Setup', label: 'Membership plans', description: 'Create and change membership plans and prices.' },
  { key: 'holidays', group: 'Setup', label: 'Holidays', description: 'Set the dates the space is closed.' },
  { key: 'contracts', group: 'Agreements', label: 'Contracts and security deposits', description: 'Create contracts, start and end them and handle advances and security deposits.' },
  { key: 'announcements', group: 'Agreements', label: 'Announcements', description: 'Write notices that members see.' },
  { key: 'maintenance', group: 'Operations', label: 'Maintenance and equipment', description: 'See and handle problems members report, run cleaning and upkeep schedules, and keep the equipment list.' },
  { key: 'invoices', group: 'Money', label: 'Invoices and payments', description: 'See invoices and payments, create manual invoices and record payments.' },
  { key: 'billing_admin', group: 'Money', label: 'Billing controls', description: 'Generate the monthly invoices, void invoices and remove payments.' },
  { key: 'expenses', group: 'Money', label: 'Expenses', description: 'See and record what the space spends.' },
  { key: 'reports', group: 'Money', label: 'Finance reports', description: 'See income, profit and loss, and the finance figures on the Today page.' },
] as const;

export type Permission = (typeof PERMISSIONS)[number]['key'];
export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key) as [Permission, ...Permission[]];

/** What the old "front desk" role could do. */
export const FRONT_DESK_PRESET: Permission[] = ['front_desk', 'bookings', 'members', 'invoices'];

const known = new Set<string>(PERMISSION_KEYS);

export function parsePermissions(json: string | null): Permission[] | null {
  if (json === null) return null;
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? PERMISSION_KEYS.filter((k) => v.includes(k)) : [];
  } catch {
    return [];
  }
}

export const sanitizePermissions = (keys: readonly string[]): Permission[] => PERMISSION_KEYS.filter((k) => keys.includes(k) && known.has(k));

/**
 * The permissions a user effectively has. Owners have all of them. A team member's own list wins; accounts made before
 * permissions existed have none stored, so they keep what their old role gave them.
 */
export function resolvePermissions(role: string, stored: string | null): Permission[] {
  if (role === 'owner') return [...PERMISSION_KEYS];
  if (role !== 'manager' && role !== 'staff') return [];
  const own = parsePermissions(stored);
  if (own) return own;
  return role === 'manager' ? [...PERMISSION_KEYS] : [...FRONT_DESK_PRESET];
}

export const can = (u: AuthUser, permission: Permission) => u.permissions.includes(permission);

/** Throws unless the (team) user has the permission. For endpoints that members share with staff. */
export function assertCan(u: AuthUser, permission: Permission) {
  if (!can(u, permission)) throw forbidden('You do not have permission to do this');
}

/** Lets a team member through when they hold at least one of the permissions. */
export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const u = req.user;
    if (!u || !permissions.some((p) => can(u, p))) throw forbidden('You do not have permission to do this');
    next();
  };
}
