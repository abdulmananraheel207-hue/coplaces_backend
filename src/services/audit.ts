import type { DbLike } from '../db/client.js';
import { AUDIT_ACTIONS, auditLog } from '../db/schema.js';

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  organizationId: string | null;
  locationId: string | null;
  actorId: string;
  action: AuditAction;
  entity: string;
  entityId: string;
  amountCents?: number | null | undefined;
  /** What the record was, and what it became, for reading back. Kept as JSON. */
  data?: unknown;
}

/**
 * Writes one line to the audit log. Call it inside the same transaction as the change it describes, so a change is never made
 * without its line, and a line never describes a change that was rolled back.
 */
export async function audit(t: DbLike, e: AuditEntry) {
  await t
    .insert(auditLog)
    .values({ organizationId: e.organizationId, locationId: e.locationId, actorId: e.actorId, action: e.action, entity: e.entity, entityId: e.entityId, amountCents: e.amountCents ?? null, data: JSON.stringify(e.data ?? {}) })
    .run();
}
