// All configuration comes from environment variables (see ../../.env.example).
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export function loadConfig(env = process.env) {
  return {
    port: int(env.PORT, 3000),
    mongoUri: env.MONGODB_URI || 'mongodb://127.0.0.1:27017/urja_api',
    // 'fixture' = synthetic demo data, never touches the portal.
    // 'portal'  = the real Urja Meter Ops portal (needs credentials below).
    sourceMode: env.SOURCE_MODE || 'fixture',
    portal: {
      baseUrl: (env.PORTAL_BASE_URL || 'https://urja-ops.flockenergy.tech').replace(/\/+$/, ''),
      username: env.PORTAL_USERNAME || '',
      password: env.PORTAL_PASSWORD || '',
      loginPath: env.PORTAL_LOGIN_PATH || '/login',
      timeoutMs: int(env.PORTAL_TIMEOUT_MS, 15_000),
      maxRetries: int(env.PORTAL_MAX_RETRIES, 3),
      maxConcurrency: int(env.PORTAL_MAX_CONCURRENCY, 2),
      minIntervalMs: int(env.PORTAL_MIN_INTERVAL_MS, 150), // politeness: gap between request starts
      loginCooldownMs: int(env.PORTAL_LOGIN_COOLDOWN_MS, 60_000), // after a failed login, don't hammer
    },
    freshness: {
      readingsLiveTtlMs: int(env.READINGS_LIVE_TTL_SEC, 300) * 1000, // window touching "now"
      readingsHistoricTtlMs: int(env.READINGS_HISTORIC_TTL_SEC, 86_400) * 1000, // closed past windows
      indexTtlMs: int(env.INDEX_TTL_SEC, 6 * 3600) * 1000, // meters + hierarchy
      maxRangeDays: int(env.MAX_RANGE_DAYS, 366),
    },
    // Documents per bulk write. MongoDB itself accepts thousands; 25 is deliberately conservative because the
    // MongoDB-compatible server used for testing (FerretDB) hangs on bulk updates above ~45 operations.
    writeBatchSize: Math.max(1, int(env.WRITE_BATCH_SIZE, 25)),
    syncOnStart: env.SYNC_ON_START !== 'false',
    corsOrigin: env.CORS_ORIGIN || 'http://localhost:5173',
    logLevel: env.LOG_LEVEL || 'info',
  };
}
