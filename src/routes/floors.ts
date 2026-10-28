import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { requireLocationId } from '../lib/access.js';
import { assertLocation } from '../lib/auth.js';
import { requirePermission } from '../lib/permissions.js';
import { parse } from '../lib/validate.js';
import { assertFloorsWithinLimit, deleteFloor, floorsOf, saveFloors } from '../services/floors.js';

const body = z.object({
  locationId: z.string(),
  names: z
    .array(z.string().trim().min(1, 'Give every floor a name').max(50))
    .min(1)
    .max(100)
    .refine((xs) => new Set(xs.map((x) => x.toLowerCase())).size === xs.length, 'Floor names must be different from each other'),
});

export function floorsRouter(db: Db) {
  const r = Router();

  r.get('/', requirePermission('spaces'), async (req, res) => {
    const locationId = requireLocationId(req);
    res.json({ floors: await floorsOf(db, locationId), limit: req.user!.org?.maxFloors ?? null });
  });

  r.post('/', requirePermission('spaces'), async (req, res) => {
    const input = parse(body, req.body);
    assertLocation(req.user!, input.locationId);
    await assertFloorsWithinLimit(db, req.user!, input.locationId, input.names);
    await saveFloors(db, input.locationId, input.names);
    res.status(201).json({ floors: await floorsOf(db, input.locationId) });
  });

  r.delete('/', requirePermission('spaces'), async (req, res) => {
    const locationId = requireLocationId(req);
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    await deleteFloor(db, locationId, name);
    res.json({ floors: await floorsOf(db, locationId) });
  });

  return r;
}
