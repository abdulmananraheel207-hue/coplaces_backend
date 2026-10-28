import { blob, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Money is always integer minor units (cents). Timestamps are ISO-8601 UTC strings;
// calendar dates are 'YYYY-MM-DD' strings interpreted in the owning location's timezone.

export const ROLES = ['superadmin', 'owner', 'manager', 'staff', 'member'] as const;
export const ORG_STATUSES = ['trial', 'active', 'suspended', 'cancelled'] as const;
export const PACKAGE_INTERVALS = ['month', 'year'] as const;
export const MEMBER_STATUSES = ['lead', 'active', 'paused', 'cancelled'] as const;
export const PLAN_INTERVALS = ['month', 'day'] as const;
export const RESOURCE_KINDS = ['room', 'corporate_room', 'hot_desk', 'dedicated_desk', 'office', 'storage'] as const;
export const FLOOR_OBJECT_TYPES = [
  // amenities
  'kitchen',
  'coffee_machine',
  'lounge',
  'print_station',
  'reception',
  'plant',
  'core',
  'pantry',
  'water_dispenser',
  'vending_machine',
  'recreation',
  'nap_pod',
  'phone_corner',
  'library',
  // facilities
  'washroom_men',
  'washroom_women',
  'washroom_accessible',
  'prayer_room',
  'server_room',
  'storage_room',
  'mail_room',
  'generator_room',
  'security_desk',
  // safety
  'fire_exit',
  'extinguisher',
  'first_aid',
  // outdoors
  'terrace',
  'bike_rack',
  // structure
  'wall',
  'glass_wall',
  'door',
  'window',
  'column',
  'zone',
  'label',
] as const;
export const RESOURCE_STATUSES = ['available', 'maintenance', 'cleaning', 'reserved', 'retired'] as const;
export const ISSUE_PRIORITIES = ['low', 'normal', 'urgent'] as const;
export const ISSUE_STATUSES = ['open', 'in_progress', 'resolved'] as const;
export const TASK_KINDS = ['cleaning', 'maintenance', 'inspection'] as const;
export const ASSET_STATUSES = ['working', 'needs_repair', 'retired'] as const;
export const BOOKING_STATUSES = ['confirmed', 'completed', 'cancelled', 'no_show'] as const;
export const VISITOR_STATUSES = ['expected', 'checked_in', 'checked_out', 'cancelled'] as const;
export const INVOICE_STATUSES = ['open', 'paid', 'void'] as const;
export const INVOICE_KINDS = ['subscription', 'manual'] as const;
export const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'jazzcash', 'easypaisa', 'cheque', 'other'] as const;
export const CONTRACT_STATUSES = ['draft', 'active', 'ended', 'cancelled'] as const;
export const DEPOSIT_STATUSES = ['pending', 'held', 'refunded', 'forfeited'] as const;
export const DEPOSIT_ENTRY_KINDS = ['received', 'refunded', 'kept', 'advance'] as const;
export const EXPENSE_CATEGORIES = [
  'rent',
  'utilities',
  'internet',
  'cleaning',
  'supplies',
  'salaries',
  'maintenance',
  'marketing',
  'software',
  'other',
] as const;

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () =>
  text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString());

// ---- Platform (the SaaS layer) ---------------------------------------------

/** What a coworking space subscribes to: a set of features plus usage limits, priced in minor units of PKR. */
export const packages = sqliteTable('packages', {
  id: id(),
  name: text('name').notNull().unique(),
  description: text('description').notNull().default(''),
  interval: text('interval', { enum: PACKAGE_INTERVALS }).notNull().default('month'),
  priceCents: integer('price_cents').notNull(),
  features: text('features').notNull().default('[]'), // JSON array of feature keys, see features.ts
  maxLocations: integer('max_locations'), // null = unlimited
  maxMembers: integer('max_members'), // null = unlimited
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
});

/** A tenant: one coworking business using the platform. Everything below hangs off its locations. */
export const organizations = sqliteTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  contactEmail: text('contact_email').notNull().default(''),
  phone: text('phone').notNull().default(''),
  city: text('city').notNull().default(''),
  status: text('status', { enum: ORG_STATUSES }).notNull().default('trial'),
  packageId: text('package_id')
    .notNull()
    .references(() => packages.id),
  periodEnd: text('period_end').notNull(), // subscription (or trial) paid up to, 'YYYY-MM-DD'
  notes: text('notes').notNull().default(''),
  createdAt: createdAt(),
});

