// UI smoke test: renders the real React app in jsdom against the real API + a MongoDB-compatible database,
// then clicks through every tab. Fails on any console.error (React key/hook warnings included).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverSrc = (f) => import(pathToFileURL(path.resolve(root, '../server/src', f)).href);
const MONGO = process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017';

let skip = false;
let db;
try {
  db = await serverSrc('db/models.js');
  await db.connectDb(MONGO, { dbName: `urja_ui_${process.pid}` });
} catch {
  skip = 'MongoDB is not reachable (set MONGODB_URI_TEST, or run `docker compose up -d mongo`)';
}

test('the UI renders real API data on every tab and survives interaction', { skip }, async (t) => {
  const { createApp } = await serverSrc('app.js');
  const { loadConfig } = await serverSrc('config.js');
  const { createLogger } = await serverSrc('log.js');
  const { FixtureSource } = await serverSrc('portal/fixture.js');
  const { createSyncService } = await serverSrc('services/syncService.js');
  const { createConsumptionService } = await serverSrc('services/consumptionService.js');

  const log = createLogger('silent');
  const config = loadConfig({ SYNC_ON_START: 'false' });
  const source = new FixtureSource();
  const sync = createSyncService({ source, log, config });
  const app = createApp({ config, source, sync, consumption: createConsumptionService({ source, log, config }), log, clientDir: '/nonexistent' });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  await sync.sync();

  // ---- a browser-ish environment ----
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: base, pretendToBeVisual: true });
  const realFetch = globalThis.fetch;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: false }); // real network + real timers, so no act()
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.fetch = (u, init) => realFetch(typeof u === 'string' && u.startsWith('/') ? base + u : u, init);
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' ').slice(0, 300));

  const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true } });
  try {
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { default: App } = await vite.ssrLoadModule('/src/App.jsx');

    const q = (sel) => document.querySelector(sel);
    const qa = (sel) => [...document.querySelectorAll(sel)];
    const text = () => document.body.textContent;
    const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
    const click = async (el) => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); await tick(); }; // works for SVG too, which has no .click()
    const waitFor = async (fn, label, timeout = 10_000) => {
      const t0 = Date.now();
      for (;;) {
        let v = false;
        try { v = fn(); } catch { /* not there yet */ }
        if (v) return v;
        if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for: ${label}\nDOM text: ${text().slice(0, 500)}`);
        await tick();
      }
    };
    const tab = (name) => qa('nav.tabs button').find((b) => b.textContent === name);

    createRoot(q('#root')).render(React.createElement(App));

    await t.test('Overview: counts, demo-data banner, data-quality list', async () => {
      await waitFor(() => qa('.card b').map((e) => e.textContent).includes('172'), 'meter count card');
      await waitFor(() => /Demo data/.test(text()), 'demo-data banner (App-level health request)');
      assert.deepEqual(qa('.card b').map((e) => e.textContent).slice(0, 2), ['172', '30']);
      await waitFor(() => /Parent cycle \(broken automatically\)/.test(text()), 'data-quality labels');
      await click(qa('.codes button.link').find((b) => /Parent cycle/.test(b.textContent)));
      await waitFor(() => /FD-CYC-A/.test(q('.issues')?.textContent ?? ''), 'cycle issue detail');
    });

    await t.test('Meters: table, search filter, drawer with chart and window switch', async () => {
      await click(tab('Meters'));
      await waitFor(() => qa('tbody tr').length === 25, '25 meter rows');
      assert.match(q('.pager').textContent, /1–25 of 172/);
      const search = q('input[type=search]');
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(search, 'MTR-000001');
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await waitFor(() => qa('tbody tr').length >= 1 && qa('tbody tr').length < 25 && /MTR-000001/.test(q('tbody').textContent), 'filtered rows');
      await click(qa('tbody tr')[0]);
      await waitFor(() => qa('.drawer .chart .bar').length >= 160, 'hourly bars for 7 days');
      assert.match(q('.drawer').textContent, /Substation 1/);
      assert.match(q('.drawer').textContent, /Fetched just now from the fixture/);
      await click(qa('.seg button').find((b) => b.textContent === '30 days'));
      await waitFor(() => { const n = qa('.drawer .chart .bar').length; return n >= 28 && n <= 32; }, 'daily bars for 30 days');
      await waitFor(() => /(Served from cache|Fetched just now from the fixture)/.test(q('.drawer').textContent), 'freshness note');
      await waitFor(() => qa('.drawer ul.plain li').length > 0, 'nearby meters');
      await click(q('.drawer button[aria-label=Close]'));
      assert.equal(q('.drawer'), null);
    });

    await t.test('Network: tree with issue badges, node panel lists its meters', async () => {
      await click(tab('Network'));
      await waitFor(() => /Substation 1/.test(q('ul.tree.root')?.textContent ?? ''), 'tree');
      assert.ok(qa('.warnpill').length >= 3, 'orphan / cycle / self-parent badges are shown');
      assert.match(text(), /2 meters could not be placed/);
      await click(qa('.node button.link').find((b) => /Substation 1/.test(b.textContent)));
      await waitFor(() => /meters in subtree/.test(text()) && qa('tbody tr').length === 25, 'node panel with meters');
    });

    await t.test('Map: one dot per located meter; clicking a dot opens its drawer', async () => {
      await click(tab('Map'));
      await waitFor(() => qa('circle.dot').length === 168, '168 dots');
      await click(qa('circle.dot')[0]);
      await waitFor(() => q('.drawer'), 'drawer from map');
    });

    assert.deepEqual(errors, [], `console.error was called:\n${errors.join('\n')}`);
  } finally {
    console.error = realError;
    globalThis.fetch = realFetch;
    await vite.close();
    server.close();
    dom.window.close();
  }
});

test.after(async () => {
  if (!skip) { await db.Meter.db.dropDatabase(); await db.disconnectDb(); }
});
