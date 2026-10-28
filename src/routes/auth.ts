import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { locations, users } from '../db/schema.js';
import {
  authenticate,
  loadAuthUser,
  resolveAuth,
  SESSION_COOKIE,
  sessionCookieOptions,
  signSession,
} from '../lib/auth.js';
import { HttpError, unauthorized } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

// Used to equalise timing when the email is unknown.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60_000;
const failures = new Map<string, { count: number; first: number }>();

function throttle(key: string) {
  const f = failures.get(key);
  if (f && Date.now() - f.first > WINDOW_MS) failures.delete(key);
  if ((failures.get(key)?.count ?? 0) >= MAX_FAILURES) {
    throw new HttpError(429, 'Too many failed sign-in attempts. Try again in a few minutes.');
  }
}
function recordFailure(key: string) {
  const f = failures.get(key);
  if (!f) failures.set(key, { count: 1, first: Date.now() });
  else f.count++;
}

export const passwordSchema = z.string().min(8, 'Password must be at least 8 characters').max(200);

export function authRouter(db: Db) {
  const r = Router();
  const needAuth = authenticate(db);

  const sessionPayload = async (userId: string) => {
    const user = (await loadAuthUser(db, userId))!;
    const locs = user.locationIds.length
      ? await db.select().from(locations).where(inArray(locations.id, user.locationIds)).orderBy(asc(locations.name)).all()
      : [];
    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role, permissions: user.permissions, memberId: user.memberId },
      org: user.org,
      locations: locs,
    };
  };

  r.post('/login', async (req, res) => {
    const body = parse(z.object({ email: z.string().trim().toLowerCase(), password: z.string().min(1) }), req.body);
    const key = `${req.ip}|${body.email}`;
    throttle(key);

    const row = await db.select().from(users).where(eq(users.email, body.email)).get();
    const ok = await bcrypt.compare(body.password, row?.passwordHash ?? DUMMY_HASH);
    if (!row || !ok || !row.active) {
      recordFailure(key);
      throw unauthorized('Incorrect email or password');
    }
    failures.delete(key);
    await db.update(users).set({ lastLoginAt: new Date().toISOString() }).where(eq(users.id, row.id)).run();

    const access = await resolveAuth(db, row.id);
    if ('blocked' in access) throw new HttpError(403, access.blocked);
    res.cookie(SESSION_COOKIE, signSession(row.id), sessionCookieOptions());
    res.json(await sessionPayload(row.id));
  });

  r.post('/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  r.get('/me', needAuth, async (req, res) => {
    res.json(await sessionPayload(req.user!.id));
  });

  r.post('/change-password', needAuth, async (req, res) => {
    const body = parse(z.object({ currentPassword: z.string(), newPassword: passwordSchema }), req.body);
    const row = (await db.select().from(users).where(eq(users.id, req.user!.id)).get())!;
    if (!(await bcrypt.compare(body.currentPassword, row.passwordHash))) {
      throw new HttpError(400, 'Current password is incorrect');
    }
    await db.update(users)
      .set({ passwordHash: await bcrypt.hash(body.newPassword, 10) })
      .where(eq(users.id, row.id))
      .run();
    res.status(204).end();
  });

  return r;
}
