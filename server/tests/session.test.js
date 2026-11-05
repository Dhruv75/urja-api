import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startFakePortal } from './_fakePortal.js';
import { PortalSession } from '../src/portal/session.js';
import { CookieJar } from '../src/portal/cookieJar.js';
import { PortalAuthError, PortalHttpError, PortalUnavailableError } from '../src/errors.js';

let portal;
let delays;
before(async () => { portal = await startFakePortal(); });
after(() => portal.close());
beforeEach(() => {
  Object.assign(portal.state, { sessions: new Set(), loginPosts: 0, dataHits: 0, failNext: 0, authStyle: 'redirect', paths: [], unauthDelays: [] });
  delays = [];
});

const make = (over = {}) =>
  new PortalSession(
    { baseUrl: portal.baseUrl, username: 'tester@example.test', password: 'secret', loginPath: '/login', timeoutMs: 2000, maxRetries: 3, maxConcurrency: 2, minIntervalMs: 0, loginCooldownMs: 60_000, ...over },
    { sleep: async (ms) => { delays.push(ms); } },
  );

test('logs in through the form (hidden CSRF field echoed) and reads JSON', async () => {
  const s = make();
  assert.deepEqual(await s.getJson('/data'), { ok: true, n: 1 });
  assert.equal(s.stats.logins, 1);
  assert.ok(s.state().cookieNames.includes('sid'));
  assert.ok(!JSON.stringify(s.state()).includes('secret'), 'state must never expose the password');
});

test('is read-only: the only POST ever sent is the login form', async () => {
  const s = make();
  await s.getJson('/data');
  await s.getJson('/data');
  const posts = portal.state.paths.filter((p) => !p.startsWith('GET'));
  assert.deepEqual(posts, ['POST /login']);
});

for (const style of ['redirect', '401']) {
  test(`session expiry (${style}) is repaired transparently with one re-login`, async () => {
    portal.state.authStyle = style;
    const s = make();
    await s.getJson('/data');
    portal.state.sessions.clear(); // the portal forgets us
    assert.deepEqual(await s.getJson('/data'), { ok: true, n: 2 });
    assert.equal(s.stats.relogins, 1);
    assert.equal(portal.state.loginPosts, 2);
  });
}

test('many concurrent requests after expiry share a single login', async () => {
  const s = make({ maxConcurrency: 5 });
  await s.getJson('/data');
  portal.state.sessions.clear();
  const results = await Promise.all(Array.from({ length: 8 }, () => s.getJson('/data')));
  assert.equal(results.length, 8);
  assert.equal(portal.state.loginPosts, 2, 'initial login + exactly one re-login');
});

test('a late "session expired" answer does not tear down a session that was just renewed', async () => {
  const s = make({ maxConcurrency: 2 });
  await s.getJson('/data');
  portal.state.sessions.clear();
  portal.state.unauthDelays = [0, 250]; // request 1 learns of the expiry at once; request 2 only after request 1 has logged in again
  await Promise.all([s.getJson('/data'), s.getJson('/data')]);
  assert.equal(portal.state.loginPosts, 2, 'without the generation check this would be 3');
  assert.equal(s.stats.relogins, 1);
});

test('transient 503s are retried with backoff and Retry-After', async () => {
  const s = make();
  await s.getJson('/data');
  portal.state.failNext = 2;
  assert.equal((await s.getJson('/data')).ok, true);
  assert.equal(s.stats.retries, 2);
  assert.ok(delays.every((d) => d >= 1000), `Retry-After: 1 must be honoured, got ${delays}`);
});

test('gives up with PortalUnavailableError once retries are exhausted', async () => {
  const s = make({ maxRetries: 2 });
  await s.getJson('/data');
  portal.state.failNext = 99;
  await assert.rejects(() => s.getJson('/data'), PortalUnavailableError);
  assert.equal(s.stats.retries, 2);
});

test('wrong credentials: PortalAuthError, and the cooldown stops us hammering the login', async () => {
  const s = make({ password: 'wrong' });
  await assert.rejects(() => s.getJson('/data'), (e) => e instanceof PortalAuthError && /Invalid credentials/.test(e.message));
  await assert.rejects(() => s.getJson('/data'), PortalAuthError);
  await assert.rejects(() => s.getJson('/data'), PortalAuthError);
  assert.equal(portal.state.loginPosts, 1, 'only the first attempt reached the portal');
});

test('missing credentials fail fast without any network call', async () => {
  const s = make({ username: '', password: '' });
  await assert.rejects(() => s.getJson('/data'), PortalAuthError);
  assert.deepEqual(portal.state.paths, []);
});

test('never follows a redirect to another origin', async () => {
  const s = make();
  await s.getJson('/data');
  await assert.rejects(() => s.getText('/evil'), /another origin/);
});

test('HTTP errors surface as PortalHttpError with the status; refuses other origins', async () => {
  const s = make();
  await assert.rejects(() => s.getText('/missing'), (e) => e instanceof PortalHttpError && e.status === 404);
  await assert.rejects(() => s.get('http://evil.example/x'), /another origin/);
});

test('cookie jar: Max-Age, Expires, deletion', () => {
  let t = 1_000_000;
  const jar = new CookieJar(() => t);
  const resp = (...lines) => ({ headers: { getSetCookie: () => lines } });
  jar.store(resp('a=1; Path=/', 'b=2; Max-Age=10', `c=3; Expires=${new Date(t + 5000).toUTCString()}`));
  assert.equal(jar.header(), 'a=1; b=2; c=3');
  t += 6000;
  assert.equal(jar.header(), 'a=1; b=2');
  t += 5000;
  assert.equal(jar.header(), 'a=1');
  jar.store(resp('a=; Path=/'));
  assert.equal(jar.size, 0);
});
