import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookieParser from 'cookie-parser';
import { sql } from 'drizzle-orm';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import helmetImport, { type HelmetOptions } from 'helmet';
import { config } from './config.js';
import type { Db } from './db/client.js';
import { authenticate, ownerOnly, requireFeature } from './lib/auth.js';
import { requirePermission } from './lib/permissions.js';
import { HttpError } from './lib/errors.js';
import { assignmentsRouter, resourcesRouter } from './routes/resources.js';
import { attendanceRouter } from './routes/attendance.js';
import { authRouter } from './routes/auth.js';
import { announcementsRouter } from './routes/announcements.js';
import { bookingsRouter } from './routes/bookings.js';
import { contractsRouter } from './routes/contracts.js';
import { expensesRouter } from './routes/expenses.js';
import { floorPlanRouter } from './routes/floorplan.js';
import { invoicesRouter } from './routes/invoices.js';
import { locationsRouter } from './routes/locations.js';
import { meRouter } from './routes/me.js';
import { assetsRouter, issuesRouter, tasksRouter } from './routes/operations.js';
import { shiftsRouter } from './routes/shifts.js';
import { membersRouter } from './routes/members.js';
import { paymentsRouter } from './routes/payments.js';
import { platformRouter } from './routes/platform.js';
import { plansRouter } from './routes/plans.js';
import { reportsRouter } from './routes/reports.js';
import { staffRouter } from './routes/staff.js';
import { visitorsRouter } from './routes/visitors.js';

/**
 * The SQLite constraint behind a failed query, e.g. 'SQLITE_CONSTRAINT_UNIQUE'. Drizzle wraps the driver's error in
 * `cause`, and libsql reports the specific constraint as `extendedCode`; a remote server may only give it in the message.
 */
function sqliteCode(err: unknown): string | undefined {
  for (let e = err as { code?: unknown; extendedCode?: unknown; message?: unknown; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (typeof e.extendedCode === 'string') return e.extendedCode;
    if (typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT_')) return e.code;
    if (e.code === 'SQLITE_CONSTRAINT' && typeof e.message === 'string') {
      if (e.message.includes('UNIQUE constraint failed')) return 'SQLITE_CONSTRAINT_UNIQUE';
      if (e.message.includes('FOREIGN KEY constraint failed')) return 'SQLITE_CONSTRAINT_FOREIGNKEY';
    }
  }
  return undefined;
}

const HEALTH_TIMEOUT_MS = 5_000;

// Vercel's type check resolves every package to its CommonJS types, where helmet's default import is the module and the
// function is its `default`. Node loads helmet's ES module at run time, where the default import is the function itself.
const helmet = ((helmetImport as { default?: unknown }).default ?? helmetImport) as (options?: Readonly<HelmetOptions>) => RequestHandler;

export function createApp(db: Db, opts: { webDist?: string } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(
    helmet({
      hsts: config.secureCookies,
      contentSecurityPolicy: {
        useDefaults: true,
        // Upgrading to https would break plain-HTTP deployments.
        directives: {
          'upgrade-insecure-requests': config.secureCookies ? [] : null,
          // The floor plan import shows the uploaded picture from a blob: URL, on the page and on the 3D floor, and
          // the PDF reader runs in a worker.
          'img-src': ["'self'", 'data:', 'blob:'],
          'worker-src': ["'self'", 'blob:'],
        },
      },
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // Public, so it says whether the database answers but never why it did not; the reason goes to the server log.
  app.get('/api/health', async (_req, res) => {
    const kind = db.$client.protocol === 'file' ? 'local' : 'turso';
    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        db.run(sql`SELECT 1`),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`No answer from the database within ${HEALTH_TIMEOUT_MS} ms`)), HEALTH_TIMEOUT_MS);
        }),
      ]);
      res.json({ ok: true, database: { kind, connected: true, latencyMs: Math.round(performance.now() - started) } });
    } catch (err) {
      console.error('Health check: database unreachable', err);
      res.status(503).json({ ok: false, database: { kind, connected: false } });
    } finally {
      clearTimeout(timer);
    }
  });
  app.use('/api/auth', authRouter(db));

  const api = express.Router();
  api.use(authenticate(db));
  api.use('/locations', locationsRouter(db));
  api.use('/platform', platformRouter(db));
  api.use('/staff', requireFeature('team'), ownerOnly, staffRouter(db));
  api.use('/plans', plansRouter(db));
  api.use('/members', membersRouter(db));
  api.use('/resources', resourcesRouter(db));
  api.use('/assignments', assignmentsRouter(db));
  api.use('/floor-plan', floorPlanRouter(db));
  api.use('/bookings', bookingsRouter(db));
  api.use('/contracts', contractsRouter(db));
  api.use('/announcements', announcementsRouter(db));
  api.use('/tasks', tasksRouter(db));
  api.use('/shifts', shiftsRouter(db));
  api.use('/assets', assetsRouter(db));
  api.use('/issues', issuesRouter(db));
  api.use('/attendance', attendanceRouter(db));
  api.use('/visitors', requireFeature('visitors'), visitorsRouter(db));
  api.use('/invoices', requireFeature('invoicing'), invoicesRouter(db));
  api.use('/payments', requireFeature('invoicing'), paymentsRouter(db));
  api.use('/expenses', requireFeature('expenses'), requirePermission('expenses'), expensesRouter(db));
  api.use('/reports', reportsRouter(db));
  api.use('/me', meRouter(db));
  api.use((_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use('/api', api);

  // In production the API also serves the built web app.
  const webDist = opts.webDist ?? config.webDist;
  if (existsSync(join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(webDist, 'index.html')));
  }

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, details: err.details });
      return;
    }
    const code = sqliteCode(err);
    if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: 'That value is already in use' });
      return;
    }
    if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      res.status(400).json({ error: 'Referenced record does not exist' });
      return;
    }
    // body-parser and similar attach a 4xx status
    if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
      res.status(err.status).json({ error: err.type === 'entity.parse.failed' ? 'Malformed JSON' : err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  };
  app.use(onError);

  return app;
}
