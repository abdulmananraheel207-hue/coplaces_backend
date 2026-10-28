import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { attendance, deviceCommands, devicePunches, devices, deviceUsers, members, PUNCH_RESULTS, staffAttendance, userLocations, users } from '../db/schema.js';
import { loadLocation } from '../lib/access.js';
import { HttpError } from '../lib/errors.js';
import { isValidDate, todayIn, zonedToUtc } from '../lib/time.js';
import { checkInMember, closeStaleVisits, finishBookingOnCheckOut } from './checkin.js';

// ZKTeco devices talk ADMS (the "push" protocol): plain-text HTTP the device starts, so it can sit behind any office
// router. Fingerprints stay on the device. We only ever send it people's PINs and names, and it sends us punches.

export type Device = typeof devices.$inferSelect;
type PunchResult = (typeof PUNCH_RESULTS)[number];

/** How often the device polls for commands, in seconds. Each poll is one request, so a change takes up to this long to arrive. */
export const POLL_SECONDS = 30;
/** A second punch this soon after the last one is a repeat (a finger held twice), not a check-out. */
const REPEAT_MS = 60_000;
/** A team member's clock-in this old is taken as a missed clock-out, so the next punch starts a new shift. Long enough for a night shift. */
const SHIFT_MS = 16 * 3_600_000;
/** Members' punches older than this are not applied: booking and opening-hours rules cannot be judged that late. */
const MEMBER_LATE_MS = 24 * 3_600_000;
/** A punch this far ahead of the server means the device clock is wrong. */
const CLOCK_SKEW_MS = 5 * 60_000;
/** A command the device collected but never answered is sent again after this long. */
const RESEND_MS = 10 * 60_000;
/** A device that has not polled for this long is shown as offline. */
export const ONLINE_MS = 3 * POLL_SECONDS * 1000;

export interface AttlogLine {
  pin: string;
  /** Wall-clock time on the device, 'YYYY-MM-DD HH:MM:SS'. */
  time: string;
  state: number | null;
  verify: number | null;
}

const int = (s: string | undefined) => (s && /^-?\d+$/.test(s.trim()) ? Number(s.trim()) : null);

/** Punch lines: `PIN \t YYYY-MM-DD HH:MM:SS \t state \t verify \t workcode ...`. Lines that do not parse are skipped. */
export function parseAttlog(body: string): AttlogLine[] {
  const out: AttlogLine[] = [];
  for (const line of body.split(/\r?\n/)) {
    const [pin, time, state, verify] = line.split('\t').map((f) => f.trim());
    if (!pin || !/^\d{1,24}$/.test(pin) || !time || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(time)) continue;
    out.push({ pin, time, state: int(state), verify: int(verify) });
  }
  return out;
}

/** Command results: one `ID=12&Return=0&CMD=DATA` per line. */
export function parseCommandResults(body: string) {
  return body
    .split(/\r?\n/)
    .map((line) => new URLSearchParams(line.trim()))
    .map((p) => ({ id: int(p.get('ID') ?? undefined), returnCode: int(p.get('Return') ?? undefined) }))
    .filter((r): r is { id: number; returnCode: number | null } => r.id !== null);
}

/** The device's wall-clock time as a UTC instant, read in the location's timezone. Null if it is not a real time. */
export function deviceTimeToUtc(time: string, tz: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(time);
  if (!m || !isValidDate(m[1]!) || Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4]) > 59) return null;
  return new Date(zonedToUtc(m[1]!, `${m[2]}:${m[3]}`, tz).getTime() + Number(m[4]) * 1000).toISOString();
}

/** The timezone's offset from UTC in hours today, which is how the device wants it. */
export function utcOffsetHours(tz: string, now = new Date()) {
  const date = todayIn(tz, now);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return (Date.UTC(y, m - 1, d, 12) - zonedToUtc(date, '12:00', tz).getTime()) / 3_600_000;
}

/** What the device is told when it starts up. TransFlag leaves out fingerprint templates, so they never leave the device. */
export function handshake(device: Device, tz: string, now = new Date()) {
  return [
    `GET OPTION FROM: ${device.serialNumber}`,
    `ATTLOGStamp=${device.attlogStamp ?? 'None'}`,
    'OPERLOGStamp=9999',
    'ATTPHOTOStamp=None',
    'ErrorDelay=60',
    `Delay=${POLL_SECONDS}`,
    'TransTimes=00:00;14:05',
    'TransInterval=1',
    'TransFlag=TransData AttLog',
    `TimeZone=${utcOffsetHours(tz, now)}`,
    'Realtime=1',
    'Encrypt=None',
  ].join('\n');
}

