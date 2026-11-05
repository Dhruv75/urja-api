import { Router } from 'express';
import { DataIssue, HierarchyNode, Meter } from '../db/models.js';
import { boundingBox, haversineM } from '../domain/geo.js';
import { isIndexStale } from '../domain/freshness.js';
import { AppError, badRequest, IndexNotReadyError, notFound } from '../errors.js';
import { buildMeterFilter, csv, nestTree, splitAttrs, toMeterDto, toNodeSummary, toRef } from '../services/queries.js';
import * as S from './schemas.js';

const DAY = 86_400_000;
const NEARBY_SCAN_CAP = 20_000; // memory guard for huge radii in dense areas

// Empty values (`?lat=`) count as "not given"; otherwise z.coerce.number() would quietly turn '' into 0.
const present = (query) => Object.fromEntries(Object.entries(query).filter(([, v]) => v !== ''));

/** ISO-8601 date or datetime ("2026-10-01", "2026-10-01T06:30:00+05:30"); no offset means UTC. */
export function parseInstant(value, name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2}(?:\.\d+)?))?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(String(value).trim());
  if (!m) throw badRequest('validation_error', `"${name}" must be an ISO-8601 date or datetime (e.g. 2026-10-01 or 2026-10-01T06:30:00Z)`);
  const [, y, mo, da, hm, sec, zone] = m;
  const calendar = new Date(Date.UTC(+y, +mo - 1, +da));
  if (calendar.getUTCMonth() !== +mo - 1 || calendar.getUTCDate() !== +da) throw badRequest('validation_error', `"${name}" is not a real calendar date`);
  let iso = `${y}-${mo}-${da}`;
  if (hm) iso += `T${hm}:${sec ?? '00'}${zone ? (zone.toUpperCase() === 'Z' ? 'Z' : zone.replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2')) : 'Z'}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw badRequest('validation_error', `"${name}" is not a valid date/time`);
  return d;
}

export function createRouter({ config, source, sync, consumption, version }) {
  const r = Router();
  const startedAt = Date.now();

  const syncJson = (st) => ({
    status: st?.status ?? 'never',
    startedAt: st?.startedAt?.toISOString() ?? null,
    finishedAt: st?.finishedAt?.toISOString() ?? null,
    lastSuccessAt: st?.lastSuccessAt?.toISOString() ?? null,
    durationMs: st?.durationMs ?? null,
    counts: st?.counts ?? null,
    error: st?.error ?? null,
  });

  const indexMeta = (st) => ({
    source: source.name,
    syncedAt: st.lastSuccessAt?.toISOString() ?? null,
    stale: st.status === 'error' || isIndexStale(st.lastSuccessAt?.getTime(), Date.now(), config.freshness),
  });

  /** Every index-backed endpoint needs one successful sync; say why if it hasn't happened. */
  async function requireIndex() {
    const st = await sync.getState();
    if (st?.lastSuccessAt) return st;
    const why = sync.isSyncing() || st?.status === 'running' ? 'The index is being built for the first time' : st?.error ? `The first index build failed: ${st.error}` : 'The index has not been built yet';
    throw new IndexNotReadyError(`${why}; retry shortly (or POST /api/v1/sync)`);
  }

  r.get('/health', async (req, res) => {
    const q = S.HealthQuery.parse(present(req.query));
    const st = await sync.getState();
    let ping = null;
    if (q.deep === 'true') ping = await source.ping().catch((e) => ({ ok: false, detail: e.message }));
    const stale = st?.status === 'error' || isIndexStale(st?.lastSuccessAt?.getTime(), Date.now(), config.freshness);
    res.json({
      status: ping?.ok === false || st?.status === 'error' ? 'degraded' : 'ok',
      version,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      source: { mode: source.name, ok: ping ? ping.ok : null, detail: ping?.detail ?? null, state: source.state() },
      index: { sync: syncJson(st), ageSeconds: st?.lastSuccessAt ? Math.round((Date.now() - st.lastSuccessAt.getTime()) / 1000) : null, stale },
    });
  });

  r.post('/sync', async (req, res) => {
    const q = S.SyncQuery.parse(present(req.query));
    if (q.wait === 'true') {
      await sync.sync();
      return res.json({ data: syncJson(await sync.getState()) });
    }
    sync.sync().catch(() => {}); // a failure is recorded in the sync state and logged by the service
    const st = syncJson(await sync.getState());
    res.status(202).json({ data: { ...st, status: 'running' } }); // started now, or already running: either way it is running
  });

  r.get('/meters', async (req, res) => {
    const { attrs, rest } = splitAttrs(req.query);
    const q = S.MeterQuery.parse(rest);
    const st = await requireIndex();
    const filter = buildMeterFilter({ ...q, attrs });
    const sort = q.sort === 'id' ? { _id: 1 } : { [q.sort]: 1, _id: 1 };
    const [docs, total] = await Promise.all([Meter.find(filter).sort(sort).skip(q.offset).limit(q.limit).lean(), Meter.countDocuments(filter)]);
    res.json({ data: docs.map(toMeterDto), page: { limit: q.limit, offset: q.offset, total }, meta: indexMeta(st) });
  });

  // Registered before /meters/:meterId so "nearby" is not mistaken for an id.
  r.get('/meters/nearby', async (req, res) => {
    const q = S.NearbyQuery.parse(present(req.query));
    const st = await requireIndex();
    const box = boundingBox(q.lat, q.lon, q.radiusM);
    const filter = { lat: { $gte: box.minLat, $lte: box.maxLat }, lon: { $gte: box.minLon, $lte: box.maxLon } };
    if (q.status) filter.status = { $in: csv(q.status) };
    const docs = await Meter.find(filter).limit(NEARBY_SCAN_CAP).lean();
    const hits = docs
      .map((d) => ({ d, distanceM: haversineM(q.lat, q.lon, d.lat, d.lon) }))
      .filter((h) => h.distanceM <= q.radiusM)
      .sort((a, b) => a.distanceM - b.distanceM || a.d._id.localeCompare(b.d._id))
      .slice(0, q.limit);
    res.json({
      data: hits.map((h) => ({ ...toMeterDto(h.d), distanceM: Math.round(h.distanceM * 10) / 10 })),
      query: { lat: q.lat, lon: q.lon, radiusM: q.radiusM, limit: q.limit },
      meta: indexMeta(st),
    });
  });

  r.get('/meters/:meterId', async (req, res) => {
    const st = await requireIndex();
    const m = await Meter.findById(req.params.meterId).lean();
    if (!m) throw notFound(`Meter "${req.params.meterId}"`);
    const nodes = m.path?.length ? await HierarchyNode.find({ _id: { $in: m.path } }).lean() : [];
    const byId = new Map(nodes.map((n) => [n._id, n]));
    const hierarchyPath = m.path.map((nid) => byId.get(nid)).filter(Boolean).map(toRef);
    res.json({ data: { ...toMeterDto(m), hierarchyPath, syncedAt: m.syncedAt.toISOString() }, meta: indexMeta(st) });
  });

  r.get('/meters/:meterId/consumption', async (req, res) => {
    const q = S.ConsumptionQuery.parse(present(req.query));
    const to = q.to ? parseInstant(q.to, 'to') : new Date();
    const from = q.from ? parseInstant(q.from, 'from') : new Date(to.getTime() - 7 * DAY);
    if (from >= to) throw badRequest('validation_error', '"from" must be earlier than "to"');
    if (to - from > config.freshness.maxRangeDays * DAY) throw new AppError(400, 'range_too_large', `The window may span at most ${config.freshness.maxRangeDays} days`);
    const { meta, ...data } = await consumption.get({ meterId: req.params.meterId, from, to, interval: q.interval, refresh: q.refresh === 'true' });
    res.json({ data, meta });
  });

  r.get('/hierarchy', async (req, res) => {
    const q = S.HierarchyQuery.parse(present(req.query));
    const st = await requireIndex();
    const [nodes, unplacedMeters] = await Promise.all([HierarchyNode.find().lean(), Meter.countDocuments({ nodeId: null })]);
    res.json({ data: { roots: nestTree(nodes, q.depth), unplacedMeters }, meta: indexMeta(st) });
  });

  r.get('/hierarchy/:nodeId', async (req, res) => {
    const st = await requireIndex();
    const node = await HierarchyNode.findById(req.params.nodeId).lean();
    if (!node) throw notFound(`Node "${req.params.nodeId}"`);
    const related = await HierarchyNode.find({ _id: { $in: [...node.path.slice(0, -1), ...node.childIds] } }).lean();
    const byId = new Map(related.map((n) => [n._id, n]));
    const ancestors = node.path.slice(0, -1).map((nid) => byId.get(nid)).filter(Boolean).map(toRef);
    const children = node.childIds.map((cid) => byId.get(cid)).filter(Boolean).map(toNodeSummary).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    res.json({ data: { ...toNodeSummary(node), parentId: node.parentId ?? null, ancestors, children }, meta: indexMeta(st) });
  });

  r.get('/data-quality', async (req, res) => {
    const q = S.DataQualityQuery.parse(present(req.query));
    const st = await requireIndex();
    const filter = { ...(q.code ? { code: q.code } : {}), ...(q.kind ? { kind: q.kind } : {}) };
    const codes = await DataIssue.distinct('code');
    const [docs, total, counts] = await Promise.all([
      DataIssue.find(filter).sort({ code: 1, refId: 1 }).skip(q.offset).limit(q.limit).lean(),
      DataIssue.countDocuments(filter),
      Promise.all(codes.map(async (c) => [c, await DataIssue.countDocuments({ code: c })])),
    ]);
    res.json({
      data: docs.map((d) => ({ kind: d.kind, refId: d.refId ?? null, code: d.code, message: d.message })),
      summary: Object.fromEntries(counts.sort(([a], [b]) => a.localeCompare(b))),
      page: { limit: q.limit, offset: q.offset, total },
      meta: indexMeta(st),
    });
  });

  return r;
}
