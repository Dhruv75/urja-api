import * as cheerio from 'cheerio';
import { CookieJar } from './cookieJar.js';
import { PortalAuthError, PortalError, PortalHttpError, PortalUnavailableError } from '../errors.js';

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_REDIRECTS = 5;
const USER_AGENT = 'urja-api/0.1 (read-only integration client)';

/**
 * Cookie-session HTTP client for the legacy portal. Portal-agnostic mechanics only:
 *
 *  - READ-ONLY BY CONSTRUCTION: the only public verbs are GETs. (The single POST is the login form.)
 *  - Logs in through the HTML login form (CSRF/hidden fields are echoed back).
 *  - Session expiry (401, or a redirect to the login page) => log in again ONCE and replay the request.
 *    Concurrent requests share a single login (single-flight).
 *  - After a failed login it refuses to try again for `loginCooldownMs` (avoids account lock-outs).
 *  - Transient failures (network error, timeout, 408/425/429/500/502/503/504) are retried with exponential
 *    backoff + jitter, honouring Retry-After.
 *  - Politeness: bounded concurrency and a minimum gap between request starts.
 *  - Never follows a redirect to another origin.
 */
export class PortalSession {
  #loginPromise = null;
  #loginFailure = null;
  #active = 0;
  #waiters = [];
  #nextStart = 0;

