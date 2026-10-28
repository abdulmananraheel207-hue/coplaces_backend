import { fileURLToPath } from 'node:url';

// Tests build their own in-memory databases and must not pick up the real credentials.
const isTest = !!process.env.VITEST;

if (!isTest) {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
  } catch (err) {
    // No .env file is fine when the host sets the variables itself.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

const isProd = process.env.NODE_ENV === 'production';

if (isProd && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}

if (!isTest) {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url || !/^(libsql|https|wss):\/\//.test(url)) {
    throw new Error('TURSO_DATABASE_URL must be set to your Turso database (libsql://…). Get it with `turso db show <name> --url`.');
  }
  if (!process.env.TURSO_AUTH_TOKEN) {
    throw new Error('TURSO_AUTH_TOKEN must be set. Create one with `turso db tokens create <name>`.');
  }
}

export const config = {
  isProd,
  port: Number(process.env.PORT ?? 4310),
  /** The Turso database. There is no local fallback: the app always runs against the cloud. */
  databaseUrl: process.env.TURSO_DATABASE_URL ?? '',
  databaseAuthToken: process.env.TURSO_AUTH_TOKEN,
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-secret-change-me',
  /** The platform operator's calendar (subscriptions, platform revenue). */
  platformTimezone: 'Asia/Karachi',
  sessionDays: 7,
  /** Production assumes HTTPS (secure cookies, HSTS). Set ALLOW_HTTP=1 to serve over plain HTTP, e.g. a LAN install or local preview. */
  secureCookies: isProd && process.env.ALLOW_HTTP !== '1',
  webDist: process.env.WEB_DIST ?? fileURLToPath(new URL('../../web/dist', import.meta.url)),
};
