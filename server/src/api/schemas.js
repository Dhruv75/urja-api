import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

// These schemas are the single source of truth: they validate incoming query strings, they generate openapi.json,
// and the contract tests parse real responses with them, so docs and behaviour cannot silently drift apart.

const int = z.number().int();
const nullableString = z.string().nullable();
const location = () => z.object({ lat: z.number(), lon: z.number() }).nullable(); // inline on purpose (see README)

// ---- shared envelopes -----------------------------------------------------------------------------
export const ErrorBody = z
  .object({ error: z.object({ code: z.string().openapi({ example: 'not_found' }), message: z.string(), details: z.unknown().optional() }) })
  .openapi('Error');

export const Page = z.object({ limit: int, offset: int, total: int }).openapi('Page');

export const IndexMeta = z
  .object({
    source: z.enum(['fixture', 'portal']).openapi({ description: '`fixture` means SYNTHETIC demo data, never the real portal' }),
    syncedAt: nullableString.openapi({ description: 'When the local index was last rebuilt from the portal' }),
    stale: z.boolean().openapi({ description: 'True if the index is older than INDEX_TTL_SEC or the last sync failed' }),
  })
  .openapi('IndexMeta');

// ---- meters ---------------------------------------------------------------------------------------
export const Meter = z
  .object({
    id: z.string().openapi({ example: 'MTR-000001' }),
    name: nullableString,
    serialNumber: nullableString,
    type: nullableString,
    status: z.string().openapi({ description: 'Trimmed and lower-cased; "unknown" when the portal gives none', example: 'active' }),
    location: location(),
    nodeId: nullableString.openapi({ description: 'Hierarchy node the meter hangs off; null when it cannot be placed' }),
    attributes: z.record(z.string(), z.unknown()).openapi({ description: 'Every other field the portal exposes, verbatim' }),
    dataQuality: z.array(z.string()).openapi({ description: 'Issue codes found while cleaning this record (see /data-quality)' }),
  })
  .openapi('Meter');

export const HierarchyRef = z.object({ id: z.string(), name: nullableString, level: nullableString }).openapi('HierarchyRef');
export const MeterDetail = z.object({ ...Meter.shape, hierarchyPath: z.array(HierarchyRef), syncedAt: z.string() }).openapi('MeterDetail');
export const NearbyMeter = z.object({ ...Meter.shape, distanceM: z.number() }).openapi('NearbyMeter');

export const MeterList = z.object({ data: z.array(Meter), page: Page, meta: IndexMeta }).openapi('MeterList');
export const MeterDetailResponse = z.object({ data: MeterDetail, meta: IndexMeta }).openapi('MeterDetailResponse');
export const NearbyResponse = z
  .object({ data: z.array(NearbyMeter), query: z.object({ lat: z.number(), lon: z.number(), radiusM: z.number(), limit: int }), meta: IndexMeta })
  .openapi('NearbyResponse');

export const MeterQuery = z
  .object({
    q: z.string().trim().min(1).max(100).optional().openapi({ description: 'Case-insensitive substring of id, name or serial number' }),
    status: z.string().optional().openapi({ description: 'Comma-separated, e.g. `active,fault`' }),
    type: z.string().optional().openapi({ description: 'Comma-separated, e.g. `single-phase`' }),
    nodeId: z.string().optional().openapi({ description: 'Only meters anywhere below this hierarchy node' }),
    hasLocation: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    sort: z.enum(['id', 'name', 'status']).default('id'),
  })
  .strict();

export const NearbyQuery = z
  .object({
    lat: z.coerce.number().min(-90).max(90),
    lon: z.coerce.number().min(-180).max(180),
    radiusM: z.coerce.number().min(1).max(50_000).default(1000),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.string().optional().openapi({ description: 'Comma-separated' }),
  })
  .strict();

// ---- consumption ----------------------------------------------------------------------------------
export const ConsumptionPoint = z
  .object({
    ts: z.string().openapi({ description: 'Start of the interval, UTC' }),
    value: z.number().openapi({ description: 'Energy in the interval (`unit`)' }),
    samples: int.openapi({ description: 'Readings summed into this bucket. A bucket with fewer samples than its neighbours is partial (window edge, or today so far); do not read it as a drop in consumption.' }),
  })
  .openapi('ConsumptionPoint');

export const ConsumptionSummary = z
  .object({ total: z.number(), min: z.number().nullable(), max: z.number().nullable(), average: z.number().nullable(), points: int })
  .openapi('ConsumptionSummary');