// ---- Users on the device -----------------------------------------------------

/** Names are shown on the device screen, which takes a short line of plain text. */
const deviceName = (name: string) => name.replace(/[\t\r\n]/g, ' ').trim().slice(0, 24);
const userCommand = (pin: string, name: string) => `DATA UPDATE USERINFO PIN=${pin}\tName=${deviceName(name)}`;
const deleteCommand = (pin: string) => `DATA DELETE USERINFO PIN=${pin}`;

async function enqueue(db: Db, deviceId: string, command: string) {
  await db.insert(deviceCommands).values({ deviceId, command }).run();
}

/** Gives the user the next free PIN in their organization, unless they have one. */
async function ensurePin(db: Db, user: { id: string; organizationId: string | null; devicePin: string | null }) {
  if (user.devicePin) return user.devicePin;
  for (let attempt = 0; ; attempt++) {
    const row = await db
      .select({ max: sql<number | null>`max(cast(${users.devicePin} as integer))` })
      .from(users)
      .where(eq(users.organizationId, user.organizationId!))
      .get();
    const pin = String((row?.max ?? 0) + 1);
    try {
      await db.update(users).set({ devicePin: pin }).where(eq(users.id, user.id)).run();
      return pin;
    } catch (err) {
      // Someone else took that number at the same moment.
      if (attempt >= 2) throw err;
    }
  }
}

/** Everyone who should be able to punch in at a location: its active members and team, and the organization's owners. */
async function peopleAt(db: Db, organizationId: string, locationId: string) {
  const cols = { id: users.id, name: users.name, organizationId: users.organizationId, devicePin: users.devicePin };
  const memberRows = await db
    .select(cols)
    .from(users)
    .innerJoin(members, eq(members.userId, users.id))
    .where(and(eq(members.locationId, locationId), ne(members.status, 'cancelled'), eq(users.active, true)))
    .all();
  const team = await db
    .select(cols)
    .from(users)
    .innerJoin(userLocations, eq(userLocations.userId, users.id))
    .where(and(eq(userLocations.locationId, locationId), inArray(users.role, ['manager', 'staff']), eq(users.active, true)))
    .all();
  const owners = await db
    .select(cols)
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.role, 'owner'), eq(users.active, true)))
    .all();
  return [...memberRows, ...team, ...owners];
}

/** Whether the user belongs on devices at this location. */
async function belongsAt(db: Db, user: typeof users.$inferSelect, locationId: string) {
  if (!user.active) return false;
  if (user.role === 'owner') return true;
  if (user.role === 'member') {
    const m = await db.select().from(members).where(eq(members.userId, user.id)).get();
    return !!m && m.locationId === locationId && m.status !== 'cancelled';
  }
  if (user.role === 'manager' || user.role === 'staff') {
    return !!(await db.select().from(userLocations).where(and(eq(userLocations.userId, user.id), eq(userLocations.locationId, locationId))).get());
  }
  return false;
}

/**
 * Brings one device's user list in line with who should be on it: adds anyone missing, and takes off anyone who has left.
 * With `all`, everyone is sent again, which repairs a device that was reset or had people edited by hand.
 */
export async function syncDevice(db: Db, device: Device, opts: { all?: boolean } = {}) {
  const wanted = device.active ? await peopleAt(db, device.organizationId, device.locationId) : [];
  const onDevice = new Map((await db.select().from(deviceUsers).where(eq(deviceUsers.deviceId, device.id)).all()).map((d) => [d.userId, d]));
  let sent = 0;
  for (const u of wanted) {
    const pin = await ensurePin(db, u);
    const had = onDevice.get(u.id);
    onDevice.delete(u.id);
    if (had && had.pin === pin && !opts.all) continue;
    if (had && had.pin !== pin) await enqueue(db, device.id, deleteCommand(had.pin));
    await enqueue(db, device.id, userCommand(pin, u.name));
    await db
      .insert(deviceUsers)
      .values({ deviceId: device.id, userId: u.id, pin })
      .onConflictDoUpdate({ target: [deviceUsers.deviceId, deviceUsers.userId], set: { pin } })
      .run();
    sent++;
  }
  for (const gone of onDevice.values()) {
    await enqueue(db, device.id, deleteCommand(gone.pin));
    await db.delete(deviceUsers).where(and(eq(deviceUsers.deviceId, device.id), eq(deviceUsers.userId, gone.userId))).run();
  }
  return { sent, removed: onDevice.size };
}

