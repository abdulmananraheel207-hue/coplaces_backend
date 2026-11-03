import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { organizationLogos, organizations } from '../db/schema.js';
import { ownerOnly } from '../lib/auth.js';
import { HttpError } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

/** The largest logo kept, as a data URL: about 300 KB of image. The browser shrinks it well below this before sending it. */
export const LOGO_MAX_CHARS = 400_000;
const DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * The business's own look on what it prints. Anyone signed in to the business may read the logo (members see it on their invoices);
 * only the owner may change it.
 */
export function brandingRouter(db: Db) {
  const r = Router();
  const orgOf = (req: { user?: { organizationId: string | null } }) => {
    const id = req.user?.organizationId;
    if (!id) throw new HttpError(404, 'Not found');
    return id;
  };

  r.get('/logo', async (req, res) => {
    const row = await db.select().from(organizationLogos).where(eq(organizationLogos.organizationId, orgOf(req))).get();
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.json({ dataUrl: row?.dataUrl ?? null, updatedAt: row?.updatedAt ?? null });
  });

  r.put('/logo', ownerOnly, async (req, res) => {
    const body = parse(
      z.object({
        dataUrl: z
          .string()
          .max(LOGO_MAX_CHARS, 'The logo is too large. Use a smaller image.')
          .regex(DATA_URL, 'The logo must be a PNG, JPEG or WebP image'),
      }),
      req.body,
    );
    const id = orgOf(req);
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.insert(organizationLogos).values({ organizationId: id, dataUrl: body.dataUrl, updatedAt: now }).onConflictDoUpdate({ target: organizationLogos.organizationId, set: { dataUrl: body.dataUrl, updatedAt: now } }).run();
      await tx.update(organizations).set({ logoVersion: now }).where(eq(organizations.id, id)).run();
    });
    res.json({ logoVersion: now });
  });

  r.delete('/logo', ownerOnly, async (req, res) => {
    const id = orgOf(req);
    await db.transaction(async (tx) => {
      await tx.delete(organizationLogos).where(eq(organizationLogos.organizationId, id)).run();
      await tx.update(organizations).set({ logoVersion: null }).where(eq(organizations.id, id)).run();
    });
    res.status(204).end();
  });

  return r;
}
