import { useState } from 'react';
import MapView from './components/MapView.jsx';
import MeterDrawer from './components/MeterDrawer.jsx';
import Meters from './components/Meters.jsx';
import Network from './components/Network.jsx';
import Overview from './components/Overview.jsx';
import { useApi } from './api.js';

const TABS = ['Overview', 'Meters', 'Network', 'Map'];

export default function App() {
  const [tab, setTab] = useState('Overview');
  const [meterId, setMeterId] = useState(null);
  const [nodeId, setNodeId] = useState(null);
  const health = useApi('/health');
  const mode = health.data?.source.mode;

  const selectMeter = (id) => setMeterId(id);
  const pickNode = (id) => { setNodeId(id); setTab('Network'); };

  return (
    <div className={`app ${meterId ? 'with-drawer' : ''}`}>
      <header>
        <h1>⚡ Urja Meter Ops</h1>
        <span className="muted small">read-only view over the portal</span>
      </header>
      {mode === 'fixture' && <div className="banner" role="status"><b>Demo data.</b> This is a synthetic fixture; the real portal is not connected.</div>}
      {health.error && <div className="banner bad" role="alert">Cannot reach the API: {health.error.message}</div>}
      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => <button key={t} className={t === tab ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}
      </nav>
      <main>
        {tab === 'Overview' && <Overview onSelectMeter={selectMeter} onPickNode={pickNode} />}
        {tab === 'Meters' && <Meters onSelect={selectMeter} selected={meterId} />}
        {tab === 'Network' && <Network picked={nodeId} onPick={setNodeId} onSelectMeter={selectMeter} selectedMeter={meterId} />}
        {tab === 'Map' && <MapView onSelect={selectMeter} selected={meterId} />}
      </main>
      {meterId && <MeterDrawer key={meterId} meterId={meterId} onClose={() => setMeterId(null)} onSelect={selectMeter} onNode={pickNode} />}
    </div>
  );
}
