import { Meter, Reading } from '../db/models.js';
import { bucketReadings, summarise } from '../domain/aggregate.js';
import { decideReadingsFetch } from '../domain/freshness.js';
import { normalizeReadings } from '../domain/normalize.js';
import { notFound, PortalError } from '../errors.js';

/**
 * Consumption = read-through cache over the portal:
 *   fresh enough + range covered -> serve from MongoDB
 *   otherwise                    -> fetch from the portal, upsert, then serve from MongoDB
 *   portal fails but we have data -> serve the old data flagged `stale: true` (stale-if-error)
 * See domain/freshness.js for the staleness rules.
 */
export function createConsumptionService({ source, log, config }) {
  const CHUNK = config.writeBatchSize;
  async function get({ meterId, from, to, interval, refresh }) {
    const meter = await Meter.findById(meterId).lean();
    if (!meter) throw notFound(`Meter "${meterId}"`);

    const now = Date.now();
    const cov = meter.readings?.fetchedAt
      ? { from: meter.readings.from.getTime(), to: meter.readings.to.getTime(), fetchedAt: meter.readings.fetchedAt.getTime() }
      : undefined;
    const decision = decideReadingsFetch({ coverage: cov, from: from.getTime(), to: to.getTime(), now, refresh, cfg: config.freshness });

    let servedFrom = 'cache';
    let fetchedAt = cov?.fetchedAt ?? null;
    let unit = meter.readings?.unit ?? 'kWh';
    let stale = false;
    let warning = null;
    let dropped = 0;

    if (decision.fetch) {
      try {
        const res = await source.getConsumption(meterId, { from, to });
        if (res === null) throw notFound(`Meter "${meterId}" on the portal (the local index may be out of date; POST /api/v1/sync)`);
        const parsed = normalizeReadings(res.readings);
        dropped = parsed.dropped;
        for (let i = 0; i < parsed.readings.length; i += CHUNK) {
          await Reading.bulkWrite(
            parsed.readings.slice(i, i + CHUNK).map((r) => ({
              updateOne: { filter: { meterId, ts: r.ts }, update: { $set: { value: r.value, quality: r.quality } }, upsert: true },
            })),
            { ordered: false },
          );
        }
        unit = res.unit ?? unit;
        // Coverage = the most recent window the portal answered for. Replacing (not merging) keeps the freshness claim honest.
        await Meter.updateOne({ _id: meterId }, { $set: { readings: { from: res.coverage.from, to: res.coverage.to, fetchedAt: new Date(now), unit } } });
        servedFrom = 'live';
        fetchedAt = now;
      } catch (err) {
        if (!(err instanceof PortalError) || !cov) throw err; // nothing cached to fall back on
        stale = true;
        warning = `Portal unavailable (${err.message}); serving cached readings`;
        log.warn('serving stale readings', { meterId, error: err.message });
      }
    }

    const docs = await Reading.find({ meterId, ts: { $gte: from, $lt: to } }).sort({ ts: 1 }).lean();
    const points = bucketReadings(docs, interval);
    return {
      meterId,
      unit,
      interval,
      from: from.toISOString(),
      to: to.toISOString(),
      points,
      summary: summarise(points),
      meta: {
        source: source.name, // where the data originates (fixture | portal), same meaning as on every other endpoint
        servedFrom,
        fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
        ageSeconds: fetchedAt ? Math.round((now - fetchedAt) / 1000) : null,
        stale,
        cacheDecision: decision.reason,
        droppedReadings: dropped,
        warning,
      },
    };
  }
  return { get };
}
