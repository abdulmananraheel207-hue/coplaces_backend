import { config } from '../config.js';
import { createDb } from './client.js';

// Brings the database schema up to date. Vercel runs this once per deploy (see `vercel-build`), so functions skip it on cold start.
const db = await createDb(config.databaseUrl, config.databaseAuthToken);
db.$client.close();
console.log('Database migrations are up to date.');