/** After a person is added or changed: puts them on the devices where they belong (with their current name), and off the rest. */
export async function syncUser(db: Db, userId: string) {
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user?.organizationId) return;
  const orgDevices = await db.select().from(devices).where(and(eq(devices.organizationId, user.organizationId), eq(devices.active, true))).all();
  for (const device of orgDevices) {
    const had = await db.select().from(deviceUsers).where(and(eq(deviceUsers.deviceId, device.id), eq(deviceUsers.userId, user.id))).get();
    if (await belongsAt(db, user, device.locationId)) {
      const pin = await ensurePin(db, user);
      user.devicePin = pin;
      if (had && had.pin !== pin) await enqueue(db, device.id, deleteCommand(had.pin));
      await enqueue(db, device.id, userCommand(pin, user.name));
      await db
        .insert(deviceUsers)
        .values({ deviceId: device.id, userId: user.id, pin })
        .onConflictDoUpdate({ target: [deviceUsers.deviceId, deviceUsers.userId], set: { pin } })
        .run();
    } else if (had) {
      await enqueue(db, device.id, deleteCommand(had.pin));
      await db.delete(deviceUsers).where(and(eq(deviceUsers.deviceId, device.id), eq(deviceUsers.userId, user.id))).run();
    }
  }
}

/**
 * Sets or clears a user's PIN, e.g. to match someone already enrolled on a device under that number. The devices
 * are told to drop the old number and take the new one.
 */
export async function setPin(db: Db, userId: string, pin: string | null) {
  await db.update(users).set({ devicePin: pin }).where(eq(users.id, userId)).run();
  if (pin) return syncUser(db, userId);
  for (const had of await db.select().from(deviceUsers).where(eq(deviceUsers.userId, userId)).all()) {
    await enqueue(db, had.deviceId, deleteCommand(had.pin));
  }
  await db.delete(deviceUsers).where(eq(deviceUsers.userId, userId)).run();
}

// ---- The device's polls --------------------------------------------------------

/** Commands for the device: new ones, and any it took earlier without answering. Each goes as `C:<id>:<command>`. */
export async function collectCommands(db: Db, device: Device, now = new Date()) {
  const rows = await db
    .select()
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, device.id),
        or(eq(deviceCommands.status, 'pending'), and(eq(deviceCommands.status, 'sent'), lte(deviceCommands.sentAt, new Date(now.getTime() - RESEND_MS).toISOString()))),
      ),
    )
    .orderBy(asc(deviceCommands.id))
    .limit(20)
    .all();
  if (!rows.length) return 'OK';
  await db
    .update(deviceCommands)
    .set({ status: 'sent', sentAt: now.toISOString() })
    .where(inArray(deviceCommands.id, rows.map((c) => c.id)))
    .run();
  return rows.map((c) => `C:${c.id}:${c.command}`).join('\n');
}

/** The device's answers to commands. A negative return code is a failure. */
export async function recordCommandResults(db: Db, device: Device, body: string, now = new Date()) {
  for (const r of parseCommandResults(body)) {
    await db
      .update(deviceCommands)
      .set({ status: r.returnCode !== null && r.returnCode < 0 ? 'failed' : 'done', returnCode: r.returnCode, doneAt: now.toISOString() })
      .where(and(eq(deviceCommands.id, r.id), eq(deviceCommands.deviceId, device.id)))
      .run();
  }
}

// ---- Punches -------------------------------------------------------------------

type Outcome = { result: PunchResult; message: string; userId?: string };

/** Members: a punch checks them in at the door, under the same rules as the front desk, or checks them out if they are in. */
async function memberPunch(db: Db, device: Device, user: typeof users.$inferSelect, at: string, now: Date): Promise<Outcome> {
  const member = await db.select().from(members).where(eq(members.userId, user.id)).get();
  if (!member) return { result: 'rejected', message: 'No membership for this account' };
  if (member.locationId !== device.locationId) return { result: 'rejected', message: 'Member of another location' };
  if (member.status !== 'active') return { result: 'rejected', message: `Membership is ${member.status}` };
  if (now.getTime() - Date.parse(at) > MEMBER_LATE_MS) return { result: 'ignored', message: 'Too old to apply to a member' };

  await closeStaleVisits(db, member.locationId, new Date(at));
  const open = await db.select().from(attendance).where(and(eq(attendance.memberId, member.id), isNull(attendance.checkOutAt))).get();
  if (open) {
    if (at < open.checkInAt) return { result: 'ignored', message: 'Earlier than their current check-in' };
    await db.update(attendance).set({ checkOutAt: at }).where(eq(attendance.id, open.id)).run();
    await finishBookingOnCheckOut(db, open, new Date(at));
    return { result: 'checked_out', message: '' };
  }
  try {
    await checkInMember(db, member, null, new Date(at));
    return { result: 'checked_in', message: '' };
  } catch (err) {
    if (err instanceof HttpError) return { result: 'rejected', message: err.message };
    throw err;
  }
}

