import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connectDb, disconnectDb, Meter, Reading } from '../src/db/models.js';
import { haversineM } from '../src/domain/geo.js';
import { PortalUnavailableError } from '../src/errors.js';
import { createLogger } from '../src/log.js';
import { FixtureSource } from '../src/portal/fixture.js';
import { UrjaPortalSource } from '../src/portal/urja.js';
import { createConsumptionService } from '../src/services/consumptionService.js';
import { createSyncService } from '../src/services/syncService.js';
import { buildOpenApiDocument } from '../src/api/openapi.js';
import { parseInstant } from '../src/api/routes.js';
import * as S from '../src/api/schemas.js';

// ---- setup: a real MongoDB-compatible database, or skip with a clear reason --------------------------------------
const MONGO = process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017';
let skip = false;
try {
  await connectDb(MONGO, { dbName: `urja_test_${process.pid}` });
  await Meter.db.dropDatabase();
  await connectDb(MONGO, { dbName: `urja_test_${process.pid}` }); // recreate indexes after the drop
} catch {
  skip = 'MongoDB is not reachable (set MONGODB_URI_TEST, or run `docker compose up -d mongo`)';
}

class FlakySource extends FixtureSource {
  fail = false;
  async getConsumption(...args) {
    if (this.fail) throw new PortalUnavailableError('portal is down');
    return super.getConsumption(...args);
  }
}

const log = createLogger('silent');
const config = loadConfig({ SYNC_ON_START: 'false', LOG_LEVEL: 'silent' });
const source = new FlakySource();
const wire = (src) => {
  const sync = createSyncService({ source: src, log, config });
  const consumption = createConsumptionService({ source: src, log, config });
  return { sync, app: createApp({ config, source: src, sync, consumption, log, clientDir: '/nonexistent' }) };
};
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });

const main = skip ? null : wire(source);
const server = skip ? null : await listen(main.app);
const base = skip ? '' : `http://127.0.0.1:${server.address().port}`;
after(async () => {
  server?.close();
  if (!skip) {
    await Meter.db.dropDatabase();
    await disconnectDb();
  }
});

const api = async (path, init) => {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, headers: res.headers, body };
};
const get = (path) => api(path);
/** Parses with the same Zod schema that generated openapi.json, and checks no undocumented top-level keys appear. */
const contract = (schema, body) => {
  assert.deepEqual(Object.keys(body).sort(), Object.keys(schema.shape).sort(), 'top-level keys differ from the documented schema');
  return schema.parse(body);
};
const t = (name, fn) => test(name, { skip }, fn);

// ---- tests (order matters: they share one database) ----------------------------------------------------------------
t('before any sync, index-backed endpoints answer 503 index_not_ready with Retry-After', async () => {
  const r = await get('/api/v1/meters');
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'index_not_ready');
  assert.equal(r.headers.get('retry-after'), '5');
  assert.equal((await get('/api/v1/hierarchy')).status, 503);
});

t('an unmapped portal adapter fails loudly and honestly (501 on sync, reason visible on the next read)', async () => {
  const unmapped = wire(new UrjaPortalSource({ ensureLoggedIn: async () => {}, state: () => ({}) }));
  const srv = await listen(unmapped.app);
  try {
    const b = `http://127.0.0.1:${srv.address().port}`;
    const sync = await fetch(`${b}/api/v1/sync?wait=true`, { method: 'POST' });
    assert.equal(sync.status, 501);
    assert.equal((await sync.json()).error.code, 'portal_not_mapped');
    const meters = await (await fetch(`${b}/api/v1/meters`)).json();
    assert.equal(meters.error.code, 'index_not_ready');
    assert.match(meters.error.message, /first index build failed.*not mapped/i);
  } finally {
    srv.close();
  }
});

t('POST /sync?wait=true builds the index; concurrent syncs share one run', async () => {
  const [a, b] = await Promise.all([api('/api/v1/sync?wait=true', { method: 'POST' }), api('/api/v1/sync?wait=true', { method: 'POST' })]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const sync = contract(S.SyncResponse, a.body).data;
  assert.equal(sync.status, 'ok');
  assert.equal(sync.counts.meters, 172);
  assert.equal(sync.counts.nodes, 30);
  const accepted = await api('/api/v1/sync', { method: 'POST' });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.data.status, 'running');
  await api('/api/v1/sync?wait=true', { method: 'POST' }); // let the background one finish before the next test
});

