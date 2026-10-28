import { parseArgs } from 'node:util';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { createDb } from './client.js';
import { users } from './schema.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    password: { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(message);
  console.error('\nUsage: npm run create-superadmin -- --email you@example.com --name "Your Name" --password "at least 8 chars"');
  process.exit(1);
}

if (!values.email || !values.name || !values.password) fail('--email, --name and --password are required.');
if (values.password.length < 8) fail('The password must be at least 8 characters.');

const db = await createDb(config.databaseUrl, config.databaseAuthToken);
const email = values.email.trim().toLowerCase();
if (await db.select().from(users).where(eq(users.email, email)).get()) fail(`An account for ${email} already exists.`);

await db.insert(users)
  .values({ email, name: values.name, role: 'superadmin', passwordHash: bcrypt.hashSync(values.password, 10) })
  .run();
console.log(`Created platform super admin ${email}. Sign in to add packages and register coworking spaces.`);