/** The team: a punch clocks them in, or out if they clocked in within the last shift. No booking or opening-hours rules. */
async function staffPunch(db: Db, device: Device, user: typeof users.$inferSelect, at: string): Promise<Outcome> {
  if (!(await belongsAt(db, user, device.locationId))) return { result: 'rejected', message: 'Not on the team at this location' };
  const open = await db
    .select()
    .from(staffAttendance)
    .where(and(eq(staffAttendance.userId, user.id), isNull(staffAttendance.checkOutAt), gte(staffAttendance.checkInAt, new Date(Date.parse(at) - SHIFT_MS).toISOString())))
    .orderBy(desc(staffAttendance.checkInAt))
    .get();
  if (open) {
    if (at < open.checkInAt) return { result: 'ignored', message: 'Earlier than their current clock-in' };
    await db.update(staffAttendance).set({ checkOutAt: at }).where(eq(staffAttendance.id, open.id)).run();
    return { result: 'checked_out', message: '' };
  }
  await db.insert(staffAttendance).values({ locationId: device.locationId, userId: user.id, checkInAt: at }).run();
  return { result: 'checked_in', message: '' };
}

async function judge(db: Db, device: Device, line: AttlogLine, at: string, now: Date): Promise<Outcome> {
  const user = await db.select().from(users).where(and(eq(users.organizationId, device.organizationId), eq(users.devicePin, line.pin))).get();
  if (!user) return { result: 'unknown_pin', message: 'Nobody has this PIN' };
  const withUser = (o: Outcome): Outcome => ({ ...o, userId: user.id });
  if (at < device.createdAt) return withUser({ result: 'ignored', message: 'Punched before this device was linked' });
  if (Date.parse(at) - now.getTime() > CLOCK_SKEW_MS) return withUser({ result: 'rejected', message: 'The device clock is ahead of the server' });
  if (!user.active) return withUser({ result: 'rejected', message: 'Account is disabled' });

  const recent = await db
    .select({ id: devicePunches.id })
    .from(devicePunches)
    .where(
      and(
        eq(devicePunches.userId, user.id),
        inArray(devicePunches.result, ['checked_in', 'checked_out']),
        gte(devicePunches.punchedAt, new Date(Date.parse(at) - REPEAT_MS).toISOString()),
        lte(devicePunches.punchedAt, at),
      ),
    )
    .get();
  if (recent) return withUser({ result: 'duplicate', message: 'Punched again within a minute' });

  return withUser(user.role === 'member' ? await memberPunch(db, device, user, at, now) : await staffPunch(db, device, user, at));
}

/**
 * Applies a batch of punches, oldest first. Every punch is stored with what came of it, including those that changed
 * nothing, so the device can be told OK and stop resending. A punch already stored is skipped.
 */
export async function recordPunches(db: Db, device: Device, body: string, now = new Date()) {
  const tz = (await loadLocation(db, device.locationId)).timezone;
  const lines = parseAttlog(body)
    .map((line) => ({ line, at: deviceTimeToUtc(line.time, tz) }))
    .filter((p): p is { line: AttlogLine; at: string } => p.at !== null)
    .sort((a, b) => a.at.localeCompare(b.at));
  const results: (Outcome & { pin: string; at: string })[] = [];
  for (const { line, at } of lines) {
    const seen = await db
      .select({ id: devicePunches.id })
      .from(devicePunches)
      .where(and(eq(devicePunches.deviceId, device.id), eq(devicePunches.pin, line.pin), eq(devicePunches.punchedAt, at)))
      .get();
    if (seen) continue;
    const outcome = await judge(db, device, line, at, now);
    await db
      .insert(devicePunches)
      .values({ deviceId: device.id, pin: line.pin, userId: outcome.userId ?? null, punchedAt: at, state: line.state, verify: line.verify, result: outcome.result, message: outcome.message })
      .onConflictDoNothing()
      .run();
    results.push({ ...outcome, pin: line.pin, at });
  }
  return { received: lines.length, results };
}
