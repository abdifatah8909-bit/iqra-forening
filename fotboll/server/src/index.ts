import { buildApp } from './app.js';
import { config } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';

const db = createPool(config.databaseUrl);
await migrate(db);
const app = await buildApp({ db, mediaDir: config.mediaDir, webDist: config.webDist, logger: true });
await app.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}
