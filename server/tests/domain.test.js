import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../src/domain/hierarchy.js';
import { normalizeMeters, normalizeReadings } from '../src/domain/normalize.js';
import { haversineM, boundingBox } from '../src/domain/geo.js';
import { decideReadingsFetch } from '../src/domain/freshness.js';
import { bucketReadings, summarise } from '../src/domain/aggregate.js';

const codes = (r) => r.issues.map((i) => i.code).sort();
const byId = (r, id) => r.nodes.find((n) => n.id === id);

test('hierarchy: clean tree gets depth, path and subtree counts', () => {
  const r = buildHierarchy({
    nodes: [{ id: 'S1' }, { id: 'F1', parentId: 'S1' }, { id: 'T1', parentId: 'F1' }, { id: 'T2', parentId: 'F1' }],
    meters: [{ id: 'm1', parentId: 'T1' }, { id: 'm2', parentId: 'T1' }, { id: 'm3', parentId: 'T2' }],
  });
  assert.deepEqual(r.roots, ['S1']);
  assert.equal(byId(r, 'T1').depth, 2);
  assert.deepEqual(byId(r, 'T1').path, ['S1', 'F1', 'T1']);
  assert.equal(byId(r, 'F1').meterCount, 3);
  assert.equal(byId(r, 'S1').meterCount, 3);
  assert.equal(byId(r, 'T1').directMeterCount, 2);
  assert.deepEqual(r.placements.get('m3'), { nodeId: 'T2', path: ['S1', 'F1', 'T2'] });
  assert.deepEqual(r.issues, []);
});

test('hierarchy: orphan node becomes a root and is reported', () => {
  const r = buildHierarchy({ nodes: [{ id: 'T9', parentId: 'F404' }], meters: [{ id: 'm', parentId: 'T9' }] });
  assert.deepEqual(r.roots, ['T9']);
  assert.deepEqual(codes(r), ['orphan_node']);
  assert.equal(r.placements.get('m').nodeId, 'T9');
});

test('hierarchy: parent cycle is broken deterministically and every node stays reachable', () => {
  const r = buildHierarchy({ nodes: [{ id: 'A', parentId: 'B' }, { id: 'B', parentId: 'A' }, { id: 'C', parentId: 'A' }] });
  assert.deepEqual(r.roots, ['A']); // lowest id in the cycle becomes the root
  assert.equal(r.nodes.length, 3);
  assert.equal(byId(r, 'B').parentId, 'A');
  assert.equal(byId(r, 'C').depth, 1);
  assert.deepEqual(codes(r), ['cycle']);
});

test('hierarchy: self parent, duplicate ids, and missing ids', () => {
  const r = buildHierarchy({
    nodes: [{ id: 'S' }, { id: 'X', parentId: 'X' }, { id: 'F', parentId: 'S' }, { id: 'F', parentId: 'X' }, { id: 'F', parentId: 'S' }, { name: 'no id' }],
  });
  assert.deepEqual(codes(r), ['duplicate_node', 'duplicate_node_conflict', 'missing_id', 'self_parent']);
  assert.equal(byId(r, 'F').parentId, 'S'); // first occurrence wins
  assert.deepEqual(r.roots.sort(), ['S', 'X']);
});

test('hierarchy: tolerant parent references, but never when ambiguous', () => {
  const ok = buildHierarchy({ nodes: [{ id: 'T1' }], meters: [{ id: 'm', parentId: ' t1 ' }] });
  assert.equal(ok.placements.get('m').nodeId, 'T1');
  assert.deepEqual(codes(ok), ['reference_mismatch']);

  // 'Abc' and 'aBc' both exist, so 'ABC' is ambiguous and must NOT be guessed; ' Abc ' trims to an exact match.
  const ambiguous = buildHierarchy({
    nodes: [{ id: 'Abc' }, { id: 'aBc' }],
    meters: [{ id: 'm', parentId: 'ABC' }, { id: 'n', parentId: ' Abc ' }],
  });
  assert.equal(ambiguous.placements.get('m').nodeId, null);
  assert.equal(ambiguous.placements.get('n').nodeId, 'Abc');
  assert.deepEqual(codes(ambiguous), ['meter_unknown_parent']);
});

test('hierarchy: unplaced meters are reported, and a deep chain does not overflow the stack', () => {
  const r = buildHierarchy({ nodes: [], meters: [{ id: 'a' }, { id: 'b', parentId: 'zzz' }] });
  assert.deepEqual(codes(r), ['meter_no_parent', 'meter_unknown_parent']);
  const chain = Array.from({ length: 1500 }, (_, i) => ({ id: `n${i}`, parentId: i ? `n${i - 1}` : null }));
  const deep = buildHierarchy({ nodes: chain });
  assert.equal(byId(deep, 'n1499').depth, 1499);
});

