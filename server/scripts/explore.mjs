#!/usr/bin/env node
// Read-only explorer for the Urja Meter Ops portal.
//
//   PORTAL_USERNAME=... PORTAL_PASSWORD=... npm run explore
//
// It behaves like a polite logged-in user clicking around:
//   * the ONLY non-GET request is submitting the login form;
//   * it follows the portal's own same-origin links and never anything that looks destructive (logout, delete, reset...);
//   * it does not submit any other form and does not guess URLs: endpoints mentioned in the portal's JavaScript are
//     listed, and only the harmless-looking ones are fetched (GET), up to a small cap;
//   * delay between requests, capped page count, at most N samples per URL "shape".
// Output goes to ./capture (git-ignored). Read capture/SUMMARY.md first. It contains no passwords or cookie values, but
// the raw pages may contain real data: review before sharing.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as cheerio from 'cheerio';
import { CookieJar } from '../src/portal/cookieJar.js';

const DENY = /(logout|log-out|signout|sign-out|delete|remove|destroy|reset|disable|purge|truncate|unsubscribe|revoke)/i;
const DENY_PROBE = /(sync|refresh|update|create|import|upload|save|submit|add|edit|set|enable|run|start|stop|send|trigger|reload)/i;
const ASSET = /\.(css|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|map|mp4|pdf|zip)(\?|$)/i;
const EXPORT_HINT = /(export|download|csv|xlsx?|bulk|\.json|dump)/i;
const PAGINATION_HINT = /[?&](page|p|offset|cursor|start|skip|limit|per_?page)=/i;
const UA = 'urja-api-explorer/0.1 (read-only)';
const MAX_BODY = 300_000;

export const urlShape = (u) => {
  const x = new URL(u);
  const segs = x.pathname.split('/').map((s) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? '{uuid}' : s.replace(/\d+/g, '{n}')));
  const names = [...new Set([...x.searchParams.keys()])].sort();
  return segs.join('/') + (names.length ? `?${names.join('&')}` : '');
};

export function describeJson(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? `array(${v.length}) of ${describeJson(v[0], depth + 1)}` : 'array(0)';
  if (typeof v === 'object') return depth >= 3 ? 'object{...}' : `{ ${Object.entries(v).slice(0, 25).map(([k, x]) => `${k}: ${describeJson(x, depth + 1)}`).join(', ')} }`;
  return typeof v;
}

