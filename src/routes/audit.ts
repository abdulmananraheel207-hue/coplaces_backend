import { Router } from 'express';
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { AUDIT_ACTIONS, auditLog, users } from '../db/schema.js';
import { loadLocation, requireLocationId } from '../lib/access.js';
import { badRequest } from '../lib/errors.js';
import { queryString } from '../lib/http.js';
import { requirePermission } from '../lib/permissions.js';
import { addDays, isValidDate, zonedToUtc } from '../lib/time.js';

/** The audit log of money changes for a location, newest first. Read only: nothing can change or remove a line. */
export function auditRouter(db: Db) {
  const r = Router();

  r.get('/', requirePermission('billing_admin', 'reports'), async (req, res) => {
    const locationId = requireLocationId(req);
    const loc = await loadLocation(db, locationId);
    const conds = [eq(auditLog.locationId, locationId)];
    const action = queryString(req, 'action');
    if (action) {
      if (!(AUDIT_ACTIONS as readonly string[]).includes(action)) throw badRequest('Unknown action');
      conds.push(eq(auditLog.action, action as (typeof AUDIT_ACTIONS)[number]));
    }
    const entity = queryString(req, 'entity');
    if (entity) conds.push(eq(auditLog.entity, entity));
    const entityId = queryString(req, 'entityId');
    if (entityId) conds.push(eq(auditLog.entityId, entityId));
    const from = queryString(req, 'from');
    const to = queryString(req, 'to');
    if ((from && !isValidDate(from)) || (to && !isValidDate(to))) throw badRequest('from and to must be YYYY-MM-DD');
    if (from) conds.push(gte(auditLog.createdAt, zonedToUtc(from, '00:00', loc.timezone).toISOString()));
    if (to) conds.push(lt(auditLog.createdAt, zonedToUtc(addDays(to, 1), '00:00', loc.timezone).toISOString()));
    const rows = await db
      .select({ a: auditLog, actorName: users.name })
      .from(auditLog)
      .innerJoin(users, eq(users.id, auditLog.actorId))
      .where(and(...conds))
      .orderBy(desc(auditLog.createdAt))
      .limit(Math.min(Number(queryString(req, 'limit')) || 200, 1000))
      .all();
    res.json(rows.map(({ a, actorName }) => ({ ...a, data: JSON.parse(a.data) as unknown, actorName })));
  });

  return r;
}
