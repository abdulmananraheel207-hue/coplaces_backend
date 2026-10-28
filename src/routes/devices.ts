import { Router } from 'express';
import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { deviceCommands, devicePunches, devices, deviceUsers, PUNCH_RESULTS, users } from '../db/schema.js';
import { loadLocation, requireLocationId } from '../lib/access.js';
import { assertLocation, managerUp, staffOnly, type AuthUser } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { idParam, queryString } from '../lib/http.js';
import { dayRange, isValidDate, todayIn } from '../lib/time.js';
import { parse } from '../lib/validate.js';
import { ONLINE_MS, setPin, syncDevice, syncUser } from '../services/devices.js';

/** Serial numbers are printed on the device and shown under System Info. */
const serialNumber = z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Use the serial number exactly as the device shows it');
const pin = z.string().trim().regex(/^[1-9]\d{0,8}$/, 'A PIN is 1 to 9 digits and does not start with 0');

/** Attendance devices: registering them, the people on them, and what they have sent. */
export function devicesRouter(db: Db) {
  const r = Router();

  async function loadDevice(user: AuthUser, id: string) {
    const device = await db.select().from(devices).where(eq(devices.id, id)).get();
    if (!device || device.organizationId !== user.organizationId) throw notFound('Device');
    assertLocation(user, device.locationId);
    return device;
  }

  r.get('/', staffOnly, async (req, res) => {
    const locationId = requireLocationId(req);
    const rows = await db.select().from(devices).where(eq(devices.locationId, locationId)).all();
    const waiting = rows.length
      ? await db.select({ deviceId: deviceCommands.deviceId }).from(deviceCommands).where(and(inArray(deviceCommands.deviceId, rows.map((d) => d.id)), inArray(deviceCommands.status, ['pending', 'sent']))).all()
      : [];
    const now = Date.now();
    res.json(
      rows.map((d) => ({
        ...d,
        online: !!d.lastSeenAt && now - Date.parse(d.lastSeenAt) < ONLINE_MS,
        commandsWaiting: waiting.filter((w) => w.deviceId === d.id).length,
      })),
    );
  });

  r.post('/', managerUp, async (req, res) => {
    const body = parse(z.object({ locationId: z.string(), serialNumber, name: z.string().trim().min(1).max(80) }), req.body);
    assertLocation(req.user!, body.locationId);
    const loc = await loadLocation(db, body.locationId);
    if (await db.select().from(devices).where(eq(devices.serialNumber, body.serialNumber)).get()) throw conflict('That device is already registered');
    const device = await db.insert(devices).values({ organizationId: loc.organizationId, locationId: loc.id, serialNumber: body.serialNumber, name: body.name }).returning().get();
    // Everyone at the location goes onto the device, waiting for its first poll.
    const sync = await syncDevice(db, device);
    res.status(201).json({ ...device, ...sync });
  });

  r.patch('/:id', managerUp, async (req, res) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(80), active: z.boolean(), locationId: z.string() }).partial(), req.body);
    const device = await loadDevice(req.user!, idParam(req));
    if (body.locationId) assertLocation(req.user!, body.locationId);
    const updated = await db.update(devices).set(body).where(eq(devices.id, device.id)).returning().get();
    // Moving or switching a device back on changes who belongs on it.
    if (updated.locationId !== device.locationId || (updated.active && !device.active)) await syncDevice(db, updated);
    res.json(updated);
  });

  /** Sends everyone at the location to the device again, e.g. after it was reset. */
  r.post('/:id/sync', managerUp, async (req, res) => {
    const device = await loadDevice(req.user!, idParam(req));
    if (!device.active) throw badRequest('Switch the device on first');
    res.json(await syncDevice(db, device, { all: true }));
  });

  r.post('/:id/commands', managerUp, async (req, res) => {
    const body = parse(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('reboot') }),
        z.object({ kind: z.literal('info') }),
        // Asks the device to upload its punches again, e.g. after the server was unreachable for a while.
        z.object({ kind: z.literal('upload_punches'), from: z.string().refine(isValidDate, 'Use YYYY-MM-DD'), to: z.string().refine(isValidDate, 'Use YYYY-MM-DD') }),
      ]),
      req.body,
    );
    const device = await loadDevice(req.user!, idParam(req));
    const command =
      body.kind === 'reboot' ? 'REBOOT' : body.kind === 'info' ? 'INFO' : `DATA QUERY ATTLOG StartTime=${body.from} 00:00:00\tEndTime=${body.to} 23:59:59`;
    const row = await db.insert(deviceCommands).values({ deviceId: device.id, command }).returning().get();
    res.status(201).json(row);
  });

  r.get('/:id/commands', managerUp, async (req, res) => {
    const device = await loadDevice(req.user!, idParam(req));
    res.json(await db.select().from(deviceCommands).where(eq(deviceCommands.deviceId, device.id)).orderBy(desc(deviceCommands.id)).limit(100).all());
  });

  /** What the device sent on a day, and what came of each punch. `?result=unknown_pin` finds people enrolled on the device but not linked. */
  r.get('/:id/punches', staffOnly, async (req, res) => {
    const device = await loadDevice(req.user!, idParam(req));
    const tz = (await loadLocation(db, device.locationId)).timezone;
    const date = queryString(req, 'date') ?? todayIn(tz);
    if (!isValidDate(date)) throw badRequest('date must be YYYY-MM-DD');
    const range = dayRange(date, tz);
    const conds = [eq(devicePunches.deviceId, device.id), gte(devicePunches.punchedAt, range.start), lt(devicePunches.punchedAt, range.end)];
    const result = queryString(req, 'result');
    if (result) {
      if (!(PUNCH_RESULTS as readonly string[]).includes(result)) throw badRequest('Unknown result');
      conds.push(eq(devicePunches.result, result as (typeof PUNCH_RESULTS)[number]));
    }
    const rows = await db
      .select({ p: devicePunches, name: users.name, role: users.role })
      .from(devicePunches)
      .leftJoin(users, eq(users.id, devicePunches.userId))
      .where(and(...conds))
      .orderBy(desc(devicePunches.punchedAt))
      .limit(1000)
      .all();
    res.json(rows.map(({ p, ...rest }) => ({ ...p, ...rest })));
  });

  /** Who is on the device and under which PIN. */
  r.get('/:id/people', staffOnly, async (req, res) => {
    const device = await loadDevice(req.user!, idParam(req));
    const rows = await db
      .select({ userId: users.id, name: users.name, role: users.role, pin: deviceUsers.pin })
      .from(deviceUsers)
      .innerJoin(users, eq(users.id, deviceUsers.userId))
      .where(eq(deviceUsers.deviceId, device.id))
      .all();
    res.json(rows.sort((a, b) => Number(a.pin) - Number(b.pin)));
  });

  /**
   * Gives someone a particular PIN, e.g. the number they are already enrolled under on the device, or clears it
   * (taking them off every device). Their fingerprints stay on the device under that number.
   */
  r.put('/pins/:id', managerUp, async (req, res) => {
    const body = parse(z.object({ pin: pin.nullable() }), req.body);
    const target = await db.select().from(users).where(eq(users.id, idParam(req))).get();
    if (!target || target.organizationId !== req.user!.organizationId) throw notFound('Person');
    if (body.pin && body.pin !== target.devicePin) {
      const taken = await db.select({ name: users.name }).from(users).where(and(eq(users.organizationId, target.organizationId!), eq(users.devicePin, body.pin))).get();
      if (taken) throw conflict(`PIN ${body.pin} belongs to ${taken.name}`);
    }
    await setPin(db, target.id, body.pin);
    res.json({ userId: target.id, pin: body.pin });
  });

  /** Puts one person on their devices again, e.g. after their name changed. */
  r.post('/people/:id/sync', managerUp, async (req, res) => {
    const target = await db.select().from(users).where(eq(users.id, idParam(req))).get();
    if (!target || target.organizationId !== req.user!.organizationId) throw notFound('Person');
    await syncUser(db, target.id);
    res.json({ ok: true });
  });

  return r;
}