export const ConsumptionMeta = z
  .object({
    source: z.enum(['fixture', 'portal']).openapi({ description: 'Where the data originates (`fixture` = SYNTHETIC demo data)' }),
    servedFrom: z.enum(['cache', 'live']).openapi({ description: '`live`: fetched from the source during this request. `cache`: answered from MongoDB.' }),
    fetchedAt: nullableString,
    ageSeconds: int.nullable(),
    stale: z.boolean().openapi({ description: 'True when the portal failed and an older cached answer is being served' }),
    cacheDecision: z.enum(['fresh', 'forced', 'not_cached', 'expired', 'range_not_covered']),
    droppedReadings: int.openapi({ description: 'Portal rows that could not be parsed' }),
    warning: nullableString,
  })
  .openapi('ConsumptionMeta');

export const ConsumptionResponse = z
  .object({
    data: z.object({
      meterId: z.string(),
      unit: z.string().openapi({ example: 'kWh' }),
      interval: z.enum(['raw', 'hour', 'day']),
      from: z.string(),
      to: z.string(),
      points: z.array(ConsumptionPoint),
      summary: ConsumptionSummary,
    }),
    meta: ConsumptionMeta,
  })
  .openapi('ConsumptionResponse');

export const ConsumptionQuery = z
  .object({
    from: z.string().optional().openapi({ description: 'ISO-8601 instant or date (no offset = UTC). Default: `to` minus 7 days', example: '2026-10-01' }),
    to: z.string().optional().openapi({ description: 'Exclusive end. Default: now', example: '2026-10-08T00:00:00Z' }),
    interval: z.enum(['raw', 'hour', 'day']).default('hour').openapi({ description: 'Aggregation bucket (UTC)' }),
    refresh: z.enum(['true', 'false']).optional().openapi({ description: 'Bypass the cache and ask the portal' }),
  })
  .strict();

// ---- hierarchy ------------------------------------------------------------------------------------
export const NodeSummary = z
  .object({ id: z.string(), name: nullableString, level: nullableString, depth: int, directMeterCount: int, meterCount: int.openapi({ description: 'Meters in the whole subtree' }), childCount: int, issues: z.array(z.string()) })
  .openapi('NodeSummary');

export const TreeNode = z
  .object({
    ...NodeSummary.shape,
    get children() {
      return z.array(TreeNode);
    },
  })
  .openapi('TreeNode');

export const HierarchyResponse = z
  .object({ data: z.object({ roots: z.array(TreeNode), unplacedMeters: int }), meta: IndexMeta })
  .openapi('HierarchyResponse');

export const NodeDetailResponse = z
  .object({ data: z.object({ ...NodeSummary.shape, parentId: nullableString, ancestors: z.array(HierarchyRef), children: z.array(NodeSummary) }), meta: IndexMeta })
  .openapi('NodeDetailResponse');

export const HierarchyQuery = z.object({ depth: z.coerce.number().int().min(0).max(20).optional().openapi({ description: 'Levels below the roots to include; omit for the whole tree' }) }).strict();

// ---- data quality, sync, health -------------------------------------------------------------------
export const DataIssue = z
  .object({ kind: z.enum(['meter', 'node']), refId: nullableString, code: z.string().openapi({ example: 'orphan_node' }), message: z.string() })
  .openapi('DataIssue');

export const DataQualityResponse = z
  .object({ data: z.array(DataIssue), summary: z.record(z.string(), int).openapi({ description: 'Issue count per code (unfiltered)' }), page: Page, meta: IndexMeta })
  .openapi('DataQualityResponse');

export const DataQualityQuery = z
  .object({ code: z.string().optional(), kind: z.enum(['meter', 'node']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) })
  .strict();

export const SyncStatus = z
  .object({
    status: z.enum(['never', 'running', 'ok', 'error']),
    startedAt: nullableString,
    finishedAt: nullableString,
    lastSuccessAt: nullableString,
    durationMs: int.nullable(),
    counts: z.record(z.string(), z.number()).nullable(),
    error: nullableString,
  })
  .openapi('SyncStatus');
export const SyncResponse = z.object({ data: SyncStatus }).openapi('SyncResponse');
export const SyncQuery = z.object({ wait: z.enum(['true', 'false']).optional().openapi({ description: 'Block until the sync finishes (200) instead of returning 202 immediately' }) }).strict();

export const HealthResponse = z
  .object({
    status: z.enum(['ok', 'degraded']),
    version: z.string(),
    uptimeSec: int,
    source: z.object({ mode: z.enum(['fixture', 'portal']), ok: z.boolean().nullable().openapi({ description: 'null unless `?deep=true` was requested' }), detail: z.string().nullable(), state: z.record(z.string(), z.unknown()) }),
    index: z.object({ sync: SyncStatus, ageSeconds: int.nullable(), stale: z.boolean() }),
  })
  .openapi('HealthResponse');
export const HealthQuery = z.object({ deep: z.enum(['true', 'false']).optional().openapi({ description: 'Also log in to / ping the portal (generates portal traffic)' }) }).strict();
