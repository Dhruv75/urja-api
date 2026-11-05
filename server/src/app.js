import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiDocument } from './api/openapi.js';
import { errorHandler } from './api/errorHandler.js';
import { createRouter } from './api/routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ config, source, sync, consumption, log, version = '0.1.0', clientDir = path.resolve(here, '../../client/dist') }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigin.split(',').map((s) => s.trim()) }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    const t0 = process.hrtime.bigint();
    res.on('finish', () => log.info('request', { method: req.method, path: req.path, status: res.statusCode, ms: Number((process.hrtime.bigint() - t0) / 1_000_000n) }));
    next();
  });

  const spec = buildOpenApiDocument();
  app.get('/openapi.json', (req, res) => res.json(spec));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'Urja Meter Ops API' }));

  app.use('/api/v1', createRouter({ config, source, sync, consumption, version }));
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: `No such endpoint: ${req.method} ${req.originalUrl}` } }));

  // If the React client has been built (npm run build), serve it from the same origin: one process, no CORS.
  if (fs.existsSync(path.join(clientDir, 'index.html'))) {
    app.use(express.static(clientDir));
    app.use((req, res, next) => (req.method === 'GET' && !req.path.includes('.') ? res.sendFile(path.join(clientDir, 'index.html')) : next()));
  }

  app.use(errorHandler(log));
  return app;
}
