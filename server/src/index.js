import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { connectDb, disconnectDb } from './db/models.js';
import { createLogger } from './log.js';
import { createSource } from './portal/index.js';
import { createConsumptionService } from './services/consumptionService.js';
import { createSyncService } from './services/syncService.js';

const config = loadConfig();
const log = createLogger(config.logLevel);

if (config.sourceMode === 'portal' && (!config.portal.username || !config.portal.password)) {
  log.error('SOURCE_MODE=portal needs PORTAL_USERNAME and PORTAL_PASSWORD (see .env.example)');
  process.exit(1);
}
if (config.sourceMode === 'fixture') {
  log.warn('SOURCE_MODE=fixture: serving SYNTHETIC demo data. The real portal is NOT being contacted.');
}

try {
  await connectDb(config.mongoUri);
} catch (err) {
  log.error('Cannot reach MongoDB', { uri: config.mongoUri.replace(/\/\/[^@]*@/, '//***@'), error: err.message, hint: 'start one with `docker compose up -d mongo` or set MONGODB_URI' });
  process.exit(1);
}

const source = createSource(config, log);
const sync = createSyncService({ source, log, config });
const consumption = createConsumptionService({ source, log, config });
const app = createApp({ config, source, sync, consumption, log });

const server = app.listen(config.port, () => log.info('listening', { url: `http://localhost:${config.port}`, docs: `http://localhost:${config.port}/docs`, source: source.name }));
sync.start();

const shutdown = (signal) => {
  log.info('shutting down', { signal });
  sync.stop();
  server.close(async () => {
    await disconnectDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
