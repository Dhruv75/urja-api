import { useState } from 'react';
import { ISSUE_LABELS, useApi } from '../api.js';
import { ErrorBox, Loading } from './ui.jsx';
import { MeterTable } from './Meters.jsx';

function TreeNode({ node, picked, onPick, level = 0 }) {
  const [open, setOpen] = useState(level < 1);
  const has = node.children.length > 0;
  return (
    <li>
      <div className={`node ${picked === node.id ? 'sel' : ''}`}>
        <button className="caret" onClick={() => setOpen(!open)} disabled={!has} aria-label={open ? 'Collapse' : 'Expand'}>{has ? (open ? '▾' : '▸') : '·'}</button>
        <button className="link grow" onClick={() => onPick(node.id)}>
          {node.name ?? node.id} <span className="pill">{node.level ?? `level ${node.depth}`}</span>
        </button>
        {node.issues.map((c) => <span key={c} className="pill warnpill" title={ISSUE_LABELS[c] ?? c}>⚠ {c}</span>)}
        <span className="muted small">{node.meterCount}</span>
      </div>
      {open && has && <ul className="tree">{node.children.map((c) => <TreeNode key={c.id} node={c} picked={picked} onPick={onPick} level={level + 1} />)}</ul>}
    </li>
  );
}

function NodePanel({ nodeId, onSelectMeter, selectedMeter }) {
  const { data, error } = useApi(`/hierarchy/${encodeURIComponent(nodeId)}`);
  const n = data?.data;
  return (
    <div>
      <ErrorBox error={error} />
      {n && (
        <>
          <h3>{n.name ?? n.id}</h3>
          <p className="muted small">
            {n.ancestors.map((a) => a.name ?? a.id).join(' › ') || 'Top level'} · {n.meterCount} meters in subtree ({n.directMeterCount} direct)
          </p>
          {n.issues.length > 0 && <p className="warn small">{n.issues.map((c) => ISSUE_LABELS[c] ?? c).join('; ')}</p>}
        </>
      )}
      <MeterTable params={{ nodeId }} onSelect={onSelectMeter} selected={selectedMeter} />
    </div>
  );
}

export default function Network({ picked, onPick, onSelectMeter, selectedMeter }) {
  const { data, error, loading } = useApi('/hierarchy');
  return (
    <div className="split">
      <div>
        <ErrorBox error={error} />
        {loading && <Loading what="Loading hierarchy" />}
        {data && (
          <>
            <ul className="tree root">{data.data.roots.map((r) => <TreeNode key={r.id} node={r} picked={picked} onPick={onPick} />)}</ul>
            {data.data.unplacedMeters > 0 && <p className="warn small">{data.data.unplacedMeters} meters could not be placed in the hierarchy (see Overview › data quality).</p>}
          </>
        )}
      </div>
      <div>{picked ? <NodePanel nodeId={picked} onSelectMeter={onSelectMeter} selectedMeter={selectedMeter} /> : <p className="muted">Pick a node to see its meters.</p>}</div>
    </div>
  );
}