test('normalize: meters are cleaned, bad coordinates dropped, duplicates reported', () => {
  const { meters, issues } = normalizeMeters([
    { id: ' M1 ', status: ' ACTIVE ', lat: '18.5', lon: '73.8', type: 'Three-Phase' },
    { id: 'M2', lat: 200, lon: 10 },
    { id: 'M3' },
    { id: 'M1' },
    { name: 'no id' },
    { id: 'M4', lat: 'abc', lon: 5 },
  ]);
  assert.equal(meters.length, 4);
  assert.deepEqual([meters[0].id, meters[0].status, meters[0].lat, meters[0].type], ['M1', 'active', 18.5, 'three-phase']);
  assert.equal(meters[1].lat, null);
  assert.equal(meters[2].status, 'unknown');
  assert.deepEqual(issues.map((i) => i.code).sort(), ['duplicate_meter', 'invalid_location', 'invalid_location', 'missing_id', 'no_location']);
});

test('normalize: unusable readings are counted, not thrown', () => {
  const { readings, dropped } = normalizeReadings([{ ts: '2026-01-01T00:00:00Z', value: '1.5' }, { ts: 'nope', value: 1 }, { ts: '2026-01-01T01:00:00Z', value: null }]);
  assert.equal(readings.length, 1);
  assert.equal(readings[0].value, 1.5);
  assert.equal(dropped, 2);
});

test('geo: haversine and bounding box', () => {
  const km = haversineM(18.5204, 73.8567, 19.076, 72.8777) / 1000; // Pune -> Mumbai
  assert.ok(km > 118 && km < 123, `got ${km}`);
  assert.equal(haversineM(1, 1, 1, 1), 0);
  const box = boundingBox(18.52, 73.86, 1000);
  for (let deg = 0; deg < 360; deg += 15) {
    const th = (deg * Math.PI) / 180;
    const lat = 18.52 + (1000 * Math.cos(th)) / 111_320;
    const lon = 73.86 + (1000 * Math.sin(th)) / (111_320 * Math.cos((18.52 * Math.PI) / 180));
    assert.ok(Math.abs(haversineM(18.52, 73.86, lat, lon) - 1000) < 15);
    assert.ok(lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon, `deg ${deg}`);
  }
});

test('freshness: serve / refetch decisions', () => {
  const cfg = { readingsLiveTtlMs: 300_000, readingsHistoricTtlMs: 86_400_000 };
  const now = Date.parse('2026-06-10T12:00:00Z');
  const cov = (over = {}) => ({ from: now - 7 * 86_400_000, to: now - 60_000, fetchedAt: now - 60_000, ...over });
  const d = (over) => decideReadingsFetch({ now, cfg, from: now - 86_400_000, to: now, coverage: cov(), ...over }).reason;
  assert.equal(d({}), 'fresh');
  assert.equal(d({ refresh: true }), 'forced');
  assert.equal(d({ coverage: undefined }), 'not_cached');
  assert.equal(d({ coverage: cov({ fetchedAt: now - 10 * 60_000 }) }), 'expired'); // live window, 10 min old
  assert.equal(d({ from: now - 30 * 86_400_000 }), 'range_not_covered');
  assert.equal(d({ coverage: cov({ to: now - 3_600_000 * 3 }) }), 'range_not_covered');
  // closed historic window: a 2-hour-old fetch is still fine
  assert.equal(d({ to: now - 2 * 86_400_000, from: now - 3 * 86_400_000, coverage: cov({ fetchedAt: now - 2 * 3_600_000 }) }), 'fresh');
});

test('aggregate: hour and day buckets, raw passthrough, summary', () => {
  const t = (iso, value) => ({ ts: new Date(iso), value });
  const rs = [t('2026-01-01T00:15:00Z', 1), t('2026-01-01T00:45:00Z', 2), t('2026-01-01T01:15:00Z', 4), t('2026-01-02T00:00:00Z', 8)];
  assert.deepEqual(bucketReadings(rs, 'hour').map((b) => [b.ts, b.value, b.samples]), [
    ['2026-01-01T00:00:00.000Z', 3, 2], ['2026-01-01T01:00:00.000Z', 4, 1], ['2026-01-02T00:00:00.000Z', 8, 1]]);
  assert.deepEqual(bucketReadings(rs, 'day').map((b) => b.value), [7, 8]);
  assert.equal(bucketReadings(rs, 'raw').length, 4);
  assert.deepEqual(summarise(bucketReadings(rs, 'day')), { total: 15, min: 7, max: 8, average: 7.5, points: 2 });
  assert.equal(summarise([]).points, 0);
});
