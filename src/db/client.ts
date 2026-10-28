import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as schema from './schema.js';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Opens the database and brings its schema up to date. `url` is a Turso database (`libsql://…`, with `authToken`),
 * a local file (`file:path/to.db`) or `:memory:`. Pass `migrate: false` where migrations already ran, e.g. a serverless
 * function whose deploy migrated the database at build time.
 */
export async function createDb(url: string, authToken?: string, opts: { migrate?: boolean } = {}) {
  if (url.startsWith('file:')) mkdirSync(dirname(fileURLToPath(new URL(url, `file:///${process.cwd()}/`))), { recursive: true });
  const client = createClient({ url, authToken });
  // libsql enforces foreign keys on every connection, local or remote, so there is no pragma to set.
  const hasTable = async (name: string) =>
    (await client.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", args: [name] })).rows.length > 0;
  let migrated: boolean;
  try {
    migrated = await hasTable('__drizzle_migrations');
  } catch (err) {
    // The first query is where a bad URL or token shows up; say which, rather than leave a bare HTTP status.
    const status = (err as { cause?: { status?: number } }).cause?.status;
    if (status === 401 || status === 403) {
      throw new Error(
        `Turso refused the auth token for ${url} (HTTP ${status}). TURSO_AUTH_TOKEN must be a token for this database, ` +
          'made with `turso db tokens create <name>` or "Create Token" on the database page. A Platform API token will not work.',
        { cause: err },
      );
    }
    if (status === 404) throw new Error(`No Turso database at ${url}. Check TURSO_DATABASE_URL with \`turso db show <name> --url\`.`, { cause: err });
    throw err;
  }
  if (migrated && !(await hasTable('organizations'))) {
    throw new Error(
      `${url} was created by an earlier version of Coplaces that had no multi-tenant support. ` +
        'For demo data run `npm run seed -- --reset`; otherwise delete it to start fresh.',
    );
  }
  const db = drizzle(client, { schema });
  if (opts.migrate !== false) await migrate(db, { migrationsFolder });
  return db;
}

/** Drops every table, migrations record included, so the next `createDb` starts from an empty schema. */
export async function dropAllTables(url: string, authToken?: string) {
  const client = createClient({ url, authToken });
  try {
    const { rows } = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    // migrate() switches foreign keys off around the batch, so the drop order does not matter.
    await client.migrate(rows.map((r) => `DROP TABLE IF EXISTS "${String(r.name).replaceAll('"', '""')}"`));
  } finally {
    client.close();
  }
}

export type Db = Awaited<ReturnType<typeof createDb>>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Either the root database or an open transaction. */
export type DbLike = Db | Tx;
