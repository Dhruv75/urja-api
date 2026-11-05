import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { ErrorBox, Loading } from './ui.jsx';

const W = 680;
const H = 440;
const PAD = 24;
const COLORS = { active: 'var(--ok)', inactive: 'var(--muted)', fault: 'var(--bad)', unknown: 'var(--warn)' };

/** All located meters, paged through the API (max 200 per page). */
async function loadAll() {
  const all = [];
  for (let offset = 0; ; offset += 200) {
    const r = await api('/meters', { hasLocation: 'true', limit: 200, offset });
    all.push(...r.data);
    if (offset + 200 >= r.page.total || offset > 20_000) return all;
  }
}

export default function MapView({ onSelect, selected }) {
  const [meters, setMeters] = useState(null);
  const [error, setError] = useState(null);
  const [hover, setHover] = useState(null);
  useEffect(() => { loadAll().then(setMeters).catch(setError); }, []);

  const view = useMemo(() => {
    if (!meters?.length) return null;
    const lats = meters.map((m) => m.location.lat);
    const lons = meters.map((m) => m.location.lon);
    const [minLat, maxLat, minLon, maxLon] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
    const cos = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
    const spanX = Math.max((maxLon - minLon) * cos, 1e-6);
    const spanY = Math.max(maxLat - minLat, 1e-6);
    const k = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
    return { x: (lon) => PAD + (lon - minLon) * cos * k, y: (lat) => H - PAD - (lat - minLat) * k, minLat, maxLat, minLon, maxLon };
  }, [meters]);

  if (error) return <ErrorBox error={error} />;
  if (!meters) return <Loading what="Loading meter locations" />;
  if (!view) return <p className="muted">No meters have usable coordinates.</p>;
  const counts = meters.reduce((acc, m) => ({ ...acc, [m.status]: (acc[m.status] ?? 0) + 1 }), {});
  const h = hover && meters.find((m) => m.id === hover);
  return (
    <div>
      <p className="legend">
        {Object.entries(counts).map(([s, n]) => <span key={s}><i style={{ background: COLORS[s] ?? COLORS.unknown }} /> {s} {n}</span>)}
        <span className="muted small">Positions only; no basemap tiles are loaded.</span>
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="map" role="img" aria-label="Meter locations">
        <rect x="0.5" y="0.5" width={W - 1} height={H - 1} className="frame" />
        {meters.map((m) => (
          <circle key={m.id} cx={view.x(m.location.lon)} cy={view.y(m.location.lat)} r={m.id === selected ? 7 : 4} fill={COLORS[m.status] ?? COLORS.unknown} className={`dot ${m.id === selected ? 'sel' : ''}`}
            onMouseEnter={() => setHover(m.id)} onMouseLeave={() => setHover(null)} onClick={() => onSelect(m.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect(m.id)}>
            <title>{`${m.id} (${m.status})`}</title>
          </circle>
        ))}
        <text x={PAD} y={H - 6} className="axis">{view.minLon.toFixed(3)}°E</text>
        <text x={W - PAD} y={H - 6} textAnchor="end" className="axis">{view.maxLon.toFixed(3)}°E</text>
        <text x={4} y={PAD - 8} className="axis">{view.maxLat.toFixed(3)}°N</text>
      </svg>
      <p className="muted small">{h ? `${h.id} · ${h.name ?? ''} · ${h.status}` : `${meters.length} meters with usable coordinates. Click a dot for details.`}</p>
    </div>
  );
}
