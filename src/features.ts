/**
 * The functionality a package can switch on. Everything not listed here (members and plans, spaces,
 * bookings, check-in and the front desk) is core and comes with every package.
 */
export interface FeatureDef {
  key: string;
  label: string;
  description: string;
  /** Other features this one needs; selecting it selects them too. */
  requires?: string[];
}

export const FEATURES = [
  {
    key: 'visitors',
    label: 'Visitor management',
    description: 'Members pre-register guests and the front desk checks them in and out.',
  },
  {
    key: 'member_portal',
    label: 'Member portal',
    description: 'Members sign in to book rooms and desks, check in, see invoices and add visitors.',
  },
  {
    key: 'floor_3d',
    label: '3D floor view',
    description: 'Interactive 3D map of rooms, desks and offices for staff and members.',
  },
  {
    key: 'plan_import',
    label: 'Floor plan import',
    description: 'Upload a floor plan as a PDF or image and have it drawn into the 3D editor automatically.',
    requires: ['floor_3d'],
  },
  {
    key: 'invoicing',
    label: 'Invoices and payments',
    description: 'Monthly membership invoices, manual invoices, tax, and payments received.',
  },
  {
    key: 'expenses',
    label: 'Expense tracking',
    description: 'Record rent, utilities, salaries and other running costs.',
  },
  {
    key: 'reports',
    label: 'Finance reports and exports',
    description: 'Revenue, expenses and net by month, receivables aging, CSV exports.',
    requires: ['invoicing'],
  },
  {
    key: 'team',
    label: 'Team accounts',
    description: 'Separate manager and front-desk logins limited to chosen locations.',
  },
] as const satisfies readonly FeatureDef[];

export type FeatureKey = (typeof FEATURES)[number]['key'];
export const FEATURE_KEYS: readonly string[] = FEATURES.map((f) => f.key);

export const CORE_FEATURES = [
  'Members and membership plans',
  'Rooms, desks and private offices',
  'Room and desk bookings',
  'Check-in and front desk',
] as const;

const byKey = new Map<string, FeatureDef>(FEATURES.map((f) => [f.key, f]));

/** Keeps only known keys, adds anything they require, removes duplicates, and orders like the catalogue. */
export function normalizeFeatures(keys: readonly string[]): FeatureKey[] {
  const wanted = new Set<string>();
  const add = (k: string) => {
    const def = byKey.get(k);
    if (!def || wanted.has(k)) return;
    wanted.add(k);
    for (const dep of def.requires ?? []) add(dep);
  };
  for (const k of keys) add(k);
  return FEATURES.map((f) => f.key).filter((k) => wanted.has(k));
}

export function parseFeatures(json: string): FeatureKey[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? normalizeFeatures(parsed.filter((x): x is string => typeof x === 'string')) : [];
  } catch {
    return [];
  }
}

export const unknownFeatures = (keys: readonly string[]) => keys.filter((k) => !byKey.has(k));