t('GET /meters: contract, pagination, sorting, envelope meta', async () => {
  const r = await get('/api/v1/meters');
  assert.equal(r.status, 200);
  const body = contract(S.MeterList, r.body);
  assert.equal(body.data.length, 50);
  assert.deepEqual(body.page, { limit: 50, offset: 0, total: 172 });
  assert.deepEqual([body.meta.source, body.meta.stale], ['fixture', false]);
  assert.ok(body.meta.syncedAt);
  const tail = (await get('/api/v1/meters?offset=170&limit=10')).body;
  assert.equal(tail.data.length, 2);
  const byName = (await get('/api/v1/meters?sort=name&limit=200')).body.data.map((m) => m.name);
  assert.deepEqual(byName, [...byName].sort((x, y) => (x ?? '').localeCompare(y ?? '')));
});

t('GET /meters: filters (status, type, text, hasLocation, attr.*) are correct and combinable', async () => {
  const all = (await get('/api/v1/meters?limit=200')).body.data;
  assert.equal(all.length, 172);
  const norm = await get('/api/v1/meters?status=ACTIVE,fault&limit=200'); // case-insensitive csv
  assert.ok(norm.body.data.every((m) => ['active', 'fault'].includes(m.status)));
  assert.equal(norm.body.page.total, all.filter((m) => ['active', 'fault'].includes(m.status)).length);
  const three = (await get('/api/v1/meters?type=three-phase&limit=200')).body;
  assert.equal(three.page.total, all.filter((m) => m.type === 'three-phase').length);
  const q = (await get('/api/v1/meters?q=mtr-00001')).body;
  assert.ok(q.data.length > 0 && q.data.every((m) => `${m.id} ${m.name} ${m.serialNumber}`.toLowerCase().includes('mtr-00001')));
  const noLoc = (await get('/api/v1/meters?hasLocation=false&limit=200')).body;
  assert.equal(noLoc.page.total, all.filter((m) => m.location === null).length);
  assert.equal(noLoc.page.total, 4, 'the fixture has 2 missing and 2 invalid coordinates');
  const commercial = (await get('/api/v1/meters?attr.tariffCategory=commercial&limit=200')).body;
  assert.equal(commercial.page.total, all.filter((m) => m.attributes.tariffCategory === 'commercial').length);
  const load5 = (await get('/api/v1/meters?attr.sanctionedLoadKw=5&limit=200')).body; // numeric in the data, text in the query
  assert.equal(load5.page.total, all.filter((m) => m.attributes.sanctionedLoadKw === 5).length);
  const either = (await get('/api/v1/meters?attr.sanctionedLoadKw=5&attr.sanctionedLoadKw=10&limit=200')).body;
  assert.equal(either.page.total, all.filter((m) => [5, 10].includes(m.attributes.sanctionedLoadKw)).length);
  const combined = (await get('/api/v1/meters?status=active&attr.tariffCategory=commercial&type=single-phase&limit=200')).body;
  assert.equal(combined.page.total, all.filter((m) => m.status === 'active' && m.attributes.tariffCategory === 'commercial' && m.type === 'single-phase').length);
});

t('GET /meters: hostile or malformed input is rejected or neutralised, never executed', async () => {
  const op = await get('/api/v1/meters?attr.tariffCategory[$ne]=x');
  assert.equal(op.status, 400);
  assert.equal(op.body.error.code, 'invalid_attribute_filter');
  assert.equal((await get('/api/v1/meters?attr.$where=1')).body.error.code, 'invalid_attribute_filter');
  for (const q of ['.*', '(', '[a-', '\\']) {
    const r = await get(`/api/v1/meters?q=${encodeURIComponent(q)}`); // regex metacharacters are escaped, not interpreted
    assert.equal(r.status, 200, `q=${q}`);
    assert.equal(r.body.data.length, 0);
  }
  for (const bad of ['limit=0', 'limit=201', 'offset=-1', 'sort=password', 'hasLocation=maybe', 'unknown=1']) {
    const r = await get(`/api/v1/meters?${bad}`);
    assert.equal(r.status, 400, bad);
    assert.equal(r.body.error.code, 'validation_error');
    assert.ok(Array.isArray(r.body.error.details));
  }
});