export const locations = sqliteTable(
  'locations',
  {
    id: id(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    code: text('code').notNull(), // short code used in invoice numbers, e.g. "DTN"; unique within an organization
    address: text('address').notNull().default(''),
    timezone: text('timezone').notNull().default('Asia/Karachi'),
    currency: text('currency').notNull().default('PKR'),
    openTime: text('open_time').notNull().default('08:00'),
    closeTime: text('close_time').notNull().default('20:00'),
    taxRateBps: integer('tax_rate_bps').notNull().default(0), // 825 = 8.25%
    /** Weekdays the location is shut, as comma separated numbers (0 = Sunday ... 6 = Saturday). */
    closedWeekdays: text('closed_weekdays').notNull().default(''),
    invoiceSeq: integer('invoice_seq').notNull().default(0),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('locations_org_code_idx').on(t.organizationId, t.code)],
);

/** A date the location is shut (a public holiday, say). Nothing can be booked on it. */
export const locationHolidays = sqliteTable(
  'location_holidays',
  {
    id: id(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    date: text('date').notNull(),
    name: text('name').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('location_holidays_idx').on(t.locationId, t.date)],
);

export const users = sqliteTable(
  'users',
  {
    id: id(),
    /** Null only for platform super admins. */
    organizationId: text('organization_id').references(() => organizations.id),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    phone: text('phone').notNull().default(''),
    role: text('role', { enum: ROLES }).notNull(),
    /** JSON list of what a team member may do (see lib/permissions.ts). Null on accounts made before permissions existed. */
    permissions: text('permissions'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    lastLoginAt: text('last_login_at'),
    /** The user's number on the attendance devices (a ZKTeco PIN): digits only, unique within the organization. */
    devicePin: text('device_pin'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_device_pin_idx').on(t.organizationId, t.devicePin)],
);

// Which locations a manager/staff user can work in (owners implicitly have all).
export const userLocations = sqliteTable(
  'user_locations',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.locationId] })],
);

export const plans = sqliteTable('plans', {
  id: id(),
  locationId: text('location_id')
    .notNull()
    .references(() => locations.id),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  interval: text('interval', { enum: PLAN_INTERVALS }).notNull().default('month'),
  priceCents: integer('price_cents').notNull(),
  includedMeetingMinutes: integer('included_meeting_minutes').notNull().default(0), // per month
  includesHotDesk: integer('includes_hot_desk', { mode: 'boolean' }).notNull().default(false),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
});

export const members = sqliteTable(
  'members',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .unique()
      .references(() => users.id),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    company: text('company').notNull().default(''),
    planId: text('plan_id').references(() => plans.id),
    status: text('status', { enum: MEMBER_STATUSES }).notNull().default('active'),
    startDate: text('start_date').notNull(),
    endDate: text('end_date'),
    notes: text('notes').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('members_location_idx').on(t.locationId, t.status)],
);

