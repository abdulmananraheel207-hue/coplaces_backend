import express, { Router, type Request, type Response } from 'express';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { devices, organizations } from '../db/schema.js';
import { loadLocation } from '../lib/access.js';
import { queryString } from '../lib/http.js';
import { collectCommands, handshake, recordCommandResults, recordPunches, type Device } from '../services/devices.js';

/** How often a device's last-seen time is written. It polls every few seconds and the database need not hear each one. */
const SEEN_EVERY_MS = 60_000;

/**
 * The ZKTeco ADMS protocol, for attendance devices. Devices cannot sign in: they are known only by the serial number
 * they send, which must be registered to a location first. Bodies and answers are plain text, not JSON.
 */
export function iclockRouter(db: Db) {
  const r = Router();
  // A device that was offline sends its whole backlog in one request.
  r.use(express.text({ type: () => true, limit: '2mb' }));

  const reply = (res: Response, body: string, status = 200) => res.status(status).type('text/plain').send(body);

  /** The registered, active device making the request, or null after answering for it. */
  async function deviceFor(req: Request, res: Response): Promise<Device | null> {
    const sn = queryString(req, 'SN');
    const row = sn
      ? await db.select({ device: devices, orgStatus: organizations.status }).from(devices).innerJoin(organizations, eq(organizations.id, devices.organizationId)).where(eq(devices.serialNumber, sn)).get()
      : undefined;
    if (!row || !row.device.active || row.orgStatus === 'suspended' || row.orgStatus === 'cancelled') {
      // Shown in the server log so whoever is setting the device up can find its serial number.
      console.warn(`Attendance device ${sn ?? '(no SN)'} is not registered or not active; refused ${req.method} ${req.path}`);
      reply(res, 'Unknown device', 403);
      return null;
    }
    const device = row.device;
    const info = queryString(req, 'INFO');
    const now = new Date();
    if (!device.lastSeenAt || now.getTime() - Date.parse(device.lastSeenAt) > SEEN_EVERY_MS || (info && info !== device.info)) {
      const patch = { lastSeenAt: now.toISOString(), ...(info ? { info } : {}) };
      await db.update(devices).set(patch).where(eq(devices.id, device.id)).run();
      Object.assign(device, patch);
    }
    return device;
  }

  // Older firmware asks for the same paths with .aspx on the end.
  r.get(['/cdata', '/cdata.aspx'], async (req, res) => {
    const device = await deviceFor(req, res);
    if (!device) return;
    reply(res, handshake(device, (await loadLocation(db, device.locationId)).timezone));
  });

  r.post(['/cdata', '/cdata.aspx'], async (req, res) => {
    const device = await deviceFor(req, res);
    if (!device) return;
    const body = typeof req.body === 'string' ? req.body : '';
    if (queryString(req, 'table') !== 'ATTLOG') {
      // Operation logs, photos and the like. Nothing we keep; fingerprint templates are never asked for.
      reply(res, 'OK');
      return;
    }
    const { received } = await recordPunches(db, device, body);
    const stamp = queryString(req, 'Stamp');
    if (stamp && stamp !== device.attlogStamp) await db.update(devices).set({ attlogStamp: stamp }).where(eq(devices.id, device.id)).run();
    reply(res, `OK: ${received}`);
  });

  r.get(['/getrequest', '/getrequest.aspx'], async (req, res) => {
    const device = await deviceFor(req, res);
    if (!device) return;
    reply(res, await collectCommands(db, device));
  });

  r.post(['/devicecmd', '/devicecmd.aspx'], async (req, res) => {
    const device = await deviceFor(req, res);
    if (!device) return;
    await recordCommandResults(db, device, typeof req.body === 'string' ? req.body : '');
    reply(res, 'OK');
  });

  r.all('/ping', async (req, res) => {
    if (await deviceFor(req, res)) reply(res, 'OK');
  });

  return r;
}
