import { useState } from 'react';
import { api, fmtAge, fmtDate, ISSUE_LABELS, useApi } from '../api.js';
import { ErrorBox, Loading } from './ui.jsx';

function Issues({ code, onSelectMeter, onPickNode }) {
  const { data, error } = useApi('/data-quality', { code, limit: 30 });
  return (
    <div className="issues">
      <ErrorBox error={error} />
      {data && (
        <ul className="plain">
          {data.data.map((i) => (
            <li key={`${i.kind}${i.refId}${i.message}`}>
              <button className="link" onClick={() => (i.kind === 'meter' ? onSelectMeter(i.refId) : onPickNode(i.refId))} disabled={!i.refId || i.refId.startsWith('#')}>{i.refId ?? '(no id)'}</button>{' '}
              <span className="muted small">{i.message}</span>
            </li>
          ))}
          {data.page.total > data.data.length && <li className="muted small">…and {data.page.total - data.data.length} more (use GET /api/v1/data-quality?code={code}).</li>}
        </ul>
      )}
    </div>
  );
}

export default function Overview({ onSelectMeter, onPickNode }) {
  const health = useApi('/health');
  const quality = useApi('/data-quality', { limit: 1 });
  const [open, setOpen] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);

  const resync = async () => {
    setSyncing(true);
    setSyncError(null);
    try { await api('/sync', { wait: 'true' }, { method: 'POST' }); } catch (e) { setSyncError(e); } finally { setSyncing(false); health.reload(); quality.reload(); }
  };

  const h = health.data;
  const counts = h?.index.sync.counts;
  return (
    <div className="stack">
      <ErrorBox error={health.error} />
      {health.loading && !h && <Loading />}
      {h && (
        <section className="cards">
          <div className="card"><span className="muted small">Meters</span><b>{counts?.meters ?? '–'}</b></div>
          <div className="card"><span className="muted small">Network nodes</span><b>{counts?.nodes ?? '–'}</b></div>
          <div className="card"><span className="muted small">Index age</span><b>{fmtAge(h.index.ageSeconds)}</b><span className={`small ${h.index.stale ? 'warn' : 'muted'}`}>{h.index.stale ? 'stale' : 'fresh'}</span></div>
          <div className="card"><span className="muted small">Data-quality issues</span><b>{counts?.issues ?? '–'}</b></div>
        </section>
      )}
      {h && (
        <p className="muted small">
          Source: <b>{h.source.mode}</b> · last synced {fmtDate(h.index.sync.lastSuccessAt)} ({h.index.sync.durationMs ?? '–'} ms) · API v{h.version}{' '}
          <button className="link" onClick={resync} disabled={syncing}>{syncing ? 'Syncing…' : 'Re-sync from source'}</button>
        </p>
      )}
      <ErrorBox error={syncError} />
      {h?.index.sync.status === 'error' && <ErrorBox error={{ code: 'last sync failed', message: h.index.sync.error }} />}

      <section>
        <h3>Data quality</h3>
        <p className="muted small">The portal's data is not always consistent. Instead of failing or silently hiding it, the API repairs what it safely can and reports everything here.</p>
        <ErrorBox error={quality.error} />
        {quality.data && (
          <ul className="plain codes">
            {Object.entries(quality.data.summary).map(([code, n]) => (
              <li key={code}>
                <button className="link" onClick={() => setOpen(open === code ? null : code)}><b>{n}</b> × {ISSUE_LABELS[code] ?? code} <span className="muted small">({code})</span></button>
                {open === code && <Issues code={code} onSelectMeter={onSelectMeter} onPickNode={onPickNode} />}
              </li>
            ))}
            {!Object.keys(quality.data.summary).length && <li className="muted">No issues found.</li>}
          </ul>
        )}
      </section>
    </div>
  );
}
