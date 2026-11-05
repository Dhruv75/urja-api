import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import SwaggerParser from '@apidevtools/swagger-parser';
import { buildOpenApiDocument } from '../src/api/openapi.js';
import { createRouter } from '../src/api/routes.js';
import { loadConfig } from '../src/config.js';

const generated = () => JSON.parse(JSON.stringify(buildOpenApiDocument()));
const committed = () => JSON.parse(fs.readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8'));

test('openapi.json is committed, up to date with the code, and a valid OpenAPI 3.1 document', async () => {
  assert.deepEqual(committed(), generated(), 'openapi.json is stale: run `npm run openapi` and commit the result');
  await SwaggerParser.validate(structuredClone(committed())); // throws with details if the document is invalid
  assert.match(committed().openapi, /^3\.1\./);
});

test('every route Express registers is documented, and every documented route exists', () => {
  const router = createRouter({ config: loadConfig({}), source: { name: 'fixture', state: () => ({}), ping: async () => ({}) }, sync: {}, consumption: {}, version: 'test' });
  const registered = router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} /api/v1${layer.route.path.replace(/:(\w+)/g, '{$1}')}`))
    .sort();
  const documented = Object.entries(generated().paths)
    .flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`))
    .sort();
  assert.ok(registered.length >= 9);
  assert.deepEqual(registered, documented);
});

test('every operation is described: summary, tag, a 2xx response, and documented error responses', () => {
  for (const [path, ops] of Object.entries(generated().paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const where = `${method.toUpperCase()} ${path}`;
      assert.ok(op.summary, `${where}: summary`);
      assert.ok(op.tags?.length, `${where}: tag`);
      assert.ok(Object.keys(op.responses).some((c) => c.startsWith('2')), `${where}: success response`);
      if (/\{/.test(path)) assert.ok(op.responses['404'] || path.includes('consumption'), `${where}: 404 documented`);
    }
  }
});
