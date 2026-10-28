import { Router } from 'express';
import { requireLocationId } from '../lib/access.js';
import { hasFeature, requireFeature } from '../lib/auth.js';
import { can, requirePermission } from '../lib/permissions.js';
import { badRequest } from '../lib/errors.js';
import { queryString } from '../lib/http.js';
import { loadLocation } from '../lib/access.js';
import { addDays, addMonths, isValidDate, todayIn } from '../lib/time.js';
import type { Db } from '../db/client.js';
import { occupancy } from '../services/occupancy.js';
import { dashboard, financeReport } from '../services/reports.js';
import { staffOnly } from '../lib/auth.js';

export function reportsRouter(db: Db) {
  const r = Router();

  // Front desk sees operations; finance figures are manager-and-up only.
  r.get('/dashboard', staffOnly, async (req, res) => {
    const locationId = requireLocationId(req);
    const user = req.user!;
    res.json(await dashboard(db, locationId, can(user, 'reports') && hasFeature(user, 'invoicing')));
  });

  // How busy each space has been. Open to the whole team, like the board it is drawn on.
  r.get('/occupancy', staffOnly, async (req, res) => {
    const locationId = requireLocationId(req);
    const loc = await loadLocation(db, locationId);
    const today = todayIn(loc.timezone);
    const days = Math.min(366, Math.max(1, Number(queryString(req, 'days') ?? 30) || 30));
    const to = queryString(req, 'to') ?? today;
    if (!isValidDate(to)) throw badRequest('to must be YYYY-MM-DD');
    res.json(await occupancy(db, locationId, addDays(to, -(days - 1)), to));
  });

  r.get('/finance', requireFeature('reports'), requirePermission('reports'), async (req, res) => {
    const locationId = requireLocationId(req);
    const loc = await loadLocation(db, locationId);
    const today = todayIn(loc.timezone);
    // Default: the last 6 calendar months including this one.
    const from = queryString(req, 'from') ?? `${addMonths(today.slice(0, 7), -5)}-01`;
    const to = queryString(req, 'to') ?? today;
    if (!isValidDate(from) || !isValidDate(to)) throw badRequest('from and to must be YYYY-MM-DD');
    if (from > to) throw badRequest('from must not be after to');
    res.json(await financeReport(db, { locationId, from, to }));
  });

  return r;
}