t('GET /meters/:id: contract, network position, 404', async () => {
  const r = await get('/api/v1/meters/MTR-000001');
  assert.equal(r.status, 200);
  const { data } = contract(S.MeterDetailResponse, r.body);
  assert.equal(data.id, 'MTR-000001');
  assert.deepEqual(data.hierarchyPath.map((n) => n.level), ['substation', 'feeder', 'transformer']);
  assert.equal(data.hierarchyPath.at(-1).id, data.nodeId);
  const missing = await get('/api/v1/meters/NOPE');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'not_found');
});

t('GET /meters/nearby matches a brute-force haversine scan, nearest first', async () => {
  const all = (await get('/api/v1/meters?limit=200&hasLocation=true')).body.data;
  const origin = all.find((m) => m.id === 'MTR-000001').location;
  for (const radiusM of [150, 1500, 8000]) {
    const r = await get(`/api/v1/meters/nearby?lat=${origin.lat}&lon=${origin.lon}&radiusM=${radiusM}&limit=100`);
    const body = contract(S.NearbyResponse, r.body);
    const expected = all.filter((m) => haversineM(origin.lat, origin.lon, m.location.lat, m.location.lon) <= radiusM).map((m) => m.id).sort();
    assert.deepEqual(body.data.map((m) => m.id).sort(), expected, `radius ${radiusM}`);
    assert.deepEqual(body.data.map((m) => m.distanceM), body.data.map((m) => m.distanceM).sort((a, b) => a - b));
    assert.ok(body.data.every((m) => m.distanceM <= radiusM));
  }
  const first = (await get(`/api/v1/meters/nearby?lat=${origin.lat}&lon=${origin.lon}&radiusM=100&limit=1`)).body.data[0];
  assert.equal(first.id, 'MTR-000001');
  assert.equal(first.distanceM, 0);
  for (const bad of ['lat=18.5', 'lat=&lon=73.8', 'lat=91&lon=0', 'lat=18&lon=73&radiusM=0', 'lat=18&lon=73&radiusM=999999']) {
    assert.equal((await get(`/api/v1/meters/nearby?${bad}`)).status, 400, bad);
  }
});

t('GET /hierarchy: messy data is repaired and every meter is accounted for exactly once', async () => {
  const r = await get('/api/v1/hierarchy');
  const { data, meta } = contract(S.HierarchyResponse, r.body);
  assert.equal(meta.source, 'fixture');
  const rootIds = data.roots.map((n) => n.id).sort();
  assert.deepEqual(rootIds, ['FD-CYC-A', 'SS-1', 'SS-2', 'TR-ORPHAN', 'TR-SELF']);
  assert.equal(data.unplacedMeters, 2);
  const total = data.roots.reduce((sum, n) => sum + n.meterCount, 0) + data.unplacedMeters;
  assert.equal(total, 172, 'placed + unplaced must equal all meters');
  const cyc = data.roots.find((n) => n.id === 'FD-CYC-A');
  assert.deepEqual(cyc.children.map((c) => c.id), ['FD-CYC-B']);
  const feeder11 = data.roots.find((n) => n.id === 'SS-1').children.find((n) => n.id === 'FD-11');
  assert.ok(feeder11, 'the first FD-11 (parent SS-1) wins over the conflicting duplicate under SS-2');
  assert.equal(data.roots.find((n) => n.id === 'SS-2').children.some((n) => n.id === 'FD-11'), false);

  const shallow = (await get('/api/v1/hierarchy?depth=0')).body.data.roots;
  assert.ok(shallow.every((n) => n.children.length === 0));
  assert.equal(shallow.find((n) => n.id === 'SS-1').childCount, 3);
  assert.equal((await get('/api/v1/hierarchy?depth=-1')).status, 400);
});

