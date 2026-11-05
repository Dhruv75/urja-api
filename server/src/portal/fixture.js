// SYNTHETIC demo data. Nothing here describes the real portal; it exists so the whole stack
// (index, API, web client, tests) runs without portal access, and it contains deliberate mess
// (orphans, cycles, duplicates, bad coordinates...) to exercise the data-quality handling.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const CENTER = { lat: 18.5204, lon: 73.8567 };
const HOUR = 3_600_000;
const pad = (n, w = 6) => String(n).padStart(w, '0');
const pick = (r, table) => {
  let x = r();
  for (const [value, weight] of table) if ((x -= weight) < 0) return value;
  return table[0][0];
};

export function buildFixtureDataset(seed = 42) {
  const r = mulberry32(seed);
  const nodes = [];
  const meters = [];
  let seq = 1;
  const meter = (parentId, lat, lon, extra = {}) => {
    const n = seq++;
    meters.push({
      id: `MTR-${pad(n)}`,
      name: `Meter ${pad(n)}`,
      serialNumber: `SN${pad(hash32(`sn${n}`) % 10_000_000, 7)}`,
      status: pick(r, [['active', 0.88], ['inactive', 0.07], ['fault', 0.05]]),
      type: pick(r, [['single-phase', 0.8], ['three-phase', 0.2]]),
      lat,
      lon,
      parentId,
      attributes: {
        manufacturer: pick(r, [['Genus', 0.4], ['Secure', 0.35], ['HPL', 0.25]]),
        tariffCategory: pick(r, [['residential', 0.7], ['commercial', 0.25], ['industrial', 0.05]]),
        sanctionedLoadKw: pick(r, [[3, 0.5], [5, 0.3], [10, 0.15], [50, 0.05]]),
        installedAt: new Date(Date.UTC(2019 + Math.floor(r() * 6), Math.floor(r() * 12), 1 + Math.floor(r() * 27))).toISOString().slice(0, 10),
      },
      ...extra,
    });
  };

  for (let s = 1; s <= 2; s++) {
    nodes.push({ id: `SS-${s}`, name: `Substation ${s}`, level: 'substation', parentId: null });
    for (let f = 1; f <= 3; f++) {
      nodes.push({ id: `FD-${s}${f}`, name: `Feeder ${s}.${f}`, level: 'feeder', parentId: `SS-${s}` });
      for (let t = 1; t <= 3; t++) {
        const tid = `TR-${s}${f}${t}`;
        nodes.push({ id: tid, name: `Transformer ${s}.${f}.${t}`, level: 'transformer', parentId: `FD-${s}${f}` });
        const cLat = CENTER.lat + (s - 1) * 0.06 + (f - 2) * 0.02 + (t - 2) * 0.006;
        const cLon = CENTER.lon + (s - 1) * 0.04 + (f - 2) * 0.025 + (t - 2) * 0.008;
        const count = 6 + Math.floor(r() * 8);
        for (let k = 0; k < count; k++) meter(tid, cLat + (r() - 0.5) * 0.004, cLon + (r() - 0.5) * 0.004);
      }
    }
  }

  // ---- deliberate mess ----
  nodes.push({ id: 'TR-ORPHAN', name: 'Transformer with missing parent', level: 'transformer', parentId: 'FD-404' });
  nodes.push({ id: 'FD-CYC-A', name: 'Feeder cycle A', level: 'feeder', parentId: 'FD-CYC-B' });
  nodes.push({ id: 'FD-CYC-B', name: 'Feeder cycle B', level: 'feeder', parentId: 'FD-CYC-A' });
  nodes.push({ id: 'FD-11', name: 'Feeder 1.1 (conflicting duplicate)', level: 'feeder', parentId: 'SS-2' });
  nodes.push({ id: 'TR-SELF', name: 'Transformer that is its own parent', level: 'transformer', parentId: 'TR-SELF' });
  for (let i = 0; i < 3; i++) meter('TR-ORPHAN', CENTER.lat + 0.1 + i * 0.001, CENTER.lon - 0.05);
  meter('FD-CYC-A', CENTER.lat + 0.11, CENTER.lon - 0.05);
  meter('FD-CYC-B', CENTER.lat + 0.112, CENTER.lon - 0.052);
  meter(' tr-111 ', CENTER.lat - 0.02, CENTER.lon - 0.01, { status: ' ACTIVE ' }); // sloppy reference + status
  meter(null, CENTER.lat, CENTER.lon); // no parent
  meter('TR-999', CENTER.lat, CENTER.lon); // unknown parent
  meter('TR-112', null, null); // no coordinates
  meter('TR-112', '', ''); // empty coordinates
  meter('TR-113', 999, 73.8); // impossible latitude
  meter('TR-113', 'n/a', 73.8); // junk coordinates
  meter('TR-121', '18.5301', '73.8412', { status: 'Inactive' }); // numeric strings
  meters.push({ ...meters[4], name: 'Duplicate of the 5th meter', status: 'fault' }); // duplicate meter id

  return { nodes, meters };
}

/** Deterministic hourly interval energy (kWh) with an evening peak and per-hour noise. */
export function fixtureReadings(meterId, from, to, now = Date.now()) {
  const earliest = now - 90 * 24 * HOUR; // the "portal" keeps 90 days
  const start = Math.ceil(Math.max(from.getTime(), earliest) / HOUR) * HOUR;
  const end = Math.min(to.getTime(), now);
  const base = 0.2 + (hash32(meterId) % 100) / 200;
  const out = [];
  for (let t = start; t <= end; t += HOUR) {
    const localHour = (new Date(t).getUTCHours() + 5.5) % 24; // IST
    const daily = 1 + 0.5 * Math.sin(((localHour - 14) / 24) * 2 * Math.PI); // peaks ~20:00
    const noise = 0.85 + 0.3 * ((hash32(`${meterId}:${t}`) % 1000) / 1000);
    out.push({ ts: new Date(t).toISOString(), value: Number((base * daily * noise).toFixed(3)), quality: 'actual' });
  }
  return out;
}

export class FixtureSource {
  name = 'fixture';

  constructor({ seed = 42, now = () => Date.now() } = {}) {
    this.data = buildFixtureDataset(seed);
    this.ids = new Set(this.data.meters.map((m) => m.id));
    this.now = now;
    this.calls = { consumption: 0 };
  }

  async listMeters() {
    return structuredClone(this.data.meters);
  }

  async listNodes() {
    return structuredClone(this.data.nodes);
  }

  async getConsumption(meterId, { from, to }) {
    this.calls.consumption += 1;
    if (!this.ids.has(meterId)) return null;
    return {
      readings: fixtureReadings(meterId, from, to, this.now()),
      coverage: { from, to: new Date(Math.min(to.getTime(), this.now())) },
      unit: 'kWh',
    };
  }

  async ping() {
    return { ok: true, detail: 'synthetic fixture data; the portal is not contacted' };
  }

  state() {
    return { mode: 'fixture', note: 'Synthetic demo data. The real portal is not contacted.' };
  }
}
