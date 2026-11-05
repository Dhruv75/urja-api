import { issue } from './normalize.js';

const clean = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const looseKey = (s) => s.trim().toLowerCase();

/**
 * Reconstructs the network tree from flat (id, parentId) records and places meters in it.
 *
 * Real-world hierarchies are messy, so instead of failing it repairs deterministically and reports:
 *   missing_id            node without an id (skipped)
 *   duplicate_node        same id twice, same parent (first kept)
 *   duplicate_node_conflict  same id twice, different parents (first kept)
 *   orphan_node           parent id does not exist -> node becomes a root
 *   self_parent           node is its own parent -> becomes a root
 *   cycle                 A -> B -> A ...; broken at the lowest id of the cycle
 *   reference_mismatch    parent id only matched after trimming / ignoring case
 *   meter_no_parent / meter_unknown_parent   meter cannot be placed
 *
 * Iterative (no recursion), O(n) apart from sorting. Pure function: no I/O.
 * @returns {{nodes: object[], roots: string[], placements: Map<string,{nodeId:string|null,path:string[]}>, issues: object[]}}
 */
export function buildHierarchy({ nodes = [], meters = [] }) {
  const issues = [];
  const byId = new Map();

  for (const n of nodes) {
    const id = clean(n?.id);
    if (!id) {
      issues.push(issue('node', null, 'missing_id', 'Node without an id was skipped'));
      continue;
    }
    const parentRef = clean(n.parentId);
    const prev = byId.get(id);
    if (prev) {
      const same = prev.parentRef === parentRef;
      issues.push(issue('node', id, same ? 'duplicate_node' : 'duplicate_node_conflict',
        same ? 'Node listed twice; first kept' : `Node listed twice with different parents (${prev.parentRef} vs ${parentRef}); first kept`));
      continue;
    }
    byId.set(id, { id, name: n.name ?? null, level: n.level ?? null, attributes: n.attributes ?? {}, parentRef, parentId: null, issues: [] });
  }

  // Exact match first; otherwise a trimmed/case-insensitive match, but only when it is unambiguous.
  const loose = new Map();
  for (const id of byId.keys()) loose.set(looseKey(id), loose.has(looseKey(id)) ? null : id);
  const resolve = (ref) => {
    if (byId.has(ref)) return { id: ref, loose: false };
    const hit = loose.get(looseKey(ref));
    return hit ? { id: hit, loose: true } : null;
  };
  const flag = (n, code, message) => {
    if (!n.issues.includes(code)) n.issues.push(code);
    issues.push(issue('node', n.id, code, message));
  };

  for (const n of byId.values()) {
    if (n.parentRef === null) continue;
    const r = resolve(n.parentRef);
    if (!r) flag(n, 'orphan_node', `Parent "${n.parentRef}" does not exist; node treated as a root`);
    else if (r.id === n.id) flag(n, 'self_parent', 'Node is its own parent; treated as a root');
    else {
      n.parentId = r.id;
      if (r.loose) flag(n, 'reference_mismatch', `Parent "${n.parentRef}" matched "${r.id}" only after ignoring case/whitespace`);
    }
  }

  // Each node has at most one parent, so cycles are found by walking up with a visiting/done colouring.
  const colour = new Map();
  for (const start of byId.keys()) {
    if (colour.has(start)) continue;
    const walk = [];
    let cur = start;
    while (cur && !colour.has(cur)) {
      colour.set(cur, 'visiting');
      walk.push(cur);
      cur = byId.get(cur).parentId;
    }
    if (cur && colour.get(cur) === 'visiting') {
      const members = walk.slice(walk.indexOf(cur));
      const breakAt = [...members].sort()[0];
      const node = byId.get(breakAt);
      node.parentId = null;
      flag(node, 'cycle', `Parent cycle ${[...members, members[0]].join(' -> ')}; broken at "${breakAt}", which is now a root`);
    }
    for (const id of walk) colour.set(id, 'done');
  }

  const children = new Map();
  const roots = [];
  for (const n of byId.values()) {
    if (n.parentId === null) roots.push(n.id);
    else children.set(n.parentId, [...(children.get(n.parentId) ?? []), n.id]);
  }

  const order = [];
  for (const id of roots) {
    byId.get(id).depth = 0;
    byId.get(id).path = [id];
    order.push(id);
  }
  for (let i = 0; i < order.length; i++) {
    const parent = byId.get(order[i]);
    for (const cid of children.get(parent.id) ?? []) {
      const c = byId.get(cid);
      c.depth = parent.depth + 1;
      c.path = [...parent.path, cid];
      order.push(cid);
    }
  }
  for (const n of byId.values()) {
    n.childIds = children.get(n.id) ?? [];
    n.directMeterCount = 0;
  }

  const placements = new Map();
  for (const m of meters) {
    const ref = clean(m.parentId);
    if (ref === null) {
      placements.set(m.id, { nodeId: null, path: [] });
      issues.push(issue('meter', m.id, 'meter_no_parent', 'Meter has no parent node; unplaced'));
      continue;
    }
    const r = resolve(ref);
    if (!r) {
      placements.set(m.id, { nodeId: null, path: [] });
      issues.push(issue('meter', m.id, 'meter_unknown_parent', `Parent node "${ref}" does not exist; unplaced`));
      continue;
    }
    const node = byId.get(r.id);
    node.directMeterCount += 1;
    placements.set(m.id, { nodeId: r.id, path: node.path });
    if (r.loose) issues.push(issue('meter', m.id, 'reference_mismatch', `Parent "${ref}" matched "${r.id}" only after ignoring case/whitespace`));
  }

  for (const n of byId.values()) n.meterCount = n.directMeterCount;
  for (let i = order.length - 1; i >= 0; i--) {
    const n = byId.get(order[i]);
    if (n.parentId !== null) byId.get(n.parentId).meterCount += n.meterCount;
  }

  return { nodes: order.map((id) => byId.get(id)), roots, placements, issues };
}