export const resources = sqliteTable(
  'resources',
  {
    id: id(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    kind: text('kind', { enum: RESOURCE_KINDS }).notNull(),
    name: text('name').notNull(),
    floor: text('floor').notNull().default(''),
    capacity: integer('capacity').notNull().default(1),
    hourlyRateCents: integer('hourly_rate_cents').notNull().default(0), // rooms
    dailyRateCents: integer('daily_rate_cents').notNull().default(0), // hot desks
    amenities: text('amenities').notNull().default(''), // comma separated
    status: text('status', { enum: RESOURCE_STATUSES }).notNull().default('available'),
    notes: text('notes').notNull().default(''),
    /** The look of it in the floor plan, one of STYLES[kind]. Empty means the default for its kind. */
    style: text('style').notNull().default(''),
    // Where it sits in the floor plan, in metres from an arbitrary origin per floor. Null until it is placed.
    planX: real('plan_x'),
    planZ: real('plan_z'),
    /** Footprint override; null means the default for its kind and capacity. */
    planW: real('plan_w'),
    planD: real('plan_d'),
    /** Quarter turns, 0 to 3. */
    planRot: integer('plan_rot').notNull().default(0),
    /** What members read before booking. */
    description: text('description').notNull().default(''),
    /** Opening hours of this space when they differ from the location's. Null means the location's. */
    openTime: text('open_time'),
    closeTime: text('close_time'),
    /** Weekdays this space is shut, on top of the location's. Null means no extra closed days. */
    closedWeekdays: text('closed_weekdays'),
    // Pricing beyond the plain hourly / daily rate. All null when not used.
    /** Hourly rate outside peak hours. Null means the same as the hourly rate. */
    offPeakRateCents: integer('off_peak_rate_cents'),
    peakStart: text('peak_start'),
    peakEnd: text('peak_end'),
    /** A flat price for a booking of up to four hours, used when it is cheaper than the hourly total. */
    halfDayRateCents: integer('half_day_rate_cents'),
    /** A flat price for any booking at all, used when it is cheaper: the day pass. */
    fullDayRateCents: integer('full_day_rate_cents'),
    /** The hourly (rooms) or daily (desks) rate for a member with no plan. */
    noPlanRateCents: integer('no_plan_rate_cents'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('resources_location_name_idx').on(t.locationId, t.name)],
);

/** Things on a floor that are not rooms or desks and are not booked: a kitchen, a coffee machine, a lounge. */
export const floorObjects = sqliteTable(
  'floor_objects',
  {
    id: id(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    floor: text('floor').notNull().default(''),
    type: text('type', { enum: FLOOR_OBJECT_TYPES }).notNull(),
    label: text('label').notNull().default(''),
    x: real('x').notNull(),
    z: real('z').notNull(),
    w: real('w'),
    d: real('d'),
    rot: integer('rot').notNull().default(0),
    /** A variant of the thing: an L-shaped zone, a double door. Empty is the plain one. */
    variant: text('variant').notNull().default(''),
    /** The colour wash of a zone, one of a few presets. Empty is the default. */
    tint: text('tint').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('floor_objects_location_idx').on(t.locationId)],
);

// Dedicated desks and private offices are assigned to a member for a period rather than booked.
export const resourceAssignments = sqliteTable(
  'resource_assignments',
  {
    id: id(),
    resourceId: text('resource_id')
      .notNull()
      .references(() => resources.id),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id),
    startDate: text('start_date').notNull(),
    endDate: text('end_date'),
    createdAt: createdAt(),
  },
  (t) => [index('assignments_resource_idx').on(t.resourceId), index('assignments_member_idx').on(t.memberId)],
);

export const bookings = sqliteTable(
  'bookings',
  {
    id: id(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    resourceId: text('resource_id')
      .notNull()
      .references(() => resources.id),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id),
    startsAt: text('starts_at').notNull(),
    endsAt: text('ends_at').notNull(),
    status: text('status', { enum: BOOKING_STATUSES }).notNull().default('confirmed'),
    billableMinutes: integer('billable_minutes').notNull().default(0),
    priceCents: integer('price_cents').notNull().default(0),
    invoiceId: text('invoice_id'),
    notes: text('notes').notNull().default(''),
    createdById: text('created_by_id')
      .notNull()
      .references(() => users.id),
    cancelledAt: text('cancelled_at'),
    /** When the member was checked in at the front desk for this booking. */
    checkedInAt: text('checked_in_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('bookings_resource_idx').on(t.resourceId, t.startsAt),
    index('bookings_member_idx').on(t.memberId, t.startsAt),
    index('bookings_location_idx').on(t.locationId, t.startsAt),
  ],
);

export const attendance = sqliteTable(
  'attendance',
  {
    id: id(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id),
    resourceId: text('resource_id').references(() => resources.id),
    checkInAt: text('check_in_at').notNull(),
    checkOutAt: text('check_out_at'),
    createdAt: createdAt(),
  },
  (t) => [index('attendance_location_idx').on(t.locationId, t.checkInAt), index('attendance_member_idx').on(t.memberId)],
);

/** A team member's own clock-in and clock-out, from an attendance device. Members' visits are in `attendance`. */
export const staffAttendance = sqliteTable(
  'staff_attendance',
  {
    id: id(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    checkInAt: text('check_in_at').notNull(),
    checkOutAt: text('check_out_at'),
    createdAt: createdAt(),
  },
  (t) => [index('staff_attendance_location_idx').on(t.locationId, t.checkInAt), index('staff_attendance_user_idx').on(t.userId)],
);

// ---- Attendance devices (ZKTeco ADMS) ---------------------------------------

export const DEVICE_COMMAND_STATUSES = ['pending', 'sent', 'done', 'failed'] as const;
export const PUNCH_RESULTS = ['checked_in', 'checked_out', 'duplicate', 'ignored', 'rejected', 'unknown_pin'] as const;

/** A fingerprint machine that pushes punches to us over ADMS. It is known only by its serial number. */
export const devices = sqliteTable(
  'devices',
  {
    id: id(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    serialNumber: text('serial_number').notNull().unique(),
    name: text('name').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    lastSeenAt: text('last_seen_at'),
    /** What the device reports about itself (firmware, user and log counts), as it sent it. */
    info: text('info').notNull().default(''),
    /** How far the device has uploaded its punch log, so it does not resend everything when it restarts. */
    attlogStamp: text('attlog_stamp'),
    createdAt: createdAt(),
  },
  (t) => [index('devices_location_idx').on(t.locationId)],
);

/** Who we have put on each device, so a person who should no longer be there can be taken off. */
export const deviceUsers = sqliteTable(
  'device_users',
  {
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    pin: text('pin').notNull(),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.userId] })],
);

/** Commands waiting for a device. It collects them when it next polls and reports back on each by its number. */
export const deviceCommands = sqliteTable(
  'device_commands',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    command: text('command').notNull(),
    status: text('status', { enum: DEVICE_COMMAND_STATUSES }).notNull().default('pending'),
    returnCode: integer('return_code'),
    sentAt: text('sent_at'),
    doneAt: text('done_at'),
    createdAt: createdAt(),
  },
  (t) => [index('device_commands_device_idx').on(t.deviceId, t.status)],
);

/** Every punch a device sent, and what came of it. A device resends until we answer, so each punch is stored once. */
export const devicePunches = sqliteTable(
  'device_punches',
  {
    id: id(),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    pin: text('pin').notNull(),
    /** Null when the PIN matches nobody. */
    userId: text('user_id').references(() => users.id),
    punchedAt: text('punched_at').notNull(),
    /** The device's own fields: the state key pressed and how the person was verified (finger, card, password). */
    state: integer('state'),
    verify: integer('verify'),
    result: text('result', { enum: PUNCH_RESULTS }).notNull(),
    message: text('message').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('device_punches_unique_idx').on(t.deviceId, t.pin, t.punchedAt), index('device_punches_user_idx').on(t.userId, t.punchedAt)],
);

export const visitors = sqliteTable(
  'visitors',
  {
    id: id(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    hostMemberId: text('host_member_id')
      .notNull()
      .references(() => members.id),
    name: text('name').notNull(),
    email: text('email').notNull().default(''),
    phone: text('phone').notNull().default(''),
    company: text('company').notNull().default(''),
    purpose: text('purpose').notNull().default(''),
    expectedAt: text('expected_at').notNull(),
    status: text('status', { enum: VISITOR_STATUSES }).notNull().default('expected'),
    checkInAt: text('check_in_at'),
    checkOutAt: text('check_out_at'),
    createdAt: createdAt(),
  },
  (t) => [index('visitors_location_idx').on(t.locationId, t.expectedAt), index('visitors_host_idx').on(t.hostMemberId)],
);

export const invoices = sqliteTable(
  'invoices',
  {
    id: id(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id),
    number: text('number').notNull(),
    kind: text('kind', { enum: INVOICE_KINDS }).notNull().default('manual'),
    status: text('status', { enum: INVOICE_STATUSES }).notNull().default('open'),
    issueDate: text('issue_date').notNull(),
    dueDate: text('due_date').notNull(),
    periodStart: text('period_start'), // set on subscription invoices, 'YYYY-MM-01'
    subtotalCents: integer('subtotal_cents').notNull(),
    taxCents: integer('tax_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull(),
    paidCents: integer('paid_cents').notNull().default(0), // maintained from payments
    notes: text('notes').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [
    index('invoices_location_idx').on(t.locationId, t.status),
    index('invoices_member_idx').on(t.memberId),
    index('invoices_period_idx').on(t.memberId, t.periodStart),
    uniqueIndex('invoices_location_number_idx').on(t.locationId, t.number),
  ],
);

export const invoiceItems = sqliteTable(
  'invoice_items',
  {
    id: id(),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull().default(1),
    unitPriceCents: integer('unit_price_cents').notNull(),
    amountCents: integer('amount_cents').notNull(),
    bookingId: text('booking_id'),
  },
  (t) => [index('invoice_items_invoice_idx').on(t.invoiceId)],
);

export const payments = sqliteTable(
  'payments',
  {
    id: id(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id),
    amountCents: integer('amount_cents').notNull(),
    method: text('method', { enum: PAYMENT_METHODS }).notNull(),
    paidAt: text('paid_at').notNull(),
    reference: text('reference').notNull().default(''),
    notes: text('notes').notNull().default(''),
    recordedById: text('recorded_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('payments_location_idx').on(t.locationId, t.paidAt), index('payments_invoice_idx').on(t.invoiceId)],
);

export const expenses = sqliteTable(
  'expenses',
  {
    id: id(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    category: text('category', { enum: EXPENSE_CATEGORIES }).notNull(),
    vendor: text('vendor').notNull().default(''),
    description: text('description').notNull().default(''),
    amountCents: integer('amount_cents').notNull(),
    incurredOn: text('incurred_on').notNull(),
    createdById: text('created_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('expenses_location_idx').on(t.locationId, t.incurredOn)],
);


/** Money a coworking space pays the platform for its subscription. */
export const platformPayments = sqliteTable(
  'platform_payments',
  {
    id: id(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    packageId: text('package_id')
      .notNull()
      .references(() => packages.id),
    amountCents: integer('amount_cents').notNull(),
    method: text('method', { enum: PAYMENT_METHODS }).notNull(),
    reference: text('reference').notNull().default(''),
    notes: text('notes').notNull().default(''),
    periodStart: text('period_start').notNull(),
    periodEnd: text('period_end').notNull(),
    paidAt: text('paid_at').notNull(),
    recordedById: text('recorded_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('platform_payments_org_idx').on(t.organizationId, t.paidAt)],
);

/** A rental agreement: a member rents a dedicated desk or office (or just a membership) from a start date, with a deposit. */
export const contracts = sqliteTable(
  'contracts',
  {
    id: id(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id),
    /** The desk or office rented; null for a contract that covers no particular space. */
    resourceId: text('resource_id').references(() => resources.id),
    /** Set once the contract is active and the space has been assigned. */
    assignmentId: text('assignment_id'),
    startDate: text('start_date').notNull(),
    endDate: text('end_date'),
    rentCents: integer('rent_cents').notNull().default(0), // per month
    depositCents: integer('deposit_cents').notNull().default(0),
    depositStatus: text('deposit_status', { enum: DEPOSIT_STATUSES }).notNull().default('pending'),
    /** How much of the deposit went back to the member when it was settled. */
    depositReturnedCents: integer('deposit_returned_cents').notNull().default(0),
    /** Rent taken up front when the contract is made. Unlike the security deposit it is income from the day it is received. */
    advanceCents: integer('advance_cents').notNull().default(0),
    /** When the advance was received; null while it is still to come. */
    advanceReceivedAt: text('advance_received_at'),
    status: text('status', { enum: CONTRACT_STATUSES }).notNull().default('draft'),
    notes: text('notes').notNull().default(''),
    createdById: text('created_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('contracts_location_idx').on(t.locationId, t.status), index('contracts_member_idx').on(t.memberId)],
);

/**
 * Every movement of deposit money, so it can be reconciled against cash and the bank.
 * Received and refunded are money in and out of the till but not income; kept is the part the space
 * did not give back, which is income from the day it is kept. An advance is rent paid up front: money in and income at once.
 */
export const depositEntries = sqliteTable(
  'deposit_entries',
  {
    id: id(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    contractId: text('contract_id')
      .notNull()
      .references(() => contracts.id),
    kind: text('kind', { enum: DEPOSIT_ENTRY_KINDS }).notNull(),
    amountCents: integer('amount_cents').notNull(),
    /** How the money moved. A kept amount moves no money, so it has none. */
    method: text('method', { enum: PAYMENT_METHODS }),
    reference: text('reference').notNull().default(''),
    occurredAt: text('occurred_at').notNull(),
    recordedById: text('recorded_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('deposit_entries_location_idx').on(t.locationId, t.occurredAt), index('deposit_entries_contract_idx').on(t.contractId)],
);

/**
 * A named time slot that members can pick when booking, like "Morning, 09:00 to 14:00", with an optional fixed price.
 * It covers one space, or every space of a kind, or every bookable space when neither is given.
 */
export const shiftTemplates = sqliteTable(
  'shift_templates',
  {
    id: id(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    name: text('name').notNull(),
    resourceId: text('resource_id').references(() => resources.id),
    kind: text('kind', { enum: RESOURCE_KINDS }),
    startTime: text('start_time').notNull(),
    endTime: text('end_time').notNull(),
    /** When set, a booking that matches this shift exactly costs this, instead of being worked out by the hour. */
    priceCents: integer('price_cents'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('shift_templates_location_idx').on(t.locationId)],
);

/** A notice to members. A draft is hidden; with a publish time it goes live then, without one it is live at once. */
export const announcements = sqliteTable(
  'announcements',
  {
    id: id(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    draft: integer('draft', { mode: 'boolean' }).notNull().default(true),
    /** ISO instant it goes live; null means as soon as it is not a draft. */
    publishAt: text('publish_at'),
    createdById: text('created_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('announcements_location_idx').on(t.locationId, t.createdAt)],
);

/** Photos of a space, kept in the database so they belong to the tenant and need no separate storage. */
export const resourcePhotos = sqliteTable(
  'resource_photos',
  {
    id: id(),
    resourceId: text('resource_id')
      .notNull()
      .references(() => resources.id),
    contentType: text('content_type').notNull(),
    data: blob('data', { mode: 'buffer' }).notNull(),
    caption: text('caption').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('resource_photos_resource_idx').on(t.resourceId)],
);

/** Cleaning, upkeep and inspections of a space, one-off or repeating. */
export const spaceTasks = sqliteTable(
  'space_tasks',
  {
    id: id(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    /** Null for a job that covers the whole location. */
    resourceId: text('resource_id').references(() => resources.id),
    kind: text('kind', { enum: TASK_KINDS }).notNull().default('cleaning'),
    title: text('title').notNull(),
    notes: text('notes').notNull().default(''),
    /** Repeats this many days after it is done. Null for a one-off. */
    everyDays: integer('every_days'),
    nextDue: text('next_due').notNull(),
    lastDoneAt: text('last_done_at'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('space_tasks_location_idx').on(t.locationId, t.active, t.nextDue), index('space_tasks_resource_idx').on(t.resourceId)],
);

export const taskLogs = sqliteTable(
  'task_logs',
  {
    id: id(),
    taskId: text('task_id')
      .notNull()
      .references(() => spaceTasks.id, { onDelete: 'cascade' }),
    doneAt: text('done_at').notNull(),
    doneById: text('done_by_id')
      .notNull()
      .references(() => users.id),
    note: text('note').notNull().default(''),
  },
  (t) => [index('task_logs_task_idx').on(t.taskId)],
);

/** Equipment that belongs to a space: monitors, a projector, chairs. */
export const spaceAssets = sqliteTable(
  'space_assets',
  {
    id: id(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    resourceId: text('resource_id').references(() => resources.id),
    name: text('name').notNull(),
    category: text('category').notNull().default(''),
    serialNumber: text('serial_number').notNull().default(''),
    purchasedOn: text('purchased_on'),
    warrantyUntil: text('warranty_until'),
    status: text('status', { enum: ASSET_STATUSES }).notNull().default('working'),
    notes: text('notes').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('space_assets_location_idx').on(t.locationId), index('space_assets_resource_idx').on(t.resourceId)],
);

/** A problem someone reports about a space ("AC not working in Meeting Room 2"). */
export const issues = sqliteTable(
  'issues',
  {
    id: id(),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    resourceId: text('resource_id')
      .notNull()
      .references(() => resources.id),
    reportedById: text('reported_by_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    priority: text('priority', { enum: ISSUE_PRIORITIES }).notNull().default('normal'),
    status: text('status', { enum: ISSUE_STATUSES }).notNull().default('open'),
    resolution: text('resolution').notNull().default(''),
    /** The maintenance task made from it, when there is one. */
    taskId: text('task_id'),
    createdAt: createdAt(),
    resolvedAt: text('resolved_at'),
  },
  (t) => [index('issues_location_idx').on(t.locationId, t.status), index('issues_resource_idx').on(t.resourceId), index('issues_reporter_idx').on(t.reportedById)],
);

/** A saved arrangement of things that can be dropped onto any floor of any location in the organization. */
export const floorTemplates = sqliteTable(
  'floor_templates',
  {
    id: id(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    /** JSON: the things, positioned relative to the template's own corner. */
    data: text('data').notNull(),
    createdById: text('created_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('floor_templates_org_name_idx').on(t.organizationId, t.name)],
);