t('GET /hierarchy/:id and the nodeId filter agree with the tree', async () => {
  const node = contract(S.NodeDetailResponse, (await get('/api/v1/hierarchy/FD-11')).body).data;
  assert.deepEqual(node.ancestors.map((a) => a.id), ['SS-1']);
  assert.equal(node.children.length, 3);
  assert.equal(node.meterCount, node.children.reduce((s, c) => s + c.meterCount, 0) + node.directMeterCount);
  const under = (await get('/api/v1/meters?nodeId=FD-11&limit=200')).body;
  assert.equal(under.page.total, node.meterCount, 'meters under a node, at any depth, match its subtree count');
  assert.equal((await get('/api/v1/hierarchy/NOPE')).status, 404);
});

t('sloppy parent references are resolved ("tr-111" -> TR-111) and reported', async () => {
  const dq = (await get('/api/v1/data-quality?code=reference_mismatch')).body.data;
  assert.equal(dq.length, 1);
  const m = (await get(`/api/v1/meters/${dq[0].refId}`)).body.data;
  assert.equal(m.nodeId, 'TR-111');
  assert.equal(m.status, 'active', 'statuses are trimmed and lower-cased');
});

t('GET /data-quality: summary, filters, contract', async () => {
  const r = await get('/api/v1/data-quality');
  const body = contract(S.DataQualityResponse, r.body);
  for (const code of ['cycle', 'orphan_node', 'self_parent', 'duplicate_node_conflict', 'duplicate_meter', 'invalid_location', 'no_location', 'meter_no_parent', 'meter_unknown_parent', 'reference_mismatch']) {
    assert.ok(body.summary[code] >= 1, `expected at least one ${code}`);
  }
  assert.equal(body.page.total, Object.values(body.summary).reduce((a, b) => a + b, 0));
  const cyc = (await get('/api/v1/data-quality?code=cycle')).body;
  assert.equal(cyc.page.total, 1);
  assert.equal(cyc.data[0].kind, 'node');
  assert.equal((await get('/api/v1/data-quality?kind=bogus')).status, 400);
});

t('consumption: read-through cache, interval aggregation, forced refresh, wider range', async () => {
  const url = (qs = '') => `/api/v1/meters/MTR-000001/consumption${qs}`;
  const first = await get(url('?interval=hour'));
  assert.equal(first.status, 200);
  const a = contract(S.ConsumptionResponse, first.body);
  assert.deepEqual([a.meta.source, a.meta.servedFrom, a.meta.cacheDecision], ['fixture', 'live', 'not_cached']);
  assert.ok(a.data.points.length >= 160 && a.data.points.length <= 170, `got ${a.data.points.length}`);
  assert.equal(a.data.unit, 'kWh');
  assert.equal(source.calls.consumption, 1);

  const second = contract(S.ConsumptionResponse, (await get(url('?interval=hour'))).body);
  assert.deepEqual([second.meta.servedFrom, second.meta.cacheDecision], ['cache', 'fresh']);
  assert.equal(source.calls.consumption, 1, 'a fresh cache must not touch the portal');

  const daily = contract(S.ConsumptionResponse, (await get(url('?interval=day'))).body);
  assert.equal(source.calls.consumption, 1);
  assert.ok(daily.data.points.length >= 7 && daily.data.points.length <= 9);
  assert.ok(Math.abs(daily.data.summary.total - a.data.summary.total) < 0.01, 'hourly and daily totals agree');
  assert.equal(daily.data.summary.points, daily.data.points.length);

  const forced = contract(S.ConsumptionResponse, (await get(url('?refresh=true'))).body);
  assert.deepEqual([forced.meta.servedFrom, forced.meta.cacheDecision], ['live', 'forced']);
  assert.equal(source.calls.consumption, 2);

  const wide = contract(S.ConsumptionResponse, (await get(url(`?from=${new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)}`))).body);
  assert.deepEqual([wide.meta.servedFrom, wide.meta.cacheDecision], ['live', 'range_not_covered']);
  assert.ok(wide.data.points.length > a.data.points.length);
  const narrowAgain = contract(S.ConsumptionResponse, (await get(url('?interval=hour'))).body);
  assert.equal(narrowAgain.meta.servedFrom, 'cache', 'a narrower window inside the cached coverage is served from cache');

  const raw = (await get(url('?interval=raw&from=2026-10-01&to=2026-10-02'))).body;
  assert.equal(raw.data.points.length, 24);
  assert.ok(raw.data.points.every((p) => p.samples === 1));
});

