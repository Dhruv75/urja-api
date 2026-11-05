import { validLatLon } from './geo.js';

const str = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const num = (v) => {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN; // NaN = "present but unusable"
};

export const issue = (kind, refId, code, message) => ({ kind, refId, code, message });

/**
 * Cleans raw meter records from a source (see portal/source.js for the shape).
 * Never throws on bad data: problems become `issues` and the record is kept when it can be.
 */
export function normalizeMeters(rawMeters) {
  const meters = [];
  const issues = [];
  const seen = new Set();
  rawMeters.forEach((raw, i) => {
    const id = str(raw?.id);
    if (!id) return issues.push(issue('meter', `#${i}`, 'missing_id', 'Record without an id was skipped'));
    if (seen.has(id)) return issues.push(issue('meter', id, 'duplicate_meter', 'Duplicate meter id; the first record was kept'));
    seen.add(id);

    const codes = [];
    let lat = num(raw.lat);
    let lon = num(raw.lon);
    if (lat === null && lon === null) {
      codes.push('no_location');
      lat = lon = null;
    } else if (!validLatLon(lat, lon)) {
      codes.push('invalid_location');
      issues.push(issue('meter', id, 'invalid_location', `Unusable coordinates (${raw.lat}, ${raw.lon}); location dropped`));
      lat = lon = null;
    }
    if (codes.includes('no_location')) issues.push(issue('meter', id, 'no_location', 'Meter has no coordinates'));

    meters.push({
      id,
      name: str(raw.name),
      serialNumber: str(raw.serialNumber),
      type: str(raw.type)?.toLowerCase() ?? null,
      status: str(raw.status)?.toLowerCase() ?? 'unknown',
      lat,
      lon,
      parentId: str(raw.parentId),
      attributes: raw.attributes && typeof raw.attributes === 'object' ? raw.attributes : {},
      issues: codes,
    });
  });
  return { meters, issues };
}

export const normalizeNodes = (rawNodes) =>
  rawNodes.map((n) => ({
    id: str(n?.id),
    name: str(n?.name),
    level: str(n?.level)?.toLowerCase() ?? null,
    parentId: str(n?.parentId),
    attributes: n?.attributes && typeof n.attributes === 'object' ? n.attributes : {},
  }));

/** Parses raw readings into {ts: Date, value: number}; reports how many were unusable. */
export function normalizeReadings(rawReadings) {
  const readings = [];
  let dropped = 0;
  for (const r of rawReadings) {
    const ts = new Date(r?.ts);
    const value = num(r?.value);
    if (Number.isNaN(ts.getTime()) || value === null || Number.isNaN(value)) dropped += 1;
    else readings.push({ ts, value, quality: str(r.quality) });
  }
  return { readings, dropped };
}

export const searchKeyOf = (m) => [m.id, m.name, m.serialNumber].filter(Boolean).join(' ').toLowerCase();
