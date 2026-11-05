// Cache policy for consumption readings (all times are epoch milliseconds).
//
//  * A window that touches "now" (ends within the last hour) is "live": data is still arriving,
//    so it is trusted only for `readingsLiveTtlMs` (default 5 min).
//  * A closed past window is trusted for `readingsHistoricTtlMs` (default 24 h).
//  * A request is served from cache only if the cached coverage spans it AND the cache is young enough.
//  * `refresh=true` always goes to the portal.
export const LIVE_WINDOW_MS = 60 * 60 * 1000;

export const ttlFor = (to, now, cfg) => (now - to <= LIVE_WINDOW_MS ? cfg.readingsLiveTtlMs : cfg.readingsHistoricTtlMs);

export function decideReadingsFetch({ coverage, from, to, now, refresh = false, cfg }) {
  if (refresh) return { fetch: true, reason: 'forced' };
  if (!coverage?.fetchedAt) return { fetch: true, reason: 'not_cached' };
  const ttl = ttlFor(to, now, cfg);
  // Data newer than our coverage by less than one TTL is "not expected yet", so it doesn't force a refetch.
  if (from < coverage.from || to > coverage.to + ttl) return { fetch: true, reason: 'range_not_covered' };
  if (now - coverage.fetchedAt > ttl) return { fetch: true, reason: 'expired' };
  return { fetch: false, reason: 'fresh' };
}

export const isIndexStale = (finishedAt, now, cfg) => !finishedAt || now - finishedAt > cfg.indexTtlMs;
