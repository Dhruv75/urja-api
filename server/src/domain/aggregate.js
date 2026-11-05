const SIZES = { hour: 3_600_000, day: 86_400_000 };
const round = (x) => Math.round(x * 1e4) / 1e4;

/**
 * Buckets readings (interval energy values) into UTC hours/days. `raw` returns them as stored.
 * @param {{ts: Date, value: number}[]} readings sorted ascending
 */
export function bucketReadings(readings, interval) {
  if (interval === 'raw') return readings.map((r) => ({ ts: r.ts.toISOString(), value: round(r.value), samples: 1 }));
  const size = SIZES[interval];
  const buckets = new Map();
  for (const r of readings) {
    const key = Math.floor(r.ts.getTime() / size) * size;
    const b = buckets.get(key) ?? { sum: 0, samples: 0 };
    b.sum += r.value;
    b.samples += 1;
    buckets.set(key, b);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, b]) => ({ ts: new Date(key).toISOString(), value: round(b.sum), samples: b.samples }));
}

export function summarise(points) {
  if (!points.length) return { total: 0, min: null, max: null, average: null, points: 0 };
  const values = points.map((p) => p.value);
  const total = values.reduce((a, b) => a + b, 0);
  return { total: round(total), min: Math.min(...values), max: Math.max(...values), average: round(total / values.length), points: values.length };
}
