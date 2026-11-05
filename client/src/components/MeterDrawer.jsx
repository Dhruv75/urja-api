import { Fragment, useState } from 'react';
import { api, fmtAge, useApi } from '../api.js';
import ConsumptionChart, { averageOfFull } from './ConsumptionChart.jsx';
import { ErrorBox, Loading, Status } from './ui.jsx';

const WINDOWS = { '24 h': { days: 1, interval: 'hour' }, '7 days': { days: 7, interval: 'hour' }, '30 days': { days: 30, interval: 'day' } };
const ISSUE_HINT = { no_location: 'no coordinates', invalid_location: 'unusable coordinates' };

function Consumption({ meterId }) {
  const [win, setWin] = useState('7 days');
  const [refreshing, setRefreshing] = useState(false);
  const { days, interval } = WINDOWS[win];
  // Windows end at the top of the current hour (the newest *complete* hour). The value is stable for the whole hour,
  // so re-renders don't refetch, and the server's cache sees the same window and can answer from MongoDB.
  const to = new Date();
  to.setMinutes(0, 0, 0);
  const params = { from: new Date(to.getTime() - days * 86_400_000).toISOString(), to: to.toISOString(), interval };
  const { data, error, loading, reload } = useApi(`/meters/${encodeURIComponent(meterId)}/consumption`, params);
  const refresh = async () => {
    setRefreshing(true);
    try { await api(`/meters/${encodeURIComponent(meterId)}/consumption`, { ...params, refresh: 'true' }); } finally { setRefreshing(false); reload(); }
  };
  const m = data?.meta;
  return (
    <section>
      <div className="row between">
        <h3>Consumption</h3>
        <div className="seg" role="group" aria-label="Window">
          {Object.keys(WINDOWS).map((w) => <button key={w} className={w === win ? 'on' : ''} onClick={() => setWin(w)}>{w}</button>)}
        </div>
      </div>
      <ErrorBox error={error} />
      {loading && !data ? <Loading what="Loading readings" /> : data && (
        <>
          <ConsumptionChart points={data.data.points} unit={data.data.unit} interval={interval} />
          <div className="stats">
            <div><b>{data.data.summary.total}</b><span>{data.data.unit} total</span></div>
            <div><b>{averageOfFull(data.data.points) ?? data.data.summary.average ?? '–'}</b><span>avg / full {interval}</span></div>
            <div><b>{data.data.summary.max ?? '–'}</b><span>peak</span></div>
          </div>
          <p className="muted small">
            {m.stale ? <span className="warn">Stale: </span> : null}
            {m.warning ?? `${m.servedFrom === 'cache' ? `Served from cache, ${fmtAge(m.ageSeconds)} old` : `Fetched just now from the ${m.source}`} (${m.cacheDecision.replace('_', ' ')}).`}{' '}
            <button className="link" onClick={refresh} disabled={refreshing}>{refreshing ? 'Asking the portal…' : 'Refresh from portal'}</button>
          </p>
        </>
      )}
    </section>
  );
}

function Nearby({ meter, onSelect }) {
  const loc = meter.location;
  const { data } = useApi('/meters/nearby', { lat: loc?.lat, lon: loc?.lon, radiusM: 500, limit: 6 }, Boolean(loc));
  if (!loc) return <p className="muted small">No usable coordinates, so no neighbours to show.</p>;
  const others = (data?.data ?? []).filter((m) => m.id !== meter.id);
  return (
    <ul className="plain">
      {others.map((m) => <li key={m.id}><button className="link" onClick={() => onSelect(m.id)}>{m.id}</button> <Status value={m.status} /> <span className="muted small">{Math.round(m.distanceM)} m</span></li>)}
      {data && !others.length && <li className="muted small">No other meters within 500 m.</li>}
    </ul>
  );
}

export default function MeterDrawer({ meterId, onClose, onSelect, onNode }) {
  const { data, error, loading } = useApi(`/meters/${encodeURIComponent(meterId)}`);
  const m = data?.data;
  return (
    <aside className="drawer" aria-label="Meter details">
      <div className="row between">
        <h2>{meterId}</h2>
        <button onClick={onClose} aria-label="Close">✕</button>
      </div>
      <ErrorBox error={error} />
      {loading && <Loading />}
      {m && (
        <>
          <p>{m.name} · <Status value={m.status} /> {m.type && <span className="pill">{m.type}</span>}</p>
          <nav className="crumbs" aria-label="Position in the network">
            {m.hierarchyPath.length ? m.hierarchyPath.map((n, i) => (
              <span key={n.id}>{i > 0 && ' › '}<button className="link" onClick={() => onNode(n.id)}>{n.name ?? n.id}</button></span>
            )) : <span className="warn">Not placed in the network hierarchy</span>}
          </nav>
          {m.dataQuality.length > 0 && <p className="warn small">Data quality: {m.dataQuality.map((c) => ISSUE_HINT[c] ?? c).join(', ')}</p>}
          <Consumption meterId={m.id} />
          <section>
            <h3>Details</h3>
            <dl className="kv">
              <dt>Serial</dt><dd>{m.serialNumber ?? '–'}</dd>
              <dt>Location</dt><dd>{m.location ? `${m.location.lat.toFixed(5)}, ${m.location.lon.toFixed(5)}` : '–'}</dd>
              {Object.entries(m.attributes).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{String(v)}</dd></Fragment>)}
            </dl>
          </section>
          <section>
            <h3>Nearby (500 m)</h3>
            <Nearby meter={m} onSelect={onSelect} />
          </section>
        </>
      )}
    </aside>
  );
}
