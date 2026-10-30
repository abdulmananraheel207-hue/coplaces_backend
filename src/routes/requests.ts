import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { resources } from '../db/schema.js';
import { requireLocationId } from '../lib/access.js';
import { assertLocation, isStaff } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { idParam, queryString } from '../lib/http.js';
import { assertCan } from '../lib/permissions.js';
import { TIME_RE, isValidDate } from '../lib/time.js';
import { parse } from '../lib/validate.js';
import { approveRequest, cancelRequest, createRequest, listRequests, queueAhead, rejectRequest } from '../services/roomRequests.js';

const timeStr = z.string().regex(TIME_RE, 'Use HH:mm');
const times = z.object({
  resourceId: z.string(),
  date: z.string().refine(isValidDate, 'Use YYYY-MM-DD'),
  startTime: timeStr,
  endTime: timeStr,
});

/** Requests for meeting rooms and the like: members ask, the owner or front desk decides. */
export function requestsRouter(db: Db) {
  const r = Router();

  r.get('/', async (req, res) => {
    const user = req.user!;
    if (isStaff(user)) assertCan(user, 'bookings');
    res.json(await listRequests(db, user, requireLocationId(req), queryString(req, 'status')));
  });

  /** How many others are already waiting for this room at an overlapping time, for the form to say so before anyone asks. */
  r.get('/queue', async (req, res) => {
    const t = parse(times, { resourceId: queryString(req, 'resourceId'), date: queryString(req, 'date'), startTime: queryString(req, 'startTime'), endTime: queryString(req, 'endTime') });
    const resource = await db.select().from(resources).where(eq(resources.id, t.resourceId)).get();
    if (!resource) throw notFound('Resource');
    assertLocation(req.user!, resource.locationId);
    res.json({ ahead: await queueAhead(db, t, req.user!.memberId ?? undefined) });
  });

  r.post('/', async (req, res) => {
    const body = parse(times.extend({ notes: z.string().trim().max(500).default('') }), req.body);
    res.status(201).json(await createRequest(db, req.user!, body));
  });

  r.post('/:id/cancel', async (req, res) => {
    res.json(await cancelRequest(db, req.user!, idParam(req)));
  });

  r.post('/:id/approve', async (req, res) => {
    assertCan(req.user!, 'bookings');
    res.json(await approveRequest(db, req.user!, idParam(req)));
  });

  r.post('/:id/reject', async (req, res) => {
    assertCan(req.user!, 'bookings');
    const body = parse(z.object({ reason: z.string().trim().max(300).default('') }), req.body);
    res.json(await rejectRequest(db, req.user!, idParam(req), body.reason));
  });

  return r;
}