  constructor(cfg, { log, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
    this.cfg = cfg;
    this.log = log;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.now = now;
    this.origin = new URL(cfg.baseUrl).origin;
    this.jar = new CookieJar(now);
    this.loggedInAt = null;
    this.generation = 0; // bumped on every successful login; lets late-arriving failures tell the session was already renewed
    this.stats = { requests: 0, retries: 0, logins: 0, relogins: 0, loginFailures: 0 };
  }

  state() {
    return {
      mode: 'portal',
      baseUrl: this.cfg.baseUrl,
      authenticated: this.jar.size > 0 && this.loggedInAt !== null,
      loggedInAt: this.loggedInAt ? new Date(this.loggedInAt).toISOString() : null,
      cookieNames: this.jar.names(),
      lastLoginError: this.#loginFailure?.error.message ?? null,
      ...this.stats,
    };
  }

  // ---- public read-only API -------------------------------------------------------------------

  /** GET a path; returns { status, headers, text, url }. Non-2xx (other than session/transient errors) is returned, not thrown. */
  async get(path, query) {
    const url = this.#url(path, query);
    await this.ensureLoggedIn();
    for (let attempt = 0; ; attempt++) {
      const sentGeneration = this.generation;
      const res = await this.#withRetry(url);
      if (!res.sessionExpired) return res;
      if (attempt >= 1) throw new PortalAuthError(`Portal rejected the session again right after a fresh login (${path})`);
      // Only the first request to notice the expiry tears the session down; requests that were in flight
      // while somebody else already logged in again just replay with the new cookies.
      if (this.generation === sentGeneration) {
        this.log?.warn('portal session expired; logging in again', { path, status: res.status });
        this.stats.relogins += 1;
        this.jar.clear();
        this.loggedInAt = null;
      }
      await this.ensureLoggedIn();
    }
  }

  async getText(path, query) {
    const res = await this.get(path, query);
    if (res.status < 200 || res.status >= 300) throw new PortalHttpError(`Portal answered ${res.status} for ${path}`, res.status);
    return res.text;
  }

  async getJson(path, query) {
    const text = await this.getText(path, query);
    try {
      return JSON.parse(text);
    } catch {
      throw new PortalUnavailableError(`Portal returned non-JSON for ${path}: ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
    }
  }

  async getHtml(path, query) {
    return cheerio.load(await this.getText(path, query));
  }

  async ensureLoggedIn() {
    if (this.jar.size > 0 && this.loggedInAt !== null) return;
    if (this.#loginFailure && this.now() - this.#loginFailure.at < this.cfg.loginCooldownMs) throw this.#loginFailure.error;
    this.#loginPromise ??= this.#login().finally(() => {
      this.#loginPromise = null;
    });
    return this.#loginPromise;
  }

  // ---- login ----------------------------------------------------------------------------------

  async #login() {
    const { username, password, loginPath, baseUrl } = this.cfg;
    try {
      if (!username || !password) throw new PortalAuthError('PORTAL_USERNAME and PORTAL_PASSWORD must be set');
      this.jar.clear();
      const loginUrl = new URL(loginPath, baseUrl).href;
      const page = await this.#withRetry(loginUrl, { skipAuthCheck: true });
      if (page.status !== 200) throw new PortalUnavailableError(`Login page answered ${page.status}`);
      const $ = cheerio.load(page.text);
      const form = $('form').filter((_, el) => $(el).find('input[type=password]').length > 0).first();
      if (!form.length) throw new PortalAuthError(`No login form (a form with a password field) found at ${loginUrl}`);

      const body = new URLSearchParams();
      let userField = null;
      form.find('input, textarea, select').each((_, el) => {
        const name = $(el).attr('name');
        const type = ($(el).attr('type') || 'text').toLowerCase();
        if (!name || ['submit', 'button', 'image', 'file', 'reset'].includes(type)) return;
        if (type === 'password') body.set(name, password);
        else if (type === 'hidden') body.set(name, $(el).attr('value') ?? '');
        else if (type === 'checkbox' || type === 'radio') {
          if ($(el).attr('checked') !== undefined) body.set(name, $(el).attr('value') ?? 'on');
        } else if (!userField && (type === 'email' || /e?mail|user|login/i.test(name))) {
          userField = name;
          body.set(name, username);
        }
      });
      if (!userField) throw new PortalAuthError('Could not identify the username/email field in the login form');

      const action = new URL(form.attr('action') || loginUrl, loginUrl);
      if (action.origin !== this.origin) throw new PortalAuthError('Login form posts to a different origin; refusing');
      const landing = await this.#postLogin(action.href, body);
      const looksLikeLogin = this.#isLoginUrl(new URL(landing.url)) || /<input[^>]+type=["']?password/i.test(landing.text);
      if (landing.sessionExpired || looksLikeLogin || this.jar.size === 0) {
        const hint = cheerio.load(landing.text)('.error, .alert, .alert-danger, .flash, [role=alert]').first().text().trim().slice(0, 160);
        throw new PortalAuthError(`Login was not accepted${hint ? `: ${hint}` : ''}`);
      }
      this.loggedInAt = this.now();
      this.generation += 1;
      this.#loginFailure = null;
      this.stats.logins += 1;
      this.log?.info('portal login ok', { cookies: this.jar.names() });
    } catch (err) {
      this.stats.loginFailures += 1;
      const error = err instanceof PortalError ? err : new PortalUnavailableError(`Login failed: ${err.message}`, { cause: err });
      this.#loginFailure = { at: this.now(), error };
      throw error;
    }
  }

  /** The one and only non-GET request: submitting the login form. */
  async #postLogin(url, body) {
    const release = await this.#slot();
    let res;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: { ...this.#headers(), 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
      this.jar.store(res);
    } finally {
      release();
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.arrayBuffer().catch(() => {});
      return this.#roundTrip(new URL(location, url).href);
    }
    return { status: res.status, headers: res.headers, text: await res.text(), url };
  }

  // ---- request plumbing -----------------------------------------------------------------------

  #url(path, query) {
    const u = new URL(path, this.cfg.baseUrl);
    if (u.origin !== this.origin) throw new PortalError(`Refusing to request another origin: ${u.origin}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    return u.href;
  }

  #headers() {
    const cookie = this.jar.header();
    return { 'user-agent': USER_AGENT, accept: '*/*', ...(cookie ? { cookie } : {}) };
  }

  #isLoginUrl(u) {
    const strip = (p) => p.replace(/\/+$/, '');
    return strip(u.pathname) === strip(new URL(this.cfg.loginPath, this.cfg.baseUrl).pathname);
  }

  async #slot() {
    if (this.#active >= this.cfg.maxConcurrency) await new Promise((resolve) => this.#waiters.push(resolve));
    this.#active += 1;
    const startAt = Math.max(this.now(), this.#nextStart);
    this.#nextStart = startAt + this.cfg.minIntervalMs;
    if (startAt > this.now()) await this.sleep(startAt - this.now());
    return () => {
      this.#active -= 1;
      this.#waiters.shift()?.();
    };
  }

  /** One logical GET: follows same-origin redirects by hand so a bounce to /login is noticed. */
  async #roundTrip(startUrl, { skipAuthCheck = false } = {}) {
    let url = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await this.fetch(url, { method: 'GET', redirect: 'manual', headers: this.#headers(), signal: AbortSignal.timeout(this.cfg.timeoutMs) });
      this.jar.store(res);
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.arrayBuffer().catch(() => {});
        const next = new URL(location, url);
        if (next.origin !== this.origin) throw new PortalUnavailableError(`Refusing redirect to another origin (${next.origin})`);
        if (!skipAuthCheck && this.#isLoginUrl(next)) return { status: 401, headers: res.headers, text: '', url: next.href, sessionExpired: true };
        url = next.href;
        continue;
      }
      const text = await res.text();
      return { status: res.status, headers: res.headers, text, url, sessionExpired: !skipAuthCheck && res.status === 401 };
    }
    throw new PortalUnavailableError('Too many redirects');
  }

  async #withRetry(url, opts) {
    for (let attempt = 0; ; attempt++) {
      const release = await this.#slot();
      let res = null;
      let error = null;
      try {
        res = await this.#roundTrip(url, opts);
        this.stats.requests += 1;
      } catch (err) {
        error = err;
      } finally {
        release();
      }
      if (error instanceof PortalError) throw error; // deterministic problem, retrying won't help
      if (res && !RETRYABLE.has(res.status)) return res;
      if (attempt >= this.cfg.maxRetries) {
        if (error) throw new PortalUnavailableError(`Portal unreachable after ${attempt + 1} attempts: ${error.cause?.code ?? error.message}`, { cause: error });
        throw new PortalUnavailableError(`Portal kept answering ${res.status} after ${attempt + 1} attempts`);
      }
      const delay = this.#backoff(attempt, res?.headers.get('retry-after'));
      this.stats.retries += 1;
      this.log?.warn('portal request failed; retrying', { attempt: attempt + 1, status: res?.status, error: error?.message, delayMs: delay });
      await this.sleep(delay);
    }
  }

  #backoff(attempt, retryAfter) {
    const exp = Math.min(5000, 300 * 2 ** attempt);
    const jittered = exp * (0.75 + Math.random() * 0.5);
    let hinted = 0;
    if (retryAfter) {
      const secs = Number(retryAfter);
      hinted = Number.isFinite(secs) ? secs * 1000 : Math.max(0, Date.parse(retryAfter) - this.now()) || 0;
    }
    return Math.round(Math.max(jittered, Math.min(hinted, 30_000)));
  }
}
