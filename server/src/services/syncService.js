import { DataIssue, HierarchyNode, Meter, Reading, SyncState } from '../db/models.js';
import { buildHierarchy } from '../domain/hierarchy.js';
import { isIndexStale } from '../domain/freshness.js';
import { normalizeMeters, normalizeNodes, searchKeyOf } from '../domain/normalize.js';

const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, (i + 1) * n));
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;

/**
 * Pulls the full meter + hierarchy dataset from the source and rebuilds the local MongoDB index.
 *
 * Writes are idempotent upserts stamped with the sync's start time; afterwards anything with an older stamp is
 * deleted. There is no moment when the collections are empty, and a failed sync leaves the previous index intact.
 */
export function createSyncService({ source, log, config }) {
  let inflight = null;
  let timer = null;
  const CHUNK = config.writeBatchSize;

  async function run() {
    const startedAt = new Date();
    await SyncState.updateOne({ _id: 'index' }, { $set: { status: 'running', startedAt, error: null } }, { upsert: true });
    try {
      const [rawNodes, rawMeters] = await Promise.all([source.listNodes(), source.listMeters()]);
      log.debug('sync: fetched from source', { nodes: rawNodes.length, meters: rawMeters.length });
      const { meters, issues: meterIssues } = normalizeMeters(rawMeters);
      const tree = buildHierarchy({ nodes: normalizeNodes(rawNodes), meters });
      const issues = [...meterIssues, ...tree.issues];

      log.debug('sync: writing nodes');
      for (const part of chunks(tree.nodes, CHUNK)) {
        await HierarchyNode.bulkWrite(
          part.map((n) => ({
            updateOne: {
              filter: { _id: n.id },
              update: { $set: { name: n.name, level: n.level, parentId: n.parentId, depth: n.depth, path: n.path, childIds: n.childIds, directMeterCount: n.directMeterCount, meterCount: n.meterCount, issues: n.issues, attributes: n.attributes, syncedAt: startedAt } },
              upsert: true,
            },
          })),
          { ordered: false },
        );
      }
      log.debug('sync: writing meters');
      for (const part of chunks(meters, CHUNK)) {
        await Meter.bulkWrite(
          part.map((m) => {
            const placed = tree.placements.get(m.id) ?? { nodeId: null, path: [] };
            return {
              updateOne: {
                filter: { _id: m.id },
                update: { $set: { name: m.name, serialNumber: m.serialNumber, type: m.type, status: m.status, lat: m.lat, lon: m.lon, nodeId: placed.nodeId, path: placed.path, attributes: m.attributes, issues: m.issues, searchKey: searchKeyOf(m), syncedAt: startedAt } },
                upsert: true,
              },
            };
          }),
          { ordered: false },
        );
      }
      log.debug('sync: writing issues');
      if (issues.length) await DataIssue.insertMany(issues.map((i) => ({ ...i, syncedAt: startedAt })));

      // prune what the portal no longer has (and the cached readings of vanished meters)
      log.debug('sync: pruning');
      const gone = await Meter.find({ syncedAt: { $lt: startedAt } }, { _id: 1 }).lean();
      if (gone.length) await Reading.deleteMany({ meterId: { $in: gone.map((g) => g._id) } });
      await Promise.all([
        Meter.deleteMany({ syncedAt: { $lt: startedAt } }),
        HierarchyNode.deleteMany({ syncedAt: { $lt: startedAt } }),
        DataIssue.deleteMany({ syncedAt: { $lt: startedAt } }),
      ]);

      const finishedAt = new Date();
      const counts = { meters: meters.length, nodes: tree.nodes.length, roots: tree.roots.length, issues: issues.length, removedMeters: gone.length };
      await SyncState.updateOne({ _id: 'index' }, { $set: { status: 'ok', finishedAt, lastSuccessAt: finishedAt, durationMs: finishedAt - startedAt, counts, error: null } });
      log.info('index sync complete', { ...counts, durationMs: finishedAt - startedAt });
      return counts;
    } catch (err) {
      await SyncState.updateOne({ _id: 'index' }, { $set: { status: 'error', finishedAt: new Date(), error: err.message } });
      throw err;
    }
  }

  /** Single-flight: concurrent callers share one run. */
  const sync = () => (inflight ??= run().finally(() => { inflight = null; }));
  const getState = () => SyncState.findById('index').lean();
  const isSyncing = () => inflight !== null;

  function start() {
    const schedule = (ms) => {
      timer = setTimeout(tick, ms);
      timer.unref();
    };
    const tick = async () => {
      try {
        await sync();
        schedule(config.freshness.indexTtlMs);
      } catch (err) {
        log.error('index sync failed; will retry', { error: err.message, type: err.name });
        schedule(Math.min(config.freshness.indexTtlMs, RETRY_AFTER_FAILURE_MS));
      }
    };
    (async () => {
      const state = await getState();
      const last = state?.lastSuccessAt?.getTime();
      if (config.syncOnStart && isIndexStale(last, Date.now(), config.freshness)) await tick();
      else schedule(Math.max(1000, config.freshness.indexTtlMs - (Date.now() - (last ?? 0))));
    })().catch((err) => log.error('could not start sync scheduler', { error: err.message }));
  }
  const stop = () => clearTimeout(timer);

  return { sync, getState, isSyncing, start, stop };
}
