// A throwaway HTTP server that behaves like a typical legacy cookie-session portal.
// It is a TEST DOUBLE for the session mechanics, not a description of the real Urja portal.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const LOGIN_HTML = (error = '') => `<html><body><h1>Sign in</h1>${error ? `<div class="error">${error}</div>` : ''}
<form method="post" action="/login"><input type="hidden" name="csrf_token" value="tok-123">
<input type="email" name="email"><input type="password" name="password"><button type="submit">Sign in</button></form></body></html>`;

export async function startFakePortal() {
  const state = { sessions: new Set(), loginPosts: 0, dataHits: 0, failNext: 0, authStyle: 'redirect', paths: [], unauthDelays: [] };
  const server = http.createServer((req, res) => {
    state.paths.push(`${req.method} ${req.url}`);
    const cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').filter(Boolean).map((c) => c.trim().split(/=(.*)/s).slice(0, 2)));
    const authed = state.sessions.has(cookies.sid);
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html', ...headers }); res.end(body); };

    if (req.url === '/login' && req.method === 'GET') return send(200, LOGIN_HTML(), { 'set-cookie': 'pre=1; Path=/' });
    if (req.url === '/login' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      return req.on('end', () => {
        state.loginPosts += 1;
        const f = new URLSearchParams(raw);
        if (f.get('email') === 'tester@example.test' && f.get('password') === 'secret' && f.get('csrf_token') === 'tok-123') {
          const sid = randomUUID();
          state.sessions.add(sid);
          return send(302, '', { location: '/home', 'set-cookie': `sid=${sid}; HttpOnly; Path=/` });
        }
        return send(200, LOGIN_HTML('Invalid credentials'));
      });
    }
    if (req.url === '/evil') return send(302, '', { location: 'http://example.invalid/steal' });
    if (!authed) {
      // unauthDelays lets a test make one "session expired" answer arrive late, after another request already re-logged in
      const answer = () => (state.authStyle === '401' ? send(401, 'no session') : send(302, '', { location: '/login' }));
      const delay = state.unauthDelays.shift() ?? 0;
      return delay ? setTimeout(answer, delay) : answer();
    }
    if (req.url === '/home') return send(200, '<h1>Home</h1>');
    if (req.url.startsWith('/data')) {
      if (state.failNext > 0) { state.failNext -= 1; return send(503, 'busy', { 'retry-after': '1' }); }
      state.dataHits += 1;
      return send(200, JSON.stringify({ ok: true, n: state.dataHits }), { 'content-type': 'application/json' });
    }
    if (req.url === '/missing') return send(404, 'nope');
    return send(404, 'nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { state, baseUrl, close: () => new Promise((r) => server.close(r)) };
}
