// Regenerates ../../openapi.json from the Zod schemas. Run: npm run openapi
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '../src/api/openapi.js';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../openapi.json');
fs.writeFileSync(out, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`wrote ${out}`);
