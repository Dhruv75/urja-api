// Dependency-free SVG bar chart. Bars are intervals of energy; hover (or long-press) a bar for its exact value.
const W = 640;
const H = 230;
const M = { top: 24, right: 12, bottom: 34, left: 46 };

export function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

const fmtTick = (iso, interval) => {
  const d = new Date(iso);
  return interval === 'day' ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

/** Buckets with fewer readings than the fullest bucket are partial (window edges, "today so far"). */
export const fullCount = (points) => Math.max(1, ...points.map((p) => p.samples ?? 1));
export const isPartial = (p, full) => (p.samples ?? full) < full;
export function averageOfFull(points) {
  const full = fullCount(points);
  const whole = points.filter((p) => !isPartial(p, full));
  return whole.length ? Math.round((whole.reduce((a, p) => a + p.value, 0) / whole.length) * 1e4) / 1e4 : null;
}

export default function ConsumptionChart({ points, unit = 'kWh', interval = 'hour' }) {
  if (!points.length) return <p className="muted">No readings in this window.</p>;
  const max = niceMax(Math.max(...points.map((p) => p.value)));
  const full = fullCount(points);
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;
  const bw = iw / points.length;
  const y = (v) => M.top + ih - (v / max) * ih;
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const labelIdx = [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const anyPartial = points.some((p) => isPartial(p, full));
  return (
    <>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Consumption in ${unit}`} className="chart">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} className="grid" />
          <text x={M.left - 6} y={y(t) + 4} textAnchor="end" className="axis">{+t.toPrecision(3)}</text>
        </g>
      ))}
      <text x={4} y={12} className="axis">{unit}</text>
      {points.map((p, i) => (
        <rect key={p.ts} x={M.left + i * bw + Math.min(1, bw * 0.15)} y={y(p.value)} width={Math.max(1, bw - Math.min(2, bw * 0.3))} height={Math.max(0, M.top + ih - y(p.value))} className={`bar${isPartial(p, full) ? ' partial' : ''}`}>
          <title>{`${fmtTick(p.ts, interval)}: ${p.value} ${unit}${isPartial(p, full) ? ` (partial: ${p.samples} of ${full} readings)` : ''}`}</title>
        </rect>
      ))}
      {labelIdx.map((i, k) => (
        <text key={i} x={M.left + i * bw + bw / 2} y={H - 10} textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'} className="axis">{fmtTick(points[i].ts, interval)}</text>
      ))}
    </svg>
    {anyPartial && <p className="muted small">Lighter bars are partial intervals (fewer readings than a full one), e.g. today so far.</p>}
    </>
  );
}
