import { createApp } from './app.js';
import { config } from './config.js';
import { createDb } from './db/client.js';

const db = await createDb(config.databaseUrl, config.databaseAuthToken);
const app = createApp(db);

app.listen(config.port, () => {
  console.log(`Coplaces API listening on http://localhost:${config.port}`);
  if (!config.isProd && config.jwtSecret === 'dev-only-secret-change-me') {
    console.log('Using the development JWT secret. Set JWT_SECRET before deploying.');
  }
});
