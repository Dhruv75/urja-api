import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { explore, urlShape, endpointCandidates, describeJson } from '../scripts/explore.mjs';

const PASSWORD = 'S3cret-pw!';
const SID = 'sid-abcdef-123456';

// A fake portal with traps: destructive-looking links, a mutating endpoint named in JS, a cross-origin link.
async function startPortal() {
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    state.requests.push(`${req.method} ${req.url}`);
    const authed = (req.headers.cookie ?? '').includes(`sid=${SID}`);
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html', ...headers }); res.end(body); };
    const json = (obj) => send(200, JSON.stringify(obj), { 'content-type': 'application/json' });
    const [pathname] = req.url.split('?');
    if (pathname === '/login' && req.method === 'GET') return send(200, '<form method="post" action="/login"><input type="hidden" name="_token" value="abc123"><input type="email" name="email"><input type="password" name="password"></form>');
    if (pathname === '/login' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      return req.on('end', () => {
        const f = new URLSearchParams(raw);
        if (f.get('email') === 'op@urja.local' && f.get('password') === PASSWORD && f.get('_token') === 'abc123') return send(302, '', { location: '/home', 'set-cookie': `sid=${SID}; HttpOnly; Path=/` });
        return send(200, '<div class="error">Invalid credentials</div><form><input type="password" name="password"></form>');
      });
    }
    if (!authed) return send(302, '', { location: '/login' });
    if (pathname === '/') return send(302, '', { location: '/home' });
    if (pathname === '/home') return send(200, `<title>Home</title><h1>Ops</h1>
      <a href="/meters">Meters</a> <a href="/meters?page=2">next</a> <a href="/hierarchy">Network</a>
      <a href="/export/meters.csv">Download CSV</a> <a href="/logout">Sign out</a> <a href="/admin/delete-all">Delete everything</a>
      <a href="https://example.com/elsewhere">external</a> <script src="/static/app.js"></script>
      <script>fetch('/api/summary').then(r => r.json())</script>`);
    if (pathname === '/meters') return send(200, `<title>Meters</title><table><thead><tr><th>ID</th><th>Status</th></tr></thead><tbody>
      ${[1, 2, 3, 4, 5].map((i) => `<tr><td><a href="/meters/MTR-${i}">MTR-${i}</a></td><td>active</td></tr>`).join('')}</tbody></table>`);
    if (pathname.startsWith('/meters/')) return send(200, `<title>${pathname}</title><dl><dt>Feeder</dt><dd>F-1</dd></dl>`);
    if (pathname === '/hierarchy') return send(200, '<title>Network</title><ul><li>SS-1</li></ul>');
    if (pathname === '/export/meters.csv') return send(200, 'id,status\nMTR-1,active\n', { 'content-type': 'text/csv' });
    if (pathname === '/static/app.js') return send(200, `fetch("/api/meters?limit=50"); fetch("/api/sync", { method: "POST" }); axios.delete("/api/meters/1"); const u = "/api/consumption/" + id;`, { 'content-type': 'application/javascript' });
    if (pathname === '/api/meters') return json({ items: [{ id: 'MTR-1', status: 'active' }], total: 1 });
    if (pathname === '/api/summary') return json({ meters: 5, feeders: 2 });
    if (pathname === '/api/consumption/') return send(404, 'not found');
    return send(404, 'nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { state, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const readAll = async (dir) => {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out.push(await fs.readFile(path.join(e.parentPath ?? e.path, e.name), 'utf8'));
  return out.join('\n');
};

test('explorer: logs in, crawls politely, never touches destructive links, never sends anything but GET (and the login POST)', async () => {
  const portal = await startPortal();
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'explore-'));
  try {
    const r = await explore({ baseUrl: portal.baseUrl, username: 'op@urja.local', password: PASSWORD, outDir, sleep: async () => {}, log: () => {} });
    assert.equal(r.login.ok, true);
    assert.deepEqual(r.requestAudit.nonGet, ['POST /login']);

    const hit = portal.state.requests.join('\n');
    assert.ok(!/logout|delete-all|\/api\/sync/.test(hit), `destructive-looking URL was requested:\n${hit}`);
    assert.ok(!portal.state.requests.some((q) => /^(PUT|DELETE|PATCH|HEAD|OPTIONS)/.test(q)));
    assert.ok(!hit.includes('example.com'));
    assert.equal(portal.state.requests.filter((q) => q.startsWith('POST')).length, 1);

    const detailPages = r.pages.filter((p) => p.shape === '/meters/MTR-{n}');
    assert.equal(detailPages.length, 3, 'at most 3 samples per URL shape');
    const list = r.pages.find((p) => p.url === '/meters');
    assert.deepEqual(list.tables[0].headers, ['ID', 'Status']);
    assert.equal(list.tables[0].rowCount, 5);
    assert.deepEqual(list.tables[0].rows[0], ['MTR-1', 'active']);

    assert.ok(r.skipped.some((s) => s.url === '/logout') && r.skipped.some((s) => s.url === '/admin/delete-all'));
    assert.ok(r.exportLinks.some((l) => l.url === '/export/meters.csv'));
    assert.ok(r.paginationLinks.some((l) => l.url === '/meters?page=2'));
    assert.ok(r.probes.some((p) => p.path === '/api/meters?limit=50' && /items: array\(1\)/.test(p.shape)));
    assert.ok(r.probes.some((p) => p.path === '/api/summary'), 'inline-script endpoint was probed with GET');
    assert.ok(r.notProbed.some((c) => c.method === 'POST' && c.path === '/api/sync'));
    assert.ok(r.notProbed.some((c) => c.method === 'DELETE' && c.path === '/api/meters/1'));
    assert.ok(!portal.state.requests.includes('GET /api/meters/1'), 'a path the JS uses with DELETE must never be fetched with GET either');

    const summary = await fs.readFile(path.join(outDir, 'SUMMARY.md'), 'utf8');
    assert.match(summary, /LOGGED IN/);
    assert.match(summary, /Non-GET requests: POST \/login/);
    assert.match(summary, /\/api\/sync/);

    const everything = await readAll(outDir);
    assert.ok(!everything.includes(PASSWORD), 'the password must never be written to disk');
    assert.ok(!everything.includes(SID), 'session cookie values must never be written to disk');
  } finally {
    await portal.close();
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test('explorer: a rejected login is reported with the portal\'s own message, and the run still completes', async () => {
  const portal = await startPortal();
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'explore-'));
  try {
    const r = await explore({ baseUrl: portal.baseUrl, username: 'op@urja.local', password: 'wrong-password', outDir, sleep: async () => {}, log: () => {} });
    assert.equal(r.login.ok, false);
    assert.match(r.login.errorHint, /Invalid credentials/);
    assert.equal(r.requestAudit.nonGet.length, 1);
    assert.ok(!(await readAll(outDir)).includes('wrong-password'));
  } finally {
    await portal.close();
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test('explorer helpers: URL shapes, endpoint discovery, JSON description', () => {
  assert.equal(urlShape('https://x.test/meters/MTR-000123?page=2&sort=id'), '/meters/MTR-{n}?page&sort');
  assert.equal(urlShape('https://x.test/a/3f2b8c1e-aaaa-bbbb-cccc-1234567890ab/b'), '/a/{uuid}/b');
  const found = endpointCandidates(`fetch('/api/a'); fetch("/api/b", {method: 'post'}); axios.get('/x/y'); $.getJSON('/v1/z'); xhr.open("GET", "/svc/q"); const s = "/api/lit/1"; fetch('//evil/x'); fetch('/logo.png')`);
  const keys = found.map((c) => `${c.method ?? '?'} ${c.path}`).sort();
  assert.deepEqual(keys, ['GET /api/a', 'GET /svc/q', 'GET /v1/z', 'GET /x/y', 'POST /api/b', '? /api/lit/1'].sort());
  assert.equal(describeJson({ a: [{ b: 1 }], c: null, d: 'x' }), '{ a: array(1) of { b: number }, c: null, d: string }');
});