t('consumption: parameter validation and unknown meters', async () => {
  const u = '/api/v1/meters/MTR-000001/consumption';
  const cases = [
    ['?from=2026-10-05&to=2026-10-01', 'validation_error'],
    ['?from=2024-01-01&to=2026-10-01', 'range_too_large'],
    ['?from=yesterday', 'validation_error'],
    ['?from=2026-02-30', 'validation_error'],
    ['?interval=minute', 'validation_error'],
    ['?foo=bar', 'validation_error'],
  ];
  for (const [qs, code] of cases) {
    const r = await get(`${u}${qs}`);
    assert.equal(r.status, 400, qs);
    assert.equal(r.body.error.code, code, qs);
  }
  assert.equal((await get('/api/v1/meters/NOPE/consumption')).status, 404);
});

t('consumption: stale-if-error serves old data flagged stale; with nothing cached it is a 502', async () => {
  source.fail = true;
  try {
    const stale = contract(S.ConsumptionResponse, (await get('/api/v1/meters/MTR-000001/consumption?refresh=true')).body);
    assert.equal(stale.meta.stale, true);
    assert.equal(stale.meta.servedFrom, 'cache');
    assert.match(stale.meta.warning, /portal is down/);
    assert.ok(stale.data.points.length > 0);
    const none = await get('/api/v1/meters/MTR-000002/consumption');
    assert.equal(none.status, 502);
    assert.equal(none.body.error.code, 'portal_unavailable');
  } finally {
    source.fail = false;
  }
});

t('re-syncing prunes meters the portal no longer has, together with their cached readings', async () => {
  await get('/api/v1/meters/MTR-000010/consumption');
  assert.ok((await Reading.countDocuments({ meterId: 'MTR-000010' })) > 0);
  source.data.meters = source.data.meters.filter((m) => m.id !== 'MTR-000010');
  const r = await api('/api/v1/sync?wait=true', { method: 'POST' });
  assert.equal(r.body.data.counts.meters, 171);
  assert.equal(r.body.data.counts.removedMeters, 1);
  assert.equal((await get('/api/v1/meters/MTR-000010')).status, 404);
  assert.equal(await Reading.countDocuments({ meterId: 'MTR-000010' }), 0);
  assert.equal((await get('/api/v1/meters?limit=1')).body.page.total, 171);
});

t('health, docs, openapi.json and unknown routes', async () => {
  const h = contract(S.HealthResponse, (await get('/api/v1/health')).body);
  assert.deepEqual([h.status, h.source.mode, h.source.ok, h.index.sync.status], ['ok', 'fixture', null, 'ok']);
  const deep = contract(S.HealthResponse, (await get('/api/v1/health?deep=true')).body);
  assert.equal(deep.source.ok, true);
  const spec = await get('/openapi.json');
  assert.deepEqual(spec.body, JSON.parse(JSON.stringify(buildOpenApiDocument())));
  const docs = await fetch(`${base}/docs/`);
  assert.equal(docs.status, 200);
  assert.match(await docs.text(), /swagger/i);
  const nope = await get('/api/v1/nope');
  assert.deepEqual([nope.status, nope.body.error.code], [404, 'not_found']);
  const post = await api('/api/v1/meters', { method: 'POST' });
  assert.equal(post.status, 404, 'the API exposes no write endpoints besides POST /sync');
});

test('parseInstant accepts ISO dates/datetimes (no offset = UTC) and rejects the rest', () => {
  assert.equal(parseInstant('2026-10-01', 'x').toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(parseInstant('2026-10-01T06:30', 'x').toISOString(), '2026-10-01T06:30:00.000Z');
  assert.equal(parseInstant('2026-10-01 06:30:15', 'x').toISOString(), '2026-10-01T06:30:15.000Z');
  assert.equal(parseInstant('2026-10-01T06:30:00+05:30', 'x').toISOString(), '2026-10-01T01:00:00.000Z');
  assert.equal(parseInstant('2026-10-01T06:30:00-0530', 'x').toISOString(), '2026-10-01T12:00:00.000Z');
  for (const bad of ['', 'yesterday', '2026-02-30', '2026-13-01', '2026-10-01T25:00:00Z', '10/01/2026', '2026-10-01T06']) {
    assert.throws(() => parseInstant(bad, 'x'), (e) => e.status === 400, bad);
  }
});