/** Finds URL-looking strings in JavaScript source: fetch()/axios/$.ajax/XHR calls and "/api/..." literals. */
export function endpointCandidates(js) {
  const found = new Map();
  const add = (p, via, method) => {
    if (!p.startsWith('/') || p.startsWith('//') || ASSET.test(p)) return;
    const key = `${method ?? '?'} ${p}`;
    if (!found.has(key)) found.set(key, { path: p, method: method ?? null, via });
  };
  for (const m of js.matchAll(/fetch\(\s*["'`]([^"'`]+)["'`]\s*(?:,\s*\{[^}]*?method\s*:\s*["'`](\w+)["'`])?/g)) add(m[1], 'fetch', m[2]?.toUpperCase() ?? 'GET');
  for (const m of js.matchAll(/axios\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g)) add(m[2], 'axios', m[1].toUpperCase());
  for (const m of js.matchAll(/\$\.(get|getJSON|post)\(\s*["'`]([^"'`]+)["'`]/g)) add(m[2], 'jquery', m[1] === 'post' ? 'POST' : 'GET');
  for (const m of js.matchAll(/\.open\(\s*["'](GET|POST|PUT|DELETE|PATCH)["']\s*,\s*["'`]([^"'`]+)["'`]/g)) add(m[2], 'xhr', m[1]);
  for (const m of js.matchAll(/["'`](\/(?:api|v\d+|rest|ajax|data|json|export|download|svc|services)\/[^"'`\s<>]*)["'`]/g)) add(m[1], 'literal', null);
  const all = [...found.values()];
  const known = new Set(all.filter((c) => c.method).map((c) => c.path));
  return all.filter((c) => c.method || !known.has(c.path)); // drop the "method unknown" duplicate of a path we do know
}

function cookieSummary(lines) {
  return lines.map((line) => {
    const [pair, ...attrs] = line.split(';').map((s) => s.trim());
    const flags = attrs.map((a) => a.toLowerCase()).filter((a) => /^(httponly|secure|samesite|path|max-age|expires|domain)/.test(a));
    return `${pair.split('=')[0]} [${flags.join('; ') || 'no flags'}]`;
  });
}

const pickHeaders = (h) => {
  const out = {};
  for (const [k, v] of h.entries()) if (/^(server|x-powered-by|content-type|cache-control|etag|last-modified|retry-after|www-authenticate|x-request-id|x-frame-options|x-ratelimit.*|ratelimit.*|content-security-policy|access-control-allow-origin|link)$/i.test(k)) out[k] = k.toLowerCase() === 'content-security-policy' ? '(present)' : v;
  return out;
};

export async function explore({ baseUrl, username, password, outDir = 'capture', maxPages = 40, delayMs = 400, perShape = 3, maxScripts = 15, maxProbes = 20, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log }) {
  if (!username || !password) throw new Error('Set PORTAL_USERNAME and PORTAL_PASSWORD');
  const origin = new URL(baseUrl).origin;
  const jar = new CookieJar();
  const redact = (s) => (password ? String(s).split(password).join('***') : String(s));
  const requests = []; // audit trail: every request this tool sent
  let nextAt = 0;

  async function send(method, url, { body, contentType } = {}) {
    if (method !== 'GET' && !(method === 'POST' && body !== undefined && contentType)) throw new Error(`refusing ${method} ${url}`);
    if (new URL(url).origin !== origin) throw new Error(`refusing cross-origin request to ${url}`);
    const wait = nextAt - Date.now();
    if (wait > 0) await sleep(wait);
    nextAt = Date.now() + delayMs;
    const t0 = Date.now();
    const cookie = jar.header();
    const res = await fetchImpl(url, { method, redirect: 'manual', headers: { 'user-agent': UA, accept: '*/*', ...(cookie ? { cookie } : {}), ...(contentType ? { 'content-type': contentType } : {}) }, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(20_000) });
    jar.store(res);
    requests.push(`${method} ${new URL(url).pathname}${new URL(url).search}`);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, ms: Date.now() - t0, setCookies: res.headers.getSetCookie?.() ?? [] };
  }

  /** GET with manual redirect following; returns the final response plus the chain. */
  async function getFollow(startUrl) {
    const chain = [];
    let url = startUrl;
    let cookies = [];
    for (let hop = 0; hop < 6; hop++) {
      const r = await send('GET', url);
      cookies = cookies.concat(r.setCookies);
      const loc = r.headers.get('location');
      chain.push(`${r.status} ${new URL(url).pathname}`);
      if (r.status >= 300 && r.status < 400 && loc) {
        url = new URL(loc, url).href;
        if (new URL(url).origin !== origin) return { ...r, url, chain: [...chain, `-> ${url} (other origin, not followed)`], setCookies: cookies };
        continue;
      }
      return { ...r, url, chain, setCookies: cookies };
    }
    throw new Error(`too many redirects from ${startUrl}`);
  }

  await fs.mkdir(path.join(outDir, 'pages'), { recursive: true });
  const report = { startedAt: new Date().toISOString(), baseUrl, login: null, pages: [], scripts: [], candidates: [], probes: [], skipped: [], exportLinks: [], paginationLinks: [], headerSamples: {} };

  // ---- 1. login ---------------------------------------------------------------------------------------------------
  const first = await getFollow(baseUrl);
  const $login = cheerio.load(first.text);
  const form = $login('form').filter((_, el) => $login(el).find('input[type=password]').length > 0).first();
  report.login = { landedOn: first.url, chain: first.chain, formFound: form.length > 0 };
  let landing = first;
  if (form.length) {
    const fields = [];
    const body = new URLSearchParams();
    let userSet = false;
    form.find('input, select, textarea').each((_, el) => {
      const name = $login(el).attr('name');
      const type = ($login(el).attr('type') || 'text').toLowerCase();
      if (!name) return;
      const info = { name, type };
      if (type === 'hidden') { body.set(name, $login(el).attr('value') ?? ''); info.note = `hidden, value sent back (${($login(el).attr('value') ?? '').length} chars, not shown)`; }
      else if (type === 'password') body.set(name, password);
      else if (['submit', 'button', 'image', 'reset', 'file'].includes(type)) return;
      else if ((type === 'checkbox' || type === 'radio') && $login(el).attr('checked') === undefined) return;
      else if (!userSet && (type === 'email' || /e?mail|user|login/i.test(name))) { body.set(name, username); userSet = true; info.note = 'username'; }
      fields.push(info);
    });
    const action = new URL(form.attr('action') || first.url, first.url).href;
    report.login.form = { action: new URL(action).pathname, method: (form.attr('method') || 'GET').toUpperCase(), enctype: form.attr('enctype') || 'application/x-www-form-urlencoded', fields, usernameFieldFound: userSet };
    if (userSet) {
      const post = await send('POST', action, { body: body.toString(), contentType: 'application/x-www-form-urlencoded' });
      report.login.postStatus = post.status;
      report.login.postCookies = cookieSummary(post.setCookies);
      report.login.postHeaders = pickHeaders(post.headers);
      const loc = post.headers.get('location');
      landing = loc ? await getFollow(new URL(loc, action).href) : { ...post, url: action, chain: [`${post.status} ${new URL(action).pathname}`] };
      const stillLogin = cheerio.load(landing.text)('input[type=password]').length > 0;
      report.login.ok = !stillLogin && landing.status < 400;
      report.login.afterLogin = { url: landing.url, chain: landing.chain };
      if (!report.login.ok) report.login.errorHint = cheerio.load(landing.text)('.error, .alert, .alert-danger, .flash, [role=alert]').first().text().trim().slice(0, 200);
    }
  }
  report.login.cookiesNow = jar.names();
  log(`login: ${report.login.ok ? 'ok' : report.login.formFound ? 'NOT accepted' : 'no login form found'}`);

  // ---- 2. crawl ---------------------------------------------------------------------------------------------------
  const queue = [landing.url];
  const seen = new Set();
  const shapes = new Map();
  const scriptUrls = new Set();
  const candidateMap = new Map();
  let n = 0;

  const consider = (href, from, text = '') => {
    let u;
    try { u = new URL(href, from); } catch { return; }
    if (!/^https?:$/.test(u.protocol) || u.origin !== origin) return;
    u.hash = '';
    const s = u.href;
    if (EXPORT_HINT.test(u.pathname + u.search + text) && !ASSET.test(u.pathname)) report.exportLinks.push({ url: u.pathname + u.search, text: text.trim().slice(0, 60), from: new URL(from).pathname });
    if (PAGINATION_HINT.test(u.search)) report.paginationLinks.push({ url: u.pathname + u.search, from: new URL(from).pathname });
    if (ASSET.test(u.pathname)) return;
    if (DENY.test(u.pathname + u.search)) { report.skipped.push({ url: u.pathname + u.search, reason: 'looks destructive (never followed)', from: new URL(from).pathname }); return; }
    if (!seen.has(s)) queue.push(s);
  };

  while (queue.length && n < maxPages) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    const shape = urlShape(url);
    if ((shapes.get(shape) ?? 0) >= perShape) continue;
    seen.add(url);
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
    const r = await getFollow(url);
    n += 1;
    const ct = r.headers.get('content-type') ?? '';
    const rec = { n, url: new URL(r.url).pathname + new URL(r.url).search, shape, status: r.status, contentType: ct.split(';')[0], bytes: r.text.length, ms: r.ms, chain: r.chain.length > 1 ? r.chain : undefined };
    if (n <= 3 || !report.headerSamples[rec.contentType]) report.headerSamples[rec.contentType] = pickHeaders(r.headers);
    const file = `${String(n).padStart(2, '0')}-${rec.url.replace(/[^a-z0-9]+/gi, '_').slice(0, 60)}.txt`;
    await fs.writeFile(path.join(outDir, 'pages', file), redact(`${r.status} ${rec.url}\n${JSON.stringify(pickHeaders(r.headers), null, 1)}\n\n${r.text.slice(0, MAX_BODY)}`));
    rec.file = `pages/${file}`;

    if (/html/i.test(ct)) {
      const $ = cheerio.load(r.text);
      rec.title = $('title').first().text().trim().slice(0, 80);
      rec.headings = $('h1, h2, h3').map((_, e) => $(e).text().trim().replace(/\s+/g, ' ').slice(0, 60)).get().slice(0, 8);
      const cell = (_, c) => $(c).text().trim().replace(/\s+/g, ' ').slice(0, 30);
      rec.tables = $('table').slice(0, 3).map((_, t) => {
        const headEls = $(t).find('thead th').length ? $(t).find('thead th') : $(t).find('tr').first().children();
        const rowEls = $(t).find('tbody tr').length ? $(t).find('tbody tr') : $(t).find('tr').slice(1);
        return { headers: headEls.map(cell).get(), rows: rowEls.slice(0, 2).map((_, tr) => [$(tr).children().map(cell).get()]).get(), rowCount: rowEls.length };
      }).get();
      rec.keyValues = $('dl').first().children('dt').slice(0, 12).map((_, dt) => `${$(dt).text().trim()}: ${$(dt).next('dd').text().trim().slice(0, 40)}`).get();
      rec.textSample = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 140);
      rec.forms = $('form').map((_, f) => ({ action: $(f).attr('action') || '(self)', method: ($(f).attr('method') || 'GET').toUpperCase(), fields: $(f).find('[name]').map((_, i) => $(i).attr('name')).get().slice(0, 12) })).get();
      rec.dataAttributes = [...new Set($('[data-url], [data-href], [data-endpoint], [data-src], [data-api]').map((_, e) => Object.entries(e.attribs).filter(([k]) => /^data-(url|href|endpoint|src|api)/.test(k)).map(([k, v]) => `${k}=${v}`).join(' ')).get())].slice(0, 8);
      rec.embeddedJson = $('script[type="application/json"], script[type="application/ld+json"]').length;
      rec.metaCsrf = $('meta[name*=csrf i], meta[name*=xsrf i]').map((_, m) => $(m).attr('name')).get();
      $('a[href]').each((_, a) => consider($(a).attr('href'), r.url, $(a).text()));
      $('iframe[src], link[rel=next][href]').each((_, e) => consider($(e).attr('src') || $(e).attr('href'), r.url));
      $('script[src]').each((_, s) => { try { const u = new URL($(s).attr('src'), r.url); if (u.origin === origin) scriptUrls.add(u.href); } catch { /* ignore */ } });
      $('script:not([src])').each((_, s) => { for (const c of endpointCandidates($(s).text())) candidateMap.set(`${c.method} ${c.path}`, { ...c, seenIn: rec.url }); });
    } else if (/json/i.test(ct)) {
      try { rec.jsonShape = describeJson(JSON.parse(r.text)); } catch { rec.jsonShape = '(invalid JSON)'; }
    } else {
      rec.head = r.text.slice(0, 160).replace(/\s+/g, ' ');
    }
    report.pages.push(rec);
    log(`[${n}] ${r.status} ${rec.url}`);
  }

  // ---- 3. scripts -> endpoint candidates --------------------------------------------------------------------------
  for (const s of [...scriptUrls].slice(0, maxScripts)) {
    if (DENY.test(s)) continue;
    const r = await getFollow(s);
    report.scripts.push({ url: new URL(s).pathname, status: r.status, bytes: r.text.length });
    if (r.status === 200) for (const c of endpointCandidates(r.text)) candidateMap.set(`${c.method} ${c.path}`, { ...c, seenIn: new URL(s).pathname });
  }
  report.candidates = [...candidateMap.values()];

  // ---- 4. probe the harmless-looking GET candidates (capped) -----------------------------------------------------
  const bare = (p) => p.split('?')[0];
  const mutating = new Set(report.candidates.filter((c) => c.method && c.method !== 'GET').map((c) => bare(c.path)));
  const probeable = report.candidates.filter((c) => (c.method === null || c.method === 'GET') && !mutating.has(bare(c.path)) && !/[{}$<>:%]/.test(c.path) && !DENY.test(c.path) && !DENY_PROBE.test(c.path));
  for (const c of probeable.slice(0, maxProbes)) {
    const u = new URL(c.path, baseUrl).href;
    if (seen.has(u)) continue;
    seen.add(u);
    const r = await getFollow(u);
    const ct = r.headers.get('content-type') ?? '';
    let shape = ct.split(';')[0];
    if (/json/i.test(ct)) { try { shape = describeJson(JSON.parse(r.text)); } catch { shape = 'invalid JSON'; } }
    const file = `probe-${report.probes.length + 1}-${c.path.replace(/[^a-z0-9]+/gi, '_').slice(0, 50)}.txt`;
    await fs.writeFile(path.join(outDir, 'pages', file), redact(`${r.status} ${c.path}\n\n${r.text.slice(0, MAX_BODY)}`));
    report.probes.push({ path: c.path, status: r.status, contentType: ct.split(';')[0], shape, bytes: r.text.length, file: `pages/${file}` });
    log(`probe ${r.status} ${c.path}`);
  }
  report.notProbed = report.candidates.filter((c) => !((c.method === null || c.method === 'GET') && report.probes.some((p) => p.path === c.path)));

  // ---- 5. write the report ----------------------------------------------------------------------------------------
  report.requestAudit = { total: requests.length, nonGet: requests.filter((r) => !r.startsWith('GET ')), paths: requests };
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(outDir, 'capture.json'), redact(JSON.stringify(report, null, 2)));
  await fs.writeFile(path.join(outDir, 'SUMMARY.md'), redact(renderSummary(report)));
  log(`done: ${n} pages, ${report.scripts.length} scripts, ${report.probes.length} probes -> ${path.join(outDir, 'SUMMARY.md')}`);
  return report;
}

function renderSummary(r) {
  const L = [];
  const h = (t) => L.push('', `## ${t}`, '');
  L.push(`# Portal exploration report`, '', `Base: ${r.baseUrl}  |  ${r.startedAt} -> ${r.finishedAt}`, `Requests sent: ${r.requestAudit.total}. Non-GET requests: ${r.requestAudit.nonGet.length ? r.requestAudit.nonGet.join(', ') : 'none'}.`);
  h('Login');
  const lg = r.login;
  L.push(`- Landing page for "/": ${lg.landedOn} (${lg.chain.join(' -> ')})`, `- Login form found: ${lg.formFound}`);
  if (lg.form) L.push(`- Form: ${lg.form.method} ${lg.form.action} (${lg.form.enctype})`, `- Fields: ${lg.form.fields.map((f) => `${f.name}[${f.type}${f.note ? `: ${f.note}` : ''}]`).join(', ')}`);
  if (lg.postStatus !== undefined) L.push(`- POST answered ${lg.postStatus}; cookies set: ${lg.postCookies.join(', ') || 'none'}`, `- Result: ${lg.ok ? 'LOGGED IN' : `NOT accepted${lg.errorHint ? ` (${lg.errorHint})` : ''}`}; after login: ${lg.afterLogin?.chain.join(' -> ')}`);
  L.push(`- Cookies held now: ${lg.cookiesNow.join(', ') || 'none'}`);
  h('Response headers (first sample per content type)');
  for (const [ct, hd] of Object.entries(r.headerSamples)) L.push(`- ${ct || '(none)'}: ${Object.entries(hd).map(([k, v]) => `${k}: ${v}`).join(' | ')}`);
  h('Pages visited');
  L.push('| # | status | type | URL | title / shape | bytes | ms |', '|---|---|---|---|---|---|---|');
  for (const p of r.pages) L.push(`| ${p.n} | ${p.status} | ${p.contentType} | ${p.url} | ${(p.title || p.jsonShape || p.head || '').slice(0, 70).replace(/\|/g, '/')} | ${p.bytes} | ${p.ms} |`);
  h('What each distinct page type contains');
  const done = new Set();
  for (const p of r.pages) {
    if (done.has(p.shape)) continue;
    done.add(p.shape);
    L.push(`### ${p.shape}  (${p.url}, raw: ${p.file})`);
    if (p.headings?.length) L.push(`- Headings: ${p.headings.join(' / ')}`);
    for (const t of p.tables ?? []) L.push(`- Table (${t.rowCount} rows): ${t.headers.join(' | ')}`, ...t.rows.map((row) => `  - e.g. ${row.join(' | ')}`));
    if (p.keyValues?.length) L.push(`- Key/value list: ${p.keyValues.join(' | ')}`);
    if (!p.tables?.length && !p.headings?.length && !p.keyValues?.length && p.textSample) L.push(`- Text: ${p.textSample}`);
    for (const f of p.forms ?? []) L.push(`- Form: ${f.method} ${f.action} fields: ${f.fields.join(', ')}`);
    if (p.dataAttributes?.length) L.push(`- data-* URL hints: ${p.dataAttributes.join('; ')}`);
    if (p.embeddedJson) L.push(`- Embedded JSON blocks: ${p.embeddedJson}`);
    if (p.metaCsrf?.length) L.push(`- CSRF meta tags: ${p.metaCsrf.join(', ')}`);
    if (p.jsonShape) L.push(`- JSON: ${p.jsonShape}`);
    L.push('');
  }
  h('Endpoints mentioned in the portal JavaScript');
  L.push(`Scripts read: ${r.scripts.map((s) => `${s.url} (${s.status}, ${s.bytes}B)`).join(', ') || 'none'}`, '');
  if (r.probes.length) L.push('Fetched with GET (harmless-looking only):', ...r.probes.map((p) => `- ${p.status} ${p.path} -> ${p.contentType}: ${p.shape.slice(0, 300)}  (raw: ${p.file})`), '');
  if (r.notProbed.length) L.push('Found but NOT fetched (mutating verb, placeholder, or risky name; review by hand):', ...r.notProbed.map((c) => `- ${c.method ?? '?'} ${c.path}  (via ${c.via}, in ${c.seenIn})`), '');
  h('Bulk / export / pagination hints');
  const uniq = (xs, f) => [...new Map(xs.map((x) => [f(x), x])).values()];
  L.push(...(r.exportLinks.length ? uniq(r.exportLinks, (x) => x.url).map((x) => `- export-looking link: ${x.url} ("${x.text}", on ${x.from})`) : ['- no export-looking links found']));
  L.push(...(r.paginationLinks.length ? uniq(r.paginationLinks, (x) => x.url).slice(0, 8).map((x) => `- pagination link: ${x.url} (on ${x.from})`) : ['- no pagination links found']));
  h('Links deliberately NOT followed');
  L.push(...(r.skipped.length ? uniq(r.skipped, (x) => x.url).map((x) => `- ${x.url} (${x.reason}; on ${x.from})`) : ['- none']));
  return `${L.join('\n')}\n`;
}

async function main() {
  const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
  await explore({
    baseUrl: arg('base', process.env.PORTAL_BASE_URL || 'https://urja-ops.flockenergy.tech'),
    username: process.env.PORTAL_USERNAME,
    password: process.env.PORTAL_PASSWORD,
    outDir: arg('out', 'capture'),
    maxPages: Number(arg('max-pages', 40)),
    delayMs: Number(arg('delay-ms', 400)),
    perShape: Number(arg('per-shape', 3)),
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(`explore failed: ${e.message}`); process.exit(1); });
