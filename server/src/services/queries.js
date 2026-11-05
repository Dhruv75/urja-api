import { badRequest } from '../errors.js';

export const csv = (s) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ATTR_KEY = /^[A-Za-z0-9_]{1,64}$/;
const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true });

/**
 * Separates generic `attr.<name>=<value>` filters from the documented query parameters.
 * Attribute names are whitelisted to [A-Za-z0-9_] and values must be plain strings, so a caller can never
 * smuggle a MongoDB operator ($ne, $where...) into a query. Empty values are treated as "not given".
 */
export function splitAttrs(query) {
  const attrs = {};
  const rest = {};
  for (const [key, raw] of Object.entries(query)) {
    const values = Array.isArray(raw) ? raw : [raw];
    if (!values.every((v) => typeof v === 'string')) throw badRequest('validation_error', `Parameter "${key}" must be a plain string`);
    if (key.startsWith('attr.')) {
      const name = key.slice(5);
      if (!ATTR_KEY.test(name)) throw badRequest('invalid_attribute_filter', `Attribute filter names may only contain letters, digits and "_" (got "${name}")`);
      const nonEmpty = values.filter((v) => v !== '');
      if (nonEmpty.length) attrs[name] = nonEmpty;
    } else if (values.join('') !== '') rest[key] = values.join(',');
  }
  return { attrs, rest };
}

// Portal attributes keep their original JSON types, but query strings are always text: try the plausible readings.
const variants = (v) => {
  const out = [v];
  if (v.trim() !== '' && Number.isFinite(Number(v))) out.push(Number(v));
  if (v === 'true' || v === 'false') out.push(v === 'true');
  return out;
};

export function buildMeterFilter({ q, status, type, nodeId, hasLocation, attrs = {} }) {
  const f = {};
  if (q) f.searchKey = { $regex: escapeRegex(q.toLowerCase()) }; // substring match; a scan, fine at this scale
  if (status) f.status = { $in: csv(status) };
  if (type) f.type = { $in: csv(type) };
  if (nodeId) f.path = nodeId; // multikey index: any depth below that node
  if (hasLocation === 'true') f.lat = { $ne: null };
  if (hasLocation === 'false') f.lat = null;
  for (const [name, values] of Object.entries(attrs)) f[`attributes.${name}`] = { $in: values.flatMap(variants) };
  return f;
}

// ---- DTO mappers (Mongo document -> API shape) ----------------------------------------------------
export const toMeterDto = (m) => ({
  id: m._id,
  name: m.name ?? null,
  serialNumber: m.serialNumber ?? null,
  type: m.type ?? null,
  status: m.status ?? 'unknown',
  location: m.lat != null && m.lon != null ? { lat: m.lat, lon: m.lon } : null,
  nodeId: m.nodeId ?? null,
  attributes: m.attributes ?? {},
  dataQuality: m.issues ?? [],
});

export const toRef = (n) => ({ id: n._id, name: n.name ?? null, level: n.level ?? null });

export const toNodeSummary = (n) => ({
  id: n._id,
  name: n.name ?? null,
  level: n.level ?? null,
  depth: n.depth ?? 0,
  directMeterCount: n.directMeterCount ?? 0,
  meterCount: n.meterCount ?? 0,
  childCount: n.childIds?.length ?? 0,
  issues: n.issues ?? [],
});

/** Flat node documents -> nested tree. `maxDepth` limits how many levels below the roots are included. */
export function nestTree(nodes, maxDepth) {
  const dto = new Map(nodes.map((n) => [n._id, { ...toNodeSummary(n), children: [] }]));
  const roots = [];
  for (const n of [...nodes].sort((a, b) => naturalCompare(a._id, b._id))) {
    const me = dto.get(n._id);
    if (!n.parentId) roots.push(me);
    else if (maxDepth === undefined || me.depth <= maxDepth) dto.get(n.parentId)?.children.push(me);
  }
  return roots;
}
