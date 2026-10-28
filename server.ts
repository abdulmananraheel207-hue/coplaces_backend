// Vercel's entry point: it serves the default-exported Express app as one function. `npm run dev` and `npm start` use src/index.ts.
import type { Express } from 'express';
import { createApp } from './src/app.js';
import { config } from './src/config.js';
import { createDb } from './src/db/client.js';

// The deploy's build step already ran the migrations (`npm run vercel-build`).
const db = await createDb(config.databaseUrl, config.databaseAuthToken, { migrate: false });
const app: Express = createApp(db);

export default app;
