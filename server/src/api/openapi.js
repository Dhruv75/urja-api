import { z } from 'zod';
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import * as S from './schemas.js';

const registry = new OpenAPIRegistry();
const ok = (schema, description) => ({ description, content: { 'application/json': { schema } } });
const err = (description) => ok(S.ErrorBody, description);
const E400 = err('Invalid parameters (`validation_error`, `range_too_large`, ...)');
const E404 = err('Unknown meter / node (`not_found`)');
const E503 = err('The local index has not been built yet (`index_not_ready`); retry after the `Retry-After` header');
const E502 = err('The legacy portal failed, rejected our login, or is not mapped yet (`portal_unavailable`, `portal_auth_failed`, `portal_not_mapped`)');
const id = (name, example) => z.object({ [name]: z.string().openapi({ example }) });

const route = (def) => registry.registerPath(def);

route({
  method: 'get', path: '/api/v1/health', tags: ['Operations'], summary: 'Service, index and portal-session health',
  description: 'Cheap by default (database + in-memory session state only). Add `?deep=true` to also exercise the portal login.',
  request: { query: S.HealthQuery }, responses: { 200: ok(S.HealthResponse, 'Health report') },
});
route({
  method: 'post', path: '/api/v1/sync', tags: ['Operations'], summary: 'Rebuild the local index from the portal',
  description: 'Re-reads ALL meters and the hierarchy from the portal (read-only towards the portal) and swaps them into MongoDB. Concurrent calls share one run.',
  request: { query: S.SyncQuery },
  responses: { 200: ok(S.SyncResponse, 'Finished (`wait=true`)'), 202: ok(S.SyncResponse, 'Started or already running'), 502: E502 },
});
route({
  method: 'get', path: '/api/v1/meters', tags: ['Meters'], summary: 'List and filter meters',
  description: 'Served from the local index. Besides the documented parameters, any `attr.<name>=<value>` query parameter filters on a portal attribute (repeat it for OR), e.g. `?attr.tariffCategory=commercial&attr.sanctionedLoadKw=10`.',
  request: { query: S.MeterQuery }, responses: { 200: ok(S.MeterList, 'A page of meters'), 400: E400, 503: E503 },
});
route({
  method: 'get', path: '/api/v1/meters/nearby', tags: ['Meters'], summary: 'Meters near a location',
  description: 'Great-circle distance, nearest first. Meters without valid coordinates are never returned. The search box does not wrap the antimeridian.',
  request: { query: S.NearbyQuery }, responses: { 200: ok(S.NearbyResponse, 'Nearest meters'), 400: E400, 503: E503 },
});
route({
  method: 'get', path: '/api/v1/meters/{meterId}', tags: ['Meters'], summary: 'One meter, with its position in the network',
  request: { params: id('meterId', 'MTR-000001') }, responses: { 200: ok(S.MeterDetailResponse, 'The meter'), 404: E404, 503: E503 },
});
route({
  method: 'get', path: '/api/v1/meters/{meterId}/consumption', tags: ['Meters'], summary: 'Consumption time series',
  description: 'Interval energy, read through a cache. `meta.servedFrom` says whether the answer was fetched live from the source or came from the cache, `meta.ageSeconds` how old it is, and `meta.stale` whether it is out of date because the source failed. Windows touching "now" are trusted for 5 min, closed past windows for 24 h (configurable); `refresh=true` always asks the portal.',
  request: { params: id('meterId', 'MTR-000001'), query: S.ConsumptionQuery },
  responses: { 200: ok(S.ConsumptionResponse, 'Time series'), 400: E400, 404: E404, 502: E502 },
});
route({
  method: 'get', path: '/api/v1/hierarchy', tags: ['Network'], summary: 'The network hierarchy as a tree',
  description: 'Rebuilt from the portal\'s parent references. Inconsistent data (orphans, cycles, duplicates) is repaired deterministically and reported; see `/data-quality`. Orphans and cycle-breakers appear as extra roots.',
  request: { query: S.HierarchyQuery }, responses: { 200: ok(S.HierarchyResponse, 'Tree'), 400: E400, 503: E503 },
});
route({
  method: 'get', path: '/api/v1/hierarchy/{nodeId}', tags: ['Network'], summary: 'One hierarchy node with ancestors and children',
  request: { params: id('nodeId', 'FD-11') }, responses: { 200: ok(S.NodeDetailResponse, 'The node'), 404: E404, 503: E503 },
});
route({
  method: 'get', path: '/api/v1/data-quality', tags: ['Network'], summary: 'Inconsistencies found in the portal data',
  request: { query: S.DataQualityQuery }, responses: { 200: ok(S.DataQualityResponse, 'Issues'), 400: E400, 503: E503 },
});

let cached;
export function buildOpenApiDocument() {
  cached ??= new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Urja Meter Ops API',
      version: '0.1.0',
      description: 'A clean, read-only REST API in front of the legacy Urja Meter Ops portal. Data is served from a local MongoDB index that is rebuilt from the portal; consumption is read through a cache. When `meta.source` is `fixture` the data is synthetic demo data.',
    },
    servers: [{ url: 'http://localhost:3000', description: 'Local' }],
    tags: [{ name: 'Meters' }, { name: 'Network' }, { name: 'Operations' }],
  });
  return cached;
}
