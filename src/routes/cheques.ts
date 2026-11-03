import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { MONEY_STATUSES } from '../db/schema.js';
import { loadLocation, requireLocationId } from '../lib/access.js';
import { badRequest } from '../lib/errors.js';
import { idParam, queryString } from '../lib/http.js';
import { requirePermission } from '../lib/permissions.js';
import { isValidDate } from '../lib/time.js';
import { parse } from '../lib/validate.js';
import { bounceCheque, clearCheque, listCheques, type ChequeSource } from '../services/cheques.js';

const sourceOf = (s: unknown): ChequeSource => {
  if (s === 'payment' || s === 'entry') return s;
  throw badRequest('Unknown cheque source');
};

/**
 * Cheques that came in: on invoices, and for advances and security deposits. Pending until the bank clears them; only then do they
 * pay anything. Mounted behind the invoicing feature; taking money needs the invoices permission.
 */
export function chequesRouter(db: Db) {
  const r = Router();

  r.get('/', requirePermission('invoices'), async (req, res) => {
    const locationId = requireLocationId(req);
    await loadLocation(db, locationId);
    const status = queryString(req, 'status');
    if (status && !(MONEY_STATUSES as readonly string[]).includes(status)) throw badRequest('Unknown status');
    res.json(await listCheques(db, locationId, status as (typeof MONEY_STATUSES)[number] | undefined));
  });

  /** The bank cleared it. `clearedOn` is the day it cleared (local); today if left out. */
  r.post('/:source/:id/clear', requirePermission('invoices'), async (req, res) => {
    const body = parse(z.object({ clearedOn: z.string().refine(isValidDate, 'Use YYYY-MM-DD').optional() }), req.body ?? {});
    res.json(await clearCheque(db, req.user!, sourceOf(req.params.source), idParam(req), body.clearedOn));
  });

  r.post('/:source/:id/bounce', requirePermission('invoices'), async (req, res) => {
    const body = parse(z.object({ reason: z.string().trim().max(300).default('') }), req.body ?? {});
    res.json(await bounceCheque(db, req.user!, sourceOf(req.params.source), idParam(req), body.reason));
  });

  return r;
}
