import { useState } from 'react';
import { useApi } from '../api.js';
import { ErrorBox, Loading, Pager, Status } from './ui.jsx';

export function MeterTable({ params, onSelect, selected }) {
  const [offset, setOffset] = useState(0);
  const key = JSON.stringify(params);
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) { setLastKey(key); setOffset(0); } // new filters -> back to page 1
  const { data, error, loading } = useApi('/meters', { ...params, limit: 25, offset });
  return (
    <>
      <ErrorBox error={error} />
      {loading && !data && <Loading what="Loading meters" />}
      {data && (
        <>
          <div className="scroll">
            <table>
              <thead><tr><th>Meter</th><th>Status</th><th>Type</th><th className="hide-sm">Serial</th><th className="hide-sm">Located</th></tr></thead>
              <tbody>
                {data.data.map((m) => (
                  <tr key={m.id} className={m.id === selected ? 'sel' : ''} onClick={() => onSelect(m.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect(m.id)}>
                    <td><b>{m.id}</b><br /><span className="muted small">{m.name}</span></td>
                    <td><Status value={m.status} /></td>
                    <td>{m.type ?? '–'}</td>
                    <td className="hide-sm">{m.serialNumber ?? '–'}</td>
                    <td className="hide-sm">{m.location ? '✓' : <span className="warn">no</span>}</td>
                  </tr>
                ))}
                {!data.data.length && <tr><td colSpan="5" className="muted">No meters match these filters.</td></tr>}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} onChange={setOffset} />
        </>
      )}
    </>
  );
}

export default function Meters({ onSelect, selected }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [tariff, setTariff] = useState('');
  const params = { q, status, type, 'attr.tariffCategory': tariff };
  return (
    <>
      <div className="filters">
        <input type="search" placeholder="Search id, name or serial…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option><option>active</option><option>inactive</option><option>fault</option><option>unknown</option>
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
          <option value="">Any type</option><option>single-phase</option><option>three-phase</option>
        </select>
        <select value={tariff} onChange={(e) => setTariff(e.target.value)} aria-label="Tariff category">
          <option value="">Any tariff</option><option>residential</option><option>commercial</option><option>industrial</option>
        </select>
      </div>
      <MeterTable params={params} onSelect={onSelect} selected={selected} />
    </>
  );
}
